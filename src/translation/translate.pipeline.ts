import { Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import { loadGlossary } from '../config/glossary.js';
import { withContent, type Entry, type EntryContent, type PluralCategory, type ResourceDocument } from '../core/entry.model.js';
import { normalizeLocale, pluralCategories } from '../core/locale.js';
import { androidNames } from '../formats/android/android.format.js';
import { FormatsService } from '../formats/formats.service.js';
import { OutputService, type LanguageFiles } from '../output/output.service.js';
import { hashEntry, StateStore } from '../output/state.store.js';
import type { ProgressSink } from '../progress/progress.reporter.js';
import { chunkItems, type ChunkLimits } from './chunker.js';
import { AbortedError, LlmClient, type LlmUsage } from './llm-client.js';
import type { PromptContext } from './prompt.builder.js';
import { TranslationService } from './translation.service.js';
import { buildWorkItem, copyAsIs, needsModel, type WorkItem } from './work-item.js';

export interface RunOptions {
  input: string;
  from: string;
  to: string[];
  out: string;
  context?: string;
  glossary?: string;
  force: boolean;
  dryRun: boolean;
  concurrency: number;
  limits: ChunkLimits;
}

export interface LanguageResult {
  lang: string;
  /** Entries that needed the model. */
  toTranslate: number;
  chunks: number;
  translated: number;
  /** Kept from existing output files or a previous interrupted run. */
  reused: number;
  /** Nothing to translate (empty, or only placeholders/numbers). */
  copied: number;
  failed: Map<string, string>;
  files: string[];
  usage: LlmUsage;
  complete: boolean;
}

export interface RunResult {
  document: ResourceDocument;
  sourceFiles: string[];
  languages: LanguageResult[];
  cancelled: boolean;
  fatal?: Error;
}

interface LanguagePlan {
  lang: string;
  files: LanguageFiles;
  plurals: PluralCategory[];
  resolved: Map<string, EntryContent>;
  hashes: Record<string, string>;
  chunks: WorkItem[][];
  remaining: number;
  finalized: boolean;
  result: LanguageResult;
}

@Injectable()
export class TranslatePipeline {
  constructor(
    private readonly formats: FormatsService,
    private readonly output: OutputService,
    private readonly translation: TranslationService,
    private readonly llm: LlmClient,
  ) {}

  async run(opts: RunOptions, progress: ProgressSink, signal: AbortSignal): Promise<RunResult> {
    const doc = await this.formats.readSource(opts.input);
    for (const w of doc.warnings) progress.warn(w);
    if (!doc.entries.length) throw new Error(`No strings found in ${opts.input}.`);

    const from = normalizeLocale(opts.from);
    const targets = [...new Set(opts.to.map(normalizeLocale))].filter((t) => {
      if (t === from) progress.warn(`Skipping ${t}: it is the source language.`);
      return t !== from;
    });
    if (!targets.length) throw new Error('No target languages to translate into.');
    const glossary = opts.glossary ? await loadGlossary(opts.glossary) : undefined;
    const names = androidNames(doc.entries, doc.platform);
    const renamed = doc.platform === 'ios' ? doc.entries.filter((e) => names.get(e.key) !== e.key).length : 0;
    const sourceName = `${doc.baseName}.${doc.platform === 'ios' ? 'strings' : 'xml'}`;
    const state = await StateStore.load(opts.out, sourceName);

    progress.info(describeSource(doc, sourceName, from));
    if (renamed) progress.info(`        ${renamed} iOS keys were turned into valid Android resource names.`);
    if (!opts.dryRun) {
      this.llm.ensureReady();
      progress.info(`Model   ${this.llm.description} · concurrency ${opts.concurrency}`);
    }
    progress.info(`Output  ${opts.out}`);
    progress.info('');

    const plans: LanguagePlan[] = [];
    for (const lang of targets) {
      plans.push(await this.plan(doc, lang, names, state, opts.out, opts, progress));
    }

    if (opts.dryRun) {
      for (const p of plans) {
        const r = p.result;
        progress.info(
          `${p.lang.padEnd(8)}${r.toTranslate} to translate in ${r.chunks} ${r.chunks === 1 ? 'chunk' : 'chunks'} · ${r.reused} kept · ${r.copied} copied`,
        );
      }
      return { document: doc, sourceFiles: [], languages: plans.map((p) => p.result), cancelled: false };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) controller.abort();
    let fatal: Error | undefined;
    let sourceFiles: string[] = [];

    const finalize = async (plan: LanguagePlan) => {
      if (plan.finalized) return;
      plan.finalized = true;
      await this.finalize(plan, doc, names, state);
      const r = plan.result;
      const note = r.complete
        ? r.toTranslate
          ? `done · ${r.translated} translated`
          : 'up to date'
        : `stopped · ${r.translated}/${r.toTranslate} translated`;
      progress.languageDone(plan.lang, r.failed.size ? `${note} · ${r.failed.size} failed` : note, r.complete && !r.failed.size);
    };

    for (const p of plans) progress.addLanguage(p.lang, p.result.toTranslate, p.chunks.length);

    try {
      for (const p of plans.filter((p) => p.remaining === 0)) await finalize(p);

      const jobs = plans.flatMap((plan) =>
        plan.chunks.map((chunk, index) => async () => {
          if (controller.signal.aborted) return;
          const ctx: PromptContext = {
            source: from,
            target: plan.lang,
            targetPlurals: plan.plurals,
            appContext: opts.context,
            glossary,
          };
          try {
            const res = await this.translation.translateChunk(chunk, ctx, {
              signal: controller.signal,
              onNotice: (m) => progress.notice(plan.lang, `chunk ${index + 1}/${plan.chunks.length}: ${m}`),
              onAccepted: (n) => progress.advance(plan.lang, n),
            });
            for (const [key, content] of res.translated) {
              plan.resolved.set(key, content);
              state.addPending(plan.lang, key, plan.hashes[key]!, content);
            }
            for (const [key, reason] of res.failed) {
              plan.result.failed.set(key, reason);
              progress.notice(plan.lang, `"${key}" was not translated: ${reason}`);
            }
            if (res.failed.size) progress.advance(plan.lang, res.failed.size);
            plan.result.translated += res.translated.size;
            plan.result.usage.inputTokens += res.usage.inputTokens;
            plan.result.usage.outputTokens += res.usage.outputTokens;
            await state.save();
            plan.remaining--;
            progress.chunkDone(plan.lang);
            if (plan.remaining === 0) {
              plan.result.complete = true;
              await finalize(plan);
            }
          } catch (e) {
            if (e instanceof AbortedError || controller.signal.aborted) return;
            fatal ??= e as Error;
            controller.abort();
          }
        }),
      );
      await runPool(jobs, opts.concurrency);

      // Interrupted or failed: keep whatever was translated so the next run continues from there.
      for (const p of plans) {
        if (!p.finalized && p.result.translated > 0) await finalize(p);
      }
      await state.save();
      if (!fatal) sourceFiles = await this.writeSourceLanguage(doc, from, names, opts.out);
    } finally {
      signal.removeEventListener('abort', onAbort);
      progress.stop();
    }

    return {
      document: doc,
      sourceFiles,
      languages: plans.map((p) => p.result),
      cancelled: signal.aborted,
      fatal,
    };
  }

  private async plan(
    doc: ResourceDocument,
    lang: string,
    names: Map<string, string>,
    state: StateStore,
    out: string,
    opts: RunOptions,
    progress: ProgressSink,
  ): Promise<LanguagePlan> {
    const plurals = pluralCategories(lang);
    const files = this.output.files(doc, out, lang);
    const existing = opts.force
      ? undefined
      : await this.output.loadExisting(files, names, (m) => progress.warn(m));
    const result: LanguageResult = {
      lang,
      toTranslate: 0,
      chunks: 0,
      translated: 0,
      reused: 0,
      copied: 0,
      failed: new Map(),
      files: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      complete: false,
    };
    const resolved = new Map<string, EntryContent>();
    const hashes: Record<string, string> = {};
    const work: WorkItem[] = [];

    for (const entry of doc.entries) {
      if (!entry.translatable) continue;
      const hash = hashEntry(entry);
      hashes[entry.key] = hash;
      if (existing) {
        const stored = state.storedHash(lang, entry.key);
        const found = existing.lookup(entry, plurals);
        if (found && (stored === undefined || stored === hash)) {
          resolved.set(entry.key, found);
          result.reused++;
          continue;
        }
        const resumed = state.pending(lang, entry.key, hash);
        if (resumed) {
          resolved.set(entry.key, resumed);
          result.reused++;
          continue;
        }
      }
      const item = buildWorkItem(entry);
      if (!needsModel(item)) {
        resolved.set(entry.key, copyAsIs(entry, plurals));
        result.copied++;
        continue;
      }
      work.push(item);
    }

    const chunks = chunkItems(work, opts.limits);
    result.toTranslate = work.length;
    result.chunks = chunks.length;
    result.complete = work.length === 0;
    return { lang, files, plurals, resolved, hashes, chunks, remaining: chunks.length, finalized: false, result };
  }

  private async finalize(plan: LanguagePlan, doc: ResourceDocument, names: Map<string, string>, state: StateStore): Promise<void> {
    const entries: Entry[] = [];
    const written: Record<string, string> = {};
    for (const entry of doc.entries) {
      if (!entry.translatable) {
        entries.push(entry);
        continue;
      }
      const content = plan.resolved.get(entry.key);
      if (!content) continue;
      entries.push(withContent(entry, content));
      written[entry.key] = plan.hashes[entry.key]!;
    }
    plan.result.files = await this.output.write(plan.files, entries, {
      names,
      rootAttrs: doc.androidRootAttrs,
      includeNonTranslatable: false,
      platforms: ['ios', 'android'],
    });
    state.commit(plan.lang, written);
    await state.save();
  }

  /** The source language in the other platform's format (no API calls). */
  private async writeSourceLanguage(doc: ResourceDocument, from: string, names: Map<string, string>, out: string): Promise<string[]> {
    const toAndroid = doc.platform === 'ios';
    return this.output.write(this.output.files(doc, out, from, toAndroid), doc.entries, {
      names,
      rootAttrs: doc.androidRootAttrs,
      includeNonTranslatable: true,
      platforms: [toAndroid ? 'android' : 'ios'],
    });
  }
}

function describeSource(doc: ResourceDocument, name: string, from: string): string {
  const count = (kind: Entry['kind']) => doc.entries.filter((e) => e.kind === kind).length;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const parts = [n(count('string'), 'string')];
  if (count('plural')) parts.push(n(count('plural'), 'plural'));
  if (count('array')) parts.push(n(count('array'), 'array'));
  const fixed = doc.entries.filter((e) => !e.translatable).length;
  if (fixed) parts.push(`${fixed} not translatable`);
  return `Source  ${basename(name)} (${doc.platform === 'ios' ? 'iOS' : 'Android'}, ${from}) · ${parts.join(' · ')}`;
}

/** Runs jobs with at most `concurrency` in flight. Jobs handle their own errors. */
export async function runPool(jobs: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
}
