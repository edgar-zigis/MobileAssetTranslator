import { describe, expect, it } from 'vitest';
import type { Entry } from '../core/entry.model.js';
import { chunkItems } from './chunker.js';
import { buildWorkItem, copyAsIs, needsModel } from './work-item.js';

const str = (key: string, value: string, section?: string): Entry => ({
  kind: 'string',
  key,
  value,
  translatable: true,
  ...(section ? { section } : {}),
});

describe('buildWorkItem', () => {
  it('masks placeholders with positions and only sends keys that add context', () => {
    expect(buildWorkItem(str('greet', '%@ sent %d photos')).payload).toEqual({ key: 'greet', text: '{{0}} sent {{1}} photos' });
    expect(buildWorkItem(str('OK', 'OK')).payload).toEqual({ text: 'OK' });
    const item = buildWorkItem(str('greet', '%@ sent %d photos'));
    expect(item.tokens.raws).toEqual(['%1$@', '%2$d']);
  });

  it('shares one token map across plural forms', () => {
    const item = buildWorkItem({ kind: 'plural', key: 'f', translatable: true, forms: { one: '%d file', other: '%d files' } });
    expect(item.payload).toEqual({ key: 'f', forms: { one: '{{0}} file', other: '{{0}} files' } });
  });

  it('skips entries with nothing to translate', () => {
    expect(needsModel(buildWorkItem(str('a', '%@ / %@')))).toBe(false);
    expect(needsModel(buildWorkItem(str('b', '')))).toBe(false);
    expect(needsModel(buildWorkItem(str('c', 'Save')))).toBe(true);
  });

  it('copies untranslatable plurals into the target categories', () => {
    const entry: Entry = { kind: 'plural', key: 'n', translatable: true, forms: { one: '%d', other: '%d' } };
    expect(copyAsIs(entry, ['one', 'few', 'many', 'other'])).toEqual({
      kind: 'plural',
      forms: { one: '%d', few: '%d', many: '%d', other: '%d' },
    });
  });
});

describe('chunkItems', () => {
  const items = (n: number, text = 'Hello world') => Array.from({ length: n }, (_, i) => buildWorkItem(str(`k${i}`, text)));

  it('respects the entry limit without splitting entries', () => {
    const chunks = chunkItems(items(130), { maxEntries: 60, maxChars: 1e9 });
    expect(chunks.map((c) => c.length)).toEqual([60, 60, 10]);
    expect(chunks.flat().map((i) => i.entry.key)).toEqual(items(130).map((i) => i.entry.key));
  });

  it('respects the character limit', () => {
    const all = items(20, 'x'.repeat(100));
    const size = all[0]!.size;
    const chunks = chunkItems(all, { maxEntries: 100, maxChars: size * 5 });
    expect(chunks.every((c) => c.reduce((s, i) => s + i.size, 0) <= size * 5)).toBe(true);
    expect(chunks.flat()).toHaveLength(20);
  });

  it('gives an oversized entry its own chunk', () => {
    const all = [buildWorkItem(str('a', 'short')), buildWorkItem(str('b', 'y'.repeat(5000))), buildWorkItem(str('c', 'short'))];
    const chunks = chunkItems(all, { maxEntries: 60, maxChars: 1000 });
    expect(chunks.map((c) => c.map((i) => i.entry.key))).toEqual([['a'], ['b'], ['c']]);
  });

  it('ends a mostly full chunk where a new section starts', () => {
    const entries = Array.from({ length: 12 }, (_, i) => buildWorkItem(str(`k${i}`, 'Text', i === 8 ? 'Settings' : undefined)));
    const chunks = chunkItems(entries, { maxEntries: 10, maxChars: 1e9 });
    expect(chunks.map((c) => c.length)).toEqual([8, 4]);
  });

  it('ignores sections while a chunk is still small', () => {
    const entries = Array.from({ length: 12 }, (_, i) => buildWorkItem(str(`k${i}`, 'Text', i === 3 ? 'Settings' : undefined)));
    const chunks = chunkItems(entries, { maxEntries: 10, maxChars: 1e9 });
    expect(chunks.map((c) => c.length)).toEqual([10, 2]);
  });
});
