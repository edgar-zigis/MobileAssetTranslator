import { PLURAL_CATEGORIES, type PluralCategory } from './entry.model.js';

/** Canonical BCP-47 form: `pt_br` → `pt-BR`, `zh-hans` → `zh-Hans`. Throws on malformed codes. */
export function normalizeLocale(code: string): string {
  const trimmed = code.trim().replace(/_/g, '-');
  if (!trimmed) throw new RangeError('Empty language code');
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(trimmed);
  } catch {
    canonical = undefined;
  }
  if (!canonical) throw new RangeError(`"${code}" is not a valid language code`);
  return canonical;
}

/** iOS localization folder, e.g. `pt-BR.lproj`. */
export function iosLprojName(code: string): string {
  return `${normalizeLocale(code)}.lproj`;
}

/**
 * Android resource folder, e.g. `values-de`, `values-pt-rBR`, `values-b+zh+Hans`.
 * Scripts and numeric regions need the `b+` (BCP-47) form.
 */
export function androidValuesDir(code: string): string {
  const loc = new Intl.Locale(normalizeLocale(code));
  const { language, script, region } = loc;
  if (!script && (!region || /^[A-Z]{2}$/.test(region))) {
    return region ? `values-${language}-r${region}` : `values-${language}`;
  }
  return `values-b+${[language, script, region].filter(Boolean).join('+')}`;
}

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** English name for prompts, e.g. `pt-BR` → `Brazilian Portuguese`. */
export function languageName(code: string): string {
  const canonical = normalizeLocale(code);
  return displayNames.of(canonical) ?? canonical;
}

/** CLDR plural categories the language uses, in canonical order (`lt` → one, few, many, other). */
export function pluralCategories(code: string): PluralCategory[] {
  const used = new Intl.PluralRules(normalizeLocale(code)).resolvedOptions().pluralCategories as string[];
  return PLURAL_CATEGORIES.filter((c) => used.includes(c));
}
