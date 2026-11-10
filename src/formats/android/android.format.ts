import { XMLParser } from 'fast-xml-parser';
import {
  PLURAL_CATEGORIES,
  type Entry,
  type Platform,
  type PluralCategory,
  type PluralForms,
  type ResourceDocument,
} from '../../core/entry.model.js';
import { decodeAndroidValue, encodeAndroidValue } from './android-text.js';

export class AndroidFormatError extends Error {}

type Node = Record<string, unknown> & { ':@'?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  commentPropName: '#comment',
  stopNodes: ['*.string', '*.item'],
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

const OWN_ATTRS = new Set(['name', 'translatable']);

/** Parses an Android `strings.xml`. */
export function readAndroidDocument(xml: string, baseName: string): ResourceDocument {
  let tree: Node[];
  try {
    tree = parser.parse(xml) as Node[];
  } catch (e) {
    throw new AndroidFormatError(`Invalid XML: ${(e as Error).message}`);
  }
  const root = tree.find((n) => 'resources' in n);
  if (!root) throw new AndroidFormatError('Not an Android resource file: the root element must be <resources>.');

  const entries: Entry[] = [];
  const index = new Map<string, number>();
  const warnings: string[] = [];
  const skipped = new Set<string>();
  let pending: { text: string; detached: boolean }[] = [];

  const add = (entry: Entry) => {
    const attached: string[] = [];
    let i = pending.length;
    while (i > 0 && !pending[i - 1]!.detached) attached.unshift(pending[--i]!.text);
    if (attached.length) entry.comment = attached.join('\n');
    if (i > 0) entry.section = pending[i - 1]!.text;
    pending = [];
    const at = index.get(entry.key);
    if (at !== undefined) {
      warnings.push(`Duplicate name "${entry.key}"; the last one is used.`);
      entries[at] = { ...entry, comment: entry.comment ?? entries[at]!.comment, section: entries[at]!.section };
    } else {
      index.set(entry.key, entries.length);
      entries.push(entry);
    }
  };

  for (const node of root.resources as Node[]) {
    if ('#text' in node) {
      const blankLines = ((node['#text'] as string).match(/\n/g) ?? []).length >= 2;
      const last = pending[pending.length - 1];
      if (blankLines && last) last.detached = true;
      continue;
    }
    if ('#comment' in node) {
      const text = textOf(node['#comment'] as Node[])
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
        .trim();
      if (text) pending.push({ text, detached: false });
      continue;
    }
    const tag = Object.keys(node).find((k) => k !== ':@')!;
    const attrs = decodeAttrs(node[':@']);
    const name = attrs.name;
    if (!name || !['string', 'plurals', 'string-array'].includes(tag)) {
      skipped.add(`<${tag}>`);
      pending = [];
      continue;
    }
    const translatable = attrs.translatable !== 'false';
    const extra = Object.fromEntries(Object.entries(attrs).filter(([k]) => !OWN_ATTRS.has(k)));
    const children = node[tag] as Node[];

    if (tag === 'string') {
      const { text, cdata } = decodeAndroidValue(textOf(children));
      add({ kind: 'string', key: name, value: text, translatable, android: androidMeta(cdata, extra) });
    } else if (tag === 'plurals') {
      const forms: PluralForms = {};
      let cdata = false;
      for (const item of children.filter((c) => 'item' in c)) {
        const quantity = decodeAttrs(item[':@']).quantity as PluralCategory | undefined;
        if (!quantity || !PLURAL_CATEGORIES.includes(quantity)) {
          warnings.push(`<plurals name="${name}"> has an item with an unknown quantity; it was ignored.`);
          continue;
        }
        const decoded = decodeAndroidValue(textOf(item.item as Node[]));
        forms[quantity] = decoded.text;
        cdata ||= decoded.cdata;
      }
      if (!forms.other) warnings.push(`<plurals name="${name}"> has no "other" item.`);
      add({ kind: 'plural', key: name, forms, translatable, android: androidMeta(cdata, extra) });
    } else {
      let cdata = false;
      const items = children
        .filter((c) => 'item' in c)
        .map((item) => {
          const decoded = decodeAndroidValue(textOf(item.item as Node[]));
          cdata ||= decoded.cdata;
          return decoded.text;
        });
      add({ kind: 'array', key: name, items, translatable, android: androidMeta(cdata, extra) });
    }
  }
  if (skipped.size) warnings.push(`Skipped non-string resources: ${[...skipped].join(', ')}.`);

  return { platform: 'android', baseName, entries, warnings, androidRootAttrs: decodeAttrs(root[':@']) };
}

function decodeAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([k, v]) => [
      k,
      v.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) =>
        e.startsWith('#x')
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : e.startsWith('#')
            ? String.fromCodePoint(parseInt(e.slice(1), 10))
            : (named[e] ?? m),
      ),
    ]),
  );
}

function androidMeta(cdata: boolean, attrs: Record<string, string>): Entry['android'] {
  const meta: NonNullable<Entry['android']> = {};
  if (cdata) meta.cdata = true;
  if (Object.keys(attrs).length) meta.attrs = attrs;
  return Object.keys(meta).length ? meta : undefined;
}

function textOf(nodes: Node[] | undefined): string {
  return (nodes ?? []).map((n) => (typeof n['#text'] === 'string' ? n['#text'] : '')).join('');
}

const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'.split(
    ' ',
  ),
);

/**
 * Android resource name for every key. Android keys are kept; iOS keys such as
 * `login.button` or `Are you sure?` become valid names (`login_button`, `Are_you_sure_`).
 */
export function androidNames(entries: Entry[], sourcePlatform: Platform): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const { key } of entries) {
    let name = key;
    if (sourcePlatform === 'ios') {
      name = key.replace(/[^A-Za-z0-9_]/g, '_');
      if (!/^[A-Za-z]/.test(name)) name = `s_${name}`;
      if (JAVA_KEYWORDS.has(name)) name = `${name}_`;
      const base = name;
      for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    }
    used.add(name);
    names.set(key, name);
  }
  return names;
}

export interface AndroidRenderOptions {
  names: Map<string, string>;
  rootAttrs?: Record<string, string>;
  /** Source-language files keep `translatable="false"` entries; translated files leave them out. */
  includeNonTranslatable: boolean;
}

const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:1.2';

export function renderAndroid(entries: Entry[], opts: AndroidRenderOptions): string {
  const body: string[] = [];
  for (const entry of entries) {
    if (!entry.translatable && !opts.includeNonTranslatable) continue;
    const name = opts.names.get(entry.key) ?? entry.key;
    const lines: string[] = [];
    if (entry.section) lines.push(`    <!-- ${commentText(entry.section)} -->`, '');
    if (entry.comment) lines.push(`    <!-- ${commentText(entry.comment)} -->`);
    const attrs = attributes({
      name,
      ...(entry.translatable ? {} : { translatable: 'false' }),
      ...(entry.android?.attrs ?? {}),
    });
    const cdata = entry.android?.cdata ?? false;
    if (entry.kind === 'string') {
      lines.push(`    <string${attrs}>${encodeAndroidValue(entry.value, cdata)}</string>`);
    } else if (entry.kind === 'plural') {
      lines.push(`    <plurals${attrs}>`);
      for (const category of PLURAL_CATEGORIES) {
        const form = entry.forms[category];
        if (form !== undefined) lines.push(`        <item quantity="${category}">${encodeAndroidValue(form, cdata)}</item>`);
      }
      lines.push('    </plurals>');
    } else {
      lines.push(`    <string-array${attrs}>`);
      for (const item of entry.items) lines.push(`        <item>${encodeAndroidValue(item, cdata)}</item>`);
      lines.push('    </string-array>');
    }
    body.push(lines.join('\n'));
  }
  const rootAttrs = { ...(opts.rootAttrs ?? {}) };
  if (body.some((b) => b.includes('<xliff:g')) && !rootAttrs['xmlns:xliff']) rootAttrs['xmlns:xliff'] = XLIFF_NS;
  const usesTools = entries.some((e) => Object.keys(e.android?.attrs ?? {}).some((a) => a.startsWith('tools:')));
  if (usesTools && !rootAttrs['xmlns:tools']) rootAttrs['xmlns:tools'] = 'http://schemas.android.com/tools';

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<resources${attributes(rootAttrs)}>`,
    ...(body.length ? [body.join('\n')] : []),
    '</resources>',
    '',
  ].join('\n');
}

function attributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"`)
    .join('');
}

function commentText(text: string): string {
  return text.replace(/--/g, '- -').replace(/\n/g, '\n         ');
}
