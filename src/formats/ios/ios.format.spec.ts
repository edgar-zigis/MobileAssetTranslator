import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluralEntry, StringEntry } from '../../core/entry.model.js';
import { readIosDocument, renderIos } from './ios.format.js';
import { parseStrings } from './strings.parser.js';
import { parseStringsdict } from './stringsdict.js';

const fixtures = join(import.meta.dirname, '../../../test/fixtures/ios/en.lproj');
const stringsFile = readFileSync(join(fixtures, 'Localizable.strings'));
const stringsdictFile = readFileSync(join(fixtures, 'Localizable.stringsdict'));

describe('iOS .strings parser', () => {
  const doc = readIosDocument(stringsFile, stringsdictFile, 'Localizable');
  const byKey = new Map(doc.entries.map((e) => [e.key, e]));

  it('reads entries, escapes and unquoted keys', () => {
    expect((byKey.get('login.button') as StringEntry).value).toBe('Log in');
    expect((byKey.get('quote') as StringEntry).value).toBe('She said "hi"\nand left.');
    expect((byKey.get('legacy_unquoted') as StringEntry).value).toBe('Unquoted key');
    expect((byKey.get('empty') as StringEntry).value).toBe('');
  });

  it('attaches comments and section markers', () => {
    expect(byKey.get('login.button')!.comment).toBe('Title of the login button');
    expect(byKey.get('login.button')!.section).toBe('MARK: - Login');
    expect(byKey.get('home.summary')!.comment).toBeUndefined();
    expect(byKey.get('settings.logout')!.section).toBe('MARK: - Settings');
  });

  it('folds stringsdict text around the variable into each form', () => {
    expect((byKey.get('files.count') as PluralEntry).forms).toEqual({ one: '%ld file', other: '%ld files' });
    expect((byKey.get('selected.count') as PluralEntry).forms).toEqual({
      one: '%d item selected',
      other: '%d items selected',
    });
  });

  it('reads UTF-16 files', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"a" = "Ä";', 'utf16le')]);
    const parsed = readIosDocument(utf16, undefined, 'Localizable');
    expect((parsed.entries[0] as StringEntry).value).toBe('Ä');
  });

  it('reports syntax errors with a line number', () => {
    expect(() => parseStrings('"a" = "b";\n"c" "d";')).toThrow(/line 2/);
  });

  it('warns on duplicate keys and keeps the last value', () => {
    const parsed = parseStrings('"a" = "1";\n"a" = "2";');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.value).toBe('2');
    expect(parsed.warnings[0]).toMatch(/Duplicate key "a"/);
  });
});

describe('iOS writers', () => {
  const doc = readIosDocument(stringsFile, stringsdictFile, 'Localizable');
  const files = renderIos(doc.entries);

  it('round-trips through the parser', () => {
    const again = readIosDocument(Buffer.from(files.strings), Buffer.from(files.stringsdict!), 'Localizable');
    const values = (d: typeof doc) => d.entries.map((e) => [e.key, e.kind === 'string' ? e.value : e.kind === 'plural' ? e.forms : e.items]);
    const expected = values(doc).map(([k, v]) => (k === 'home.summary' ? [k, '%1$@ sent you %2$d photos'] : k === 'only.placeholders' ? [k, '%1$@ / %2$@'] : [k, v]));
    expect(values(again)).toEqual(expected);
    expect(again.entries.find((e) => e.key === 'login.button')!.comment).toBe('Title of the login button');
  });

  it('writes stringsdict format keys that point at the count argument', () => {
    const plurals: PluralEntry[] = [
      { kind: 'plural', key: 'p', translatable: true, forms: { one: '%1$@ has %2$d file', other: '%1$@ has %2$d files' } },
    ];
    const xml = renderIos(plurals).stringsdict!;
    expect(xml).toContain('<string>%2$#@count@</string>');
    const parsed = parseStringsdict(Buffer.from(xml));
    expect(parsed.entries[0]!.forms.other).toBe('%1$@ has %2$d files');
  });

  it('writes array items as numbered keys and drops xliff wrappers', () => {
    const out = renderIos([
      { kind: 'array', key: 'days', translatable: true, items: ['Mon', 'Tue'] },
      { kind: 'string', key: 'n', translatable: true, value: 'Got <xliff:g id="c">%d</xliff:g> new' },
    ]).strings;
    expect(out).toBe('"days_0" = "Mon";\n"days_1" = "Tue";\n\n"n" = "Got %d new";\n');
  });

  it.skipIf(process.platform !== 'darwin')('produces files that plutil accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ios-'));
    writeFileSync(join(dir, 'a.strings'), files.strings);
    writeFileSync(join(dir, 'a.stringsdict'), files.stringsdict!);
    expect(() => execFileSync('plutil', ['-lint', join(dir, 'a.strings'), join(dir, 'a.stringsdict')])).not.toThrow();
  });
});
