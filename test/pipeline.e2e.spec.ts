import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FormatsService } from '../src/formats/formats.service.js';
import { OutputService } from '../src/output/output.service.js';
import type { ProgressSink } from '../src/progress/progress.reporter.js';
import { AbortedError, LlmClient, type LlmCallOptions, type LlmRequest, type LlmResponse } from '../src/translation/llm-client.js';
import { TranslatePipeline, type RunOptions } from '../src/translation/translate.pipeline.js';
import { TranslationService } from '../src/translation/translation.service.js';

type Item = { id: string; key?: string; text?: string; forms?: Record<string, string>; items?: string[] };

/** Fake model: "translates" by upper-casing words and prefixing the language, keeping tokens. */
class FakeLlm extends LlmClient {
  readonly description = 'fake';
  calls: { lang: string; items: Item[] }[] = [];
  /** Called before answering; may throw or mutate the answer. */
  hook?: (call: number, items: Item[], answer: { translations: Item[] }, opts: LlmCallOptions) => void;

  ensureReady(): void {}

  async generate(request: LlmRequest, opts: LlmCallOptions = {}): Promise<LlmResponse> {
    if (opts.signal?.aborted) throw new AbortedError();
    const lang = /to [^(]+\(([^)]+)\)/.exec(request.system)![1]!;
    const categories = /categories: ([a-z, ]+)\./.exec(request.system)![1]!.split(', ');
    const items = JSON.parse(request.prompt) as Item[];
    this.calls.push({ lang, items });
    const t = (s: string) => (s === '' ? '' : `[${lang}] ${s.replace(/\p{Ll}+/gu, (w) => w.toUpperCase())}`);
    const answer = {
      translations: items.map((i) => ({
        id: i.id,
        ...(i.text !== undefined ? { text: t(i.text) } : {}),
        ...(i.forms ? { forms: Object.fromEntries(categories.map((c) => [c, t(i.forms![c] ?? i.forms!.other!)])) } : {}),
        ...(i.items ? { items: i.items.map(t) } : {}),
      })),
    };
    this.hook?.(this.calls.length, items, answer, opts);
    return { text: JSON.stringify(answer), usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

const silent: ProgressSink = {
  info() {},
  warn() {},
  notice() {},
  addLanguage() {},
  advance() {},
  chunkDone() {},
  languageDone() {},
  stop() {},
};

const fixtures = join(import.meta.dirname, 'fixtures');

describe('translate pipeline (end to end with a fake model)', () => {
  let work: string;
  let out: string;
  let llm: FakeLlm;
  let pipeline: TranslatePipeline;

  const run = (overrides: Partial<RunOptions> = {}, signal = new AbortController().signal) =>
    pipeline.run(
      {
        input: join(work, 'ios/en.lproj/Localizable.strings'),
        from: 'en',
        to: ['de', 'lt'],
        out,
        force: false,
        dryRun: false,
        concurrency: 2,
        limits: { maxEntries: 60, maxChars: 6000 },
        ...overrides,
      },
      silent,
      signal,
    );

  const read = (rel: string) => readFileSync(join(out, rel), 'utf8');

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'mat-work-'));
    out = join(work, 'output');
    cpSync(fixtures, work, { recursive: true });
    llm = new FakeLlm();
    const formats = new FormatsService();
    pipeline = new TranslatePipeline(formats, new OutputService(formats), new TranslationService(llm), llm);
  });

  it('writes iOS and Android files for every target, plus the source language for Android', async () => {
    const result = await run();
    expect(result.fatal).toBeUndefined();
    expect(result.languages.map((l) => [l.lang, l.translated, l.copied, l.failed.size])).toEqual([
      ['de', 11, 2, 0],
      ['lt', 11, 2, 0],
    ]);
    for (const f of [
      'ios/de.lproj/Localizable.strings',
      'ios/de.lproj/Localizable.stringsdict',
      'ios/lt.lproj/Localizable.strings',
      'android/values-de/strings.xml',
      'android/values-lt/strings.xml',
      'android/values/strings.xml',
    ]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }

    const ios = read('ios/de.lproj/Localizable.strings');
    expect(ios).toContain('"home.summary" = "[de] %1$@ SENT YOU %2$d PHOTOS";');
    expect(ios).toContain('"empty" = "";');
    expect(ios).toContain('/* Title of the login button */');

    const android = read('android/values-de/strings.xml');
    expect(android).toContain('<string name="home_summary">[de] %1$s SENT YOU %2$d PHOTOS</string>');
    expect(android).toContain('<string name="settings_delete_confirm">[de] ARE YOU SURE YOU WANT TO DELETE YOUR ACCOUNT? THIS CAN\\\'T BE UNDONE.</string>');
    expect(android).toContain('<item quantity="other">[de] %d FILES</item>');

    const ltDict = read('ios/lt.lproj/Localizable.stringsdict');
    for (const c of ['one', 'few', 'many', 'other']) expect(ltDict).toContain(`<key>${c}</key>`);
    expect(read('android/values/strings.xml')).toContain('<string name="login_button">Log in</string>');

    if (process.platform === 'darwin') {
      execFileSync('plutil', ['-lint', join(out, 'ios/de.lproj/Localizable.strings'), join(out, 'ios/lt.lproj/Localizable.stringsdict')]);
      execFileSync('xmllint', ['--noout', join(out, 'android/values-de/strings.xml'), join(out, 'android/values/strings.xml')]);
    }
  });

  it('makes no API calls when nothing changed', async () => {
    await run();
    llm.calls = [];
    const again = await run();
    expect(llm.calls).toHaveLength(0);
    // 11 translated + 2 copied entries are all read back from the output files.
    expect(again.languages.map((l) => l.reused)).toEqual([13, 13]);
  });

  it('translates only keys whose source text changed', async () => {
    await run();
    const src = join(work, 'ios/en.lproj/Localizable.strings');
    writeFileSync(src, readFileSync(src, 'utf8').replace('"Log out"', '"Sign out"'));
    llm.calls = [];
    await run({ to: ['de'] });
    expect(llm.calls.map((c) => c.items.map((i) => i.text))).toEqual([['Sign out']]);
    expect(read('ios/de.lproj/Localizable.strings')).toContain('"settings.logout" = "[de] SIGN OUT";');
  });

  it('keeps manual edits to output files', async () => {
    await run({ to: ['de'] });
    const file = join(out, 'android/values-de/strings.xml');
    await new Promise((r) => setTimeout(r, 20)); // make the edited file clearly newer
    writeFileSync(file, readFileSync(file, 'utf8').replace('[de] LOG IN', 'Anmelden'));
    llm.calls = [];
    await run({ to: ['de'] });
    expect(llm.calls).toHaveLength(0);
    expect(read('ios/de.lproj/Localizable.strings')).toContain('"login.button" = "Anmelden";');
    expect(read('android/values-de/strings.xml')).toContain('<string name="login_button">Anmelden</string>');
  });

  it('translates everything again with --force', async () => {
    await run({ to: ['de'] });
    llm.calls = [];
    const again = await run({ to: ['de'], force: true });
    expect(again.languages[0]!.translated).toBe(11);
  });

  it('leaves out entries that keep failing and retries them on the next run', async () => {
    llm.hook = (_call, items, answer) => {
      const i = items.findIndex((x) => x.text?.includes('{{0}}') && x.text.startsWith('Welcome'));
      if (i >= 0) answer.translations[i]!.text = 'broken';
    };
    const first = await run({ to: ['de'] });
    expect([...first.languages[0]!.failed.keys()]).toEqual(['home.greeting']);
    expect(read('ios/de.lproj/Localizable.strings')).not.toContain('home.greeting');

    llm.hook = undefined;
    llm.calls = [];
    await run({ to: ['de'] });
    expect(llm.calls.flatMap((c) => c.items.map((i) => i.text))).toEqual(['Welcome back, {{0}}!']);
  });

  it('saves finished chunks when stopped, and continues from there', async () => {
    const controller = new AbortController();
    llm.hook = (call) => {
      if (call === 2) controller.abort();
    };
    const first = await run({ to: ['de'], concurrency: 1, limits: { maxEntries: 3, maxChars: 6000 } }, controller.signal);
    expect(first.cancelled).toBe(true);
    // The answer to call 2 arrived as Ctrl+C was pressed, so chunks 1 and 2 are kept.
    const done = first.languages[0]!.translated;
    expect(done).toBe(6);
    // 6 translated strings + 2 copied ones ("empty", "only.placeholders").
    expect(read('ios/de.lproj/Localizable.strings').match(/" = "/g)).toHaveLength(8);

    llm.hook = undefined;
    llm.calls = [];
    const second = await run({ to: ['de'], limits: { maxEntries: 3, maxChars: 6000 } });
    expect(second.languages[0]!.translated).toBe(11 - done);
    expect(llm.calls.flatMap((c) => c.items)).toHaveLength(11 - done);
  });

  it('works from an Android source too', async () => {
    const result = await run({ input: join(work, 'android/values/strings.xml'), to: ['de'] });
    expect(result.languages[0]!.failed.size).toBe(0);
    const android = read('android/values-de/strings.xml');
    expect(android).not.toContain('app_name'); // translatable="false" stays in values/ only
    expect(android).toContain('<string name="html_cdata"><![CDATA[');
    expect(android).toContain('<item>[de] MONDAY</item>');
    const ios = read('ios/de.lproj/Localizable.strings');
    expect(ios).toContain('"weekdays_0" = "[de] MONDAY";');
    expect(ios).toContain('"home_greeting" = "[de] WELCOME BACK, <b>%1$@</b>!";');
    expect(read('ios/en.lproj/Localizable.strings')).toContain('"app_name" = "Sample";');
  });
});
