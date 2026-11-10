import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry, PluralEntry, StringEntry } from '../../core/entry.model.js';
import { decodeAndroidValue, encodeAndroidValue } from './android-text.js';
import { AndroidFormatError, androidNames, readAndroidDocument, renderAndroid } from './android.format.js';

const xml = readFileSync(join(import.meta.dirname, '../../../test/fixtures/android/values/strings.xml'), 'utf8');

describe('Android parser', () => {
  const doc = readAndroidDocument(xml, 'strings');
  const value = (key: string) => (doc.entries.find((e) => e.key === key) as StringEntry).value;

  it('decodes escapes, entities, quotes and whitespace like aapt2', () => {
    expect(value('apostrophe')).toBe("You're all set & ready");
    expect(value('quoted')).toBe('  Spaces are kept  ');
    expect(value('collapsed')).toBe('This text wraps over lines');
    expect(value('escapes')).toBe('Line one\nLine "two" @home');
    expect(value('empty')).toBe('');
  });

  it('converts placeholders to canonical spelling and keeps markup', () => {
    expect(value('home_greeting')).toBe('Welcome back, <b>%1$@</b>!');
    expect(value('home_summary')).toBe('%1$@ sent you %2$d photos');
    expect(value('xliff')).toBe('Expires in <xliff:g id="days" example="3">%d</xliff:g> days');
  });

  it('keeps CDATA content literal and remembers it', () => {
    const entry = doc.entries.find((e) => e.key === 'html_cdata')!;
    // aapt2 still treats unescaped double quotes inside CDATA as quoting, so they disappear at runtime.
    expect((entry as StringEntry).value).toBe('Read our <a href=https://example.com>terms</a>');
    expect(entry.android?.cdata).toBe(true);
  });

  it('reads flags, comments, plurals and arrays', () => {
    const byKey = new Map(doc.entries.map((e) => [e.key, e]));
    expect(byKey.get('app_name')!.translatable).toBe(false);
    expect(byKey.get('percent')!.android?.attrs).toEqual({ formatted: 'false' });
    expect(byKey.get('login_button')!.comment).toBe('Title of the login button');
    expect(byKey.get('login_button')!.section).toBe('Login');
    expect(byKey.get('files_count')!.section).toBe('Settings');
    expect((byKey.get('files_count') as PluralEntry).forms).toEqual({ one: '%d file', other: '%d files' });
    expect(byKey.get('weekdays')).toMatchObject({ kind: 'array', items: ['Monday', 'Tuesday'] });
    expect(byKey.has('brand')).toBe(false);
    expect(doc.warnings.join()).toMatch(/<color>/);
  });

  it('rejects files that are not resources', () => {
    expect(() => readAndroidDocument('<manifest/>', 'x')).toThrow(AndroidFormatError);
  });
});

describe('Android writer', () => {
  const doc = readAndroidDocument(xml, 'strings');
  const names = androidNames(doc.entries, 'android');
  const out = renderAndroid(doc.entries, { names, rootAttrs: doc.androidRootAttrs, includeNonTranslatable: true });

  it('round-trips through the parser', () => {
    const again = readAndroidDocument(out, 'strings');
    const strip = (entries: Entry[]) => entries.map(({ key, kind, ...rest }) => ({ key, kind, ...rest }));
    expect(strip(again.entries)).toEqual(strip(doc.entries));
  });

  it('escapes special characters and protects spacing', () => {
    expect(encodeAndroidValue("It's <b>%@</b> & 1 < 2")).toBe("It\\'s <b>%s</b> &amp; 1 &lt; 2");
    expect(encodeAndroidValue('@home')).toBe('\\@home');
    expect(encodeAndroidValue(' padded ')).toBe('" padded "');
    expect(encodeAndroidValue('%@ and %@')).toBe('%1$s and %2$s');
    expect(encodeAndroidValue('<b>x</b> & y', true)).toBe('<![CDATA[<b>x</b> & y]]>');
    expect(decodeAndroidValue(encodeAndroidValue('a\tb\nc "d" \\e')).text).toBe('a\tb\nc "d" \\e');
  });

  it('leaves non-translatable entries out of translated files', () => {
    const translated = renderAndroid(doc.entries, { names, includeNonTranslatable: false });
    expect(translated).not.toContain('app_name');
    expect(translated).toContain('xmlns:xliff=');
  });

  it('turns iOS keys into valid, unique resource names', () => {
    const entries: Entry[] = ['login.button', 'login_button', 'Are you sure?', '2fa.title', 'default'].map((key) => ({
      kind: 'string',
      key,
      value: '',
      translatable: true,
    }));
    expect([...androidNames(entries, 'ios').values()]).toEqual([
      'login_button',
      'login_button_2',
      'Are_you_sure_',
      's_2fa_title',
      'default_',
    ]);
  });

  it.skipIf(!hasXmllint())('produces well-formed XML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'android-'));
    writeFileSync(join(dir, 'strings.xml'), out);
    expect(() => execFileSync('xmllint', ['--noout', join(dir, 'strings.xml')])).not.toThrow();
  });
});

function hasXmllint(): boolean {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
