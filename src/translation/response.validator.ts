import { z } from 'zod';
import { PLURAL_CATEGORIES, type EntryContent, type PluralCategory, type PluralForms } from '../core/entry.model.js';
import { tokenMultiset, UnknownTokenError } from '../core/tokens.js';
import type { WorkItem } from './work-item.js';

const TranslationSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  text: z.string().optional(),
  forms: z.record(z.string(), z.string()).optional(),
  items: z.array(z.string()).optional(),
});

const ResponseSchema = z.object({ translations: z.array(TranslationSchema) });

export type RawTranslation = z.infer<typeof TranslationSchema>;

export class ResponseFormatError extends Error {}

/** Parses the model's JSON answer into translations keyed by id. */
export function parseModelResponse(text: string): Map<string, RawTranslation> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new ResponseFormatError('the response was not valid JSON');
  }
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new ResponseFormatError('the response did not match the expected shape');
  const byId = new Map<string, RawTranslation>();
  for (const t of parsed.data.translations) byId.set(t.id, t);
  return byId;
}

export type CheckResult = { ok: true; content: EntryContent } | { ok: false; reason: string };

/** Checks one translation against its source and restores placeholders and markup. */
export function checkTranslation(item: WorkItem, raw: RawTranslation | undefined, targetPlurals: PluralCategory[]): CheckResult {
  if (!raw) return fail('missing from the response');
  const p = item.payload;
  try {
    if ('text' in p) {
      if (raw.text === undefined) return fail('no "text" returned');
      if (p.text.trim() !== '' && raw.text.trim() === '') return fail('empty translation');
      if (!sameTokens(p.text, raw.text)) return fail('placeholders or markup changed');
      return { ok: true, content: { kind: 'string', value: item.tokens.unmask(raw.text) } };
    }
    if ('forms' in p) {
      if (!raw.forms) return fail('no "forms" returned');
      const reference = p.forms.other ?? Object.values(p.forms).at(-1) ?? '';
      const required = new Set(tokenMultiset(reference));
      const forms: PluralForms = {};
      for (const category of targetPlurals) {
        const form = raw.forms[category];
        if (form === undefined || form.trim() === '') return fail(`plural form "${category}" missing`);
        const tokens = new Set(tokenMultiset(form));
        if ([...required].some((t) => !tokens.has(t))) return fail(`plural form "${category}" lost a placeholder`);
        forms[category] = item.tokens.unmask(form);
      }
      return { ok: true, content: { kind: 'plural', forms: orderForms(forms) } };
    }
    if (!raw.items) return fail('no "items" returned');
    if (raw.items.length !== p.items.length) return fail(`expected ${p.items.length} items, got ${raw.items.length}`);
    for (let i = 0; i < p.items.length; i++) {
      if (!sameTokens(p.items[i]!, raw.items[i]!)) return fail(`item ${i + 1}: placeholders or markup changed`);
    }
    return { ok: true, content: { kind: 'array', items: raw.items.map((t) => item.tokens.unmask(t)) } };
  } catch (e) {
    if (e instanceof UnknownTokenError) return fail(`unknown token ${e.message}`);
    throw e;
  }
}

function sameTokens(source: string, translated: string): boolean {
  const a = tokenMultiset(source);
  const b = tokenMultiset(translated);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function orderForms(forms: PluralForms): PluralForms {
  const out: PluralForms = {};
  for (const c of PLURAL_CATEGORIES) if (forms[c] !== undefined) out[c] = forms[c];
  return out;
}

function fail(reason: string): CheckResult {
  return { ok: false, reason };
}
