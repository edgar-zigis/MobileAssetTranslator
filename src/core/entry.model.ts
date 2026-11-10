/**
 * Format-neutral model. Every parser produces it and every writer renders from it,
 * which is what lets either input format produce both output formats.
 *
 * Text values are "canonical": unescaped plain text in which
 *  - printf placeholders use iOS spelling for objects (`%@`, never `%s`/`%S` from Android),
 *  - inline markup (`<b>`, `<xliff:g …>…</xliff:g>`) is kept as literal tags,
 *  - literal `<`, `&` etc. are plain characters (writers escape them).
 */

export type Platform = 'ios' | 'android';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export const PLURAL_CATEGORIES: readonly PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

export type PluralForms = Partial<Record<PluralCategory, string>>;

interface BaseEntry {
  key: string;
  /** Developer comment placed directly above the entry. */
  comment?: string;
  /** Section comment (e.g. `MARK: Settings`) that starts a group of entries. */
  section?: string;
  translatable: boolean;
  /** Android-only details that are carried through unchanged. */
  android?: {
    cdata?: boolean;
    /** Extra attributes on the element, e.g. `formatted="false"`. */
    attrs?: Record<string, string>;
  };
  /** iOS `.stringsdict` details carried through unchanged. */
  stringsdict?: {
    variable?: string;
    valueType?: string;
  };
}

export interface StringEntry extends BaseEntry {
  kind: 'string';
  value: string;
}

export interface PluralEntry extends BaseEntry {
  kind: 'plural';
  forms: PluralForms;
}

export interface ArrayEntry extends BaseEntry {
  kind: 'array';
  items: string[];
}

export type Entry = StringEntry | PluralEntry | ArrayEntry;

/** The translated content of an entry, without its metadata. */
export type EntryContent =
  | { kind: 'string'; value: string }
  | { kind: 'plural'; forms: PluralForms }
  | { kind: 'array'; items: string[] };

export interface ResourceDocument {
  platform: Platform;
  /** File name without extension, e.g. `Localizable` or `strings`. */
  baseName: string;
  entries: Entry[];
  warnings: string[];
  /** Attributes on the Android `<resources>` root, e.g. `xmlns:xliff`. */
  androidRootAttrs?: Record<string, string>;
}

export function contentOf(entry: Entry): EntryContent {
  switch (entry.kind) {
    case 'string':
      return { kind: 'string', value: entry.value };
    case 'plural':
      return { kind: 'plural', forms: { ...entry.forms } };
    case 'array':
      return { kind: 'array', items: [...entry.items] };
  }
}

/** Returns a copy of `entry` whose content is replaced by `content` (same kind required). */
export function withContent(entry: Entry, content: EntryContent): Entry {
  if (entry.kind !== content.kind) {
    throw new Error(`Cannot apply ${content.kind} content to ${entry.kind} entry "${entry.key}"`);
  }
  switch (content.kind) {
    case 'string':
      return { ...entry, kind: 'string', value: content.value } as StringEntry;
    case 'plural':
      return { ...entry, kind: 'plural', forms: content.forms } as PluralEntry;
    case 'array':
      return { ...entry, kind: 'array', items: content.items } as ArrayEntry;
  }
}

/** All text values of an entry, in a stable order. */
export function textsOf(content: EntryContent): string[] {
  switch (content.kind) {
    case 'string':
      return [content.value];
    case 'plural':
      return PLURAL_CATEGORIES.flatMap((c) => (content.forms[c] !== undefined ? [content.forms[c]!] : []));
    case 'array':
      return content.items;
  }
}
