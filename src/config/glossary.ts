import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { normalizeLocale } from '../core/locale.js';

/**
 * Optional `--glossary` file:
 * {
 *   "doNotTranslate": ["Acme", "Pro"],
 *   "terms": { "de": { "workout": "Training" }, "lt": { "workout": "treniruotė" } }
 * }
 */
const GlossarySchema = z.object({
  doNotTranslate: z.array(z.string()).default([]),
  terms: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export type Glossary = z.infer<typeof GlossarySchema>;

export async function loadGlossary(path: string): Promise<Glossary> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read glossary ${path}: ${(e as Error).message}`);
  }
  const parsed = GlossarySchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid glossary ${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

/** Fixed translations for a target language; `pt-BR` also picks up terms listed under `pt`. */
export function termsFor(glossary: Glossary | undefined, target: string): Record<string, string> {
  if (!glossary) return {};
  const canonical = normalizeLocale(target);
  const language = canonical.split('-')[0]!;
  const out: Record<string, string> = {};
  for (const [code, terms] of Object.entries(glossary.terms)) {
    const c = normalizeLocale(code);
    if (c === language) Object.assign(out, terms);
  }
  for (const [code, terms] of Object.entries(glossary.terms)) {
    if (normalizeLocale(code) === canonical && canonical !== language) Object.assign(out, terms);
  }
  return out;
}
