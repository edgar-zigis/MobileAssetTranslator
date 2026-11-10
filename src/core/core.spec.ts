import { describe, expect, it } from 'vitest';
import { androidValuesDir, iosLprojName, languageName, normalizeLocale, pluralCategories } from './locale.js';
import {
  ensurePositional,
  findPlaceholders,
  fromAndroidPlaceholders,
  toAndroidPlaceholders,
} from './placeholders.js';
import { hasTranslatableText, TokenMap, tokenMultiset, UnknownTokenError } from './tokens.js';

describe('placeholders', () => {
  it('finds iOS, Android and stringsdict specifiers', () => {
    const raws = findPlaceholders('%@ %1$@ %ld %.2f %5d %% %#@files@ %2$s').map((p) => p.raw);
    expect(raws).toEqual(['%@', '%1$@', '%ld', '%.2f', '%5d', '%%', '%#@files@', '%2$s']);
  });

  it('does not treat "50% off" as a placeholder', () => {
    expect(findPlaceholders('50% off today')).toEqual([]);
  });

  it('adds positions only when there are two or more arguments', () => {
    expect(ensurePositional('Hello %@')).toBe('Hello %@');
    expect(ensurePositional('%@ sent %d photos (100%%)')).toBe('%1$@ sent %2$d photos (100%%)');
    expect(ensurePositional('%2$@ before %1$@')).toBe('%2$@ before %1$@');
    expect(ensurePositional('%1$@ has %d files')).toBe('%1$@ has %2$d files');
  });

  it('converts between Android and canonical spelling', () => {
    expect(fromAndroidPlaceholders('%1$s has %2$d items, %S')).toBe('%1$@ has %2$d items, %@');
    expect(toAndroidPlaceholders('%1$@ has %2$ld items, %lu, %.1f, %%')).toBe('%1$s has %2$d items, %d, %.1f, %%');
  });
});

describe('tokens', () => {
  it('masks placeholders and markup, and restores them', () => {
    const map = new TokenMap();
    const masked = map.mask('Hi <b>%1$@</b>, you have %2$d new <xliff:g id="n">%3$d</xliff:g> 100%%');
    expect(masked).toBe('Hi {{0}}{{1}}{{2}}, you have {{3}} new {{4}} 100{{5}}');
    expect(map.unmask('{{5}} {{3}} {{0}}{{1}}{{2}} {{4}}')).toBe('%% %2$d <b>%1$@</b> <xliff:g id="n">%3$d</xliff:g>');
  });

  it('shares tokens across texts of one entry', () => {
    const map = new TokenMap();
    expect(map.mask('%d file')).toBe('{{0}} file');
    expect(map.mask('%d files')).toBe('{{0}} files');
  });

  it('rejects unknown tokens and tolerates spaces inside braces', () => {
    const map = new TokenMap();
    map.mask('%@');
    expect(map.unmask('x {{ 0 }}')).toBe('x %@');
    expect(() => map.unmask('{{7}}')).toThrow(UnknownTokenError);
  });

  it('builds multisets and spots strings with nothing to translate', () => {
    expect(tokenMultiset('{{1}} a {{0}} {{1}}')).toEqual(['{{0}}', '{{1}}', '{{1}}']);
    expect(hasTranslatableText('{{0}} / {{1}} 123')).toBe(false);
    expect(hasTranslatableText('{{0}} files')).toBe(true);
  });

  it('does not treat a comparison as markup', () => {
    expect(new TokenMap().mask('if x<y and y>z')).toBe('if x<y and y>z');
  });
});

describe('locale', () => {
  it('normalizes codes', () => {
    expect(normalizeLocale('pt_br')).toBe('pt-BR');
    expect(normalizeLocale('zh-hans')).toBe('zh-Hans');
    expect(() => normalizeLocale('not a code')).toThrow(RangeError);
  });

  it('maps to iOS and Android folders', () => {
    expect(iosLprojName('de')).toBe('de.lproj');
    expect(iosLprojName('pt-br')).toBe('pt-BR.lproj');
    expect(androidValuesDir('de')).toBe('values-de');
    expect(androidValuesDir('pt-BR')).toBe('values-pt-rBR');
    expect(androidValuesDir('zh-Hans')).toBe('values-b+zh+Hans');
    expect(androidValuesDir('es-419')).toBe('values-b+es+419');
  });

  it('knows language names and plural categories', () => {
    expect(languageName('de')).toBe('German');
    expect(pluralCategories('en')).toEqual(['one', 'other']);
    expect(pluralCategories('lt')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategories('ja')).toEqual(['other']);
  });
});
