import { PLURAL_CATEGORIES, type Entry, type EntryContent, type PluralCategory, type PluralForms } from '../core/entry.model.js';
import { ensurePositional } from '../core/placeholders.js';
import { hasTranslatableText, TokenMap } from '../core/tokens.js';

/** What the model sees for one entry (before an id is assigned). */
export type PromptItem = { key?: string; note?: string } & (
  | { text: string }
  | { forms: PluralForms }
  | { items: string[] }
);

/** One entry prepared for translation: masked text plus the map to restore it. */
export interface WorkItem {
  entry: Entry;
  tokens: TokenMap;
  payload: PromptItem;
  /** Approximate size in characters, used for chunk budgets. */
  size: number;
}

export function buildWorkItem(entry: Entry): WorkItem {
  const tokens = new TokenMap();
  const mask = (text: string) => tokens.mask(ensurePositional(text));
  const note = entry.comment ? { note: entry.comment } : {};
  let payload: PromptItem;
  switch (entry.kind) {
    case 'string':
      payload = { ...(entry.key !== entry.value ? { key: entry.key } : {}), ...note, text: mask(entry.value) };
      break;
    case 'plural': {
      const forms: PluralForms = {};
      for (const c of PLURAL_CATEGORIES) if (entry.forms[c] !== undefined) forms[c] = mask(entry.forms[c]!);
      payload = { key: entry.key, ...note, forms };
      break;
    }
    case 'array':
      payload = { key: entry.key, ...note, items: entry.items.map(mask) };
      break;
  }
  return { entry, tokens, payload, size: JSON.stringify(payload).length };
}

/** False when every text is empty or only placeholders, digits and punctuation. */
export function needsModel(item: WorkItem): boolean {
  const p = item.payload;
  const texts = 'text' in p ? [p.text] : 'forms' in p ? Object.values(p.forms) : p.items;
  return texts.some((t) => t !== undefined && hasTranslatableText(t));
}

/** Content for an entry that has nothing to translate, shaped for the target's plural categories. */
export function copyAsIs(entry: Entry, targetCategories: PluralCategory[]): EntryContent {
  switch (entry.kind) {
    case 'string':
      return { kind: 'string', value: entry.value };
    case 'array':
      return { kind: 'array', items: [...entry.items] };
    case 'plural': {
      const fallback = entry.forms.other ?? Object.values(entry.forms)[0] ?? '';
      const forms: PluralForms = {};
      for (const c of targetCategories) forms[c] = entry.forms[c] ?? fallback;
      return { kind: 'plural', forms };
    }
  }
}
