import { build, parse, parseBinary, type PlistValue } from 'plist';
import { PLURAL_CATEGORIES, type PluralEntry, type PluralForms } from '../../core/entry.model.js';
import { argumentPlaceholders, findPlaceholders } from '../../core/placeholders.js';
import { toIosText } from './strings.writer.js';

type Dict = { [key: string]: PlistValue };

const isDict = (v: PlistValue | undefined): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

/**
 * Parses a `.stringsdict` (XML or binary plist). Supports keys whose format has a single
 * plural variable; text around the variable is folded into each form, so
 * `"%#@files@ selected"` with `one = "%d file"` becomes the form `"%d file selected"`.
 */
export function parseStringsdict(data: Buffer): { entries: PluralEntry[]; warnings: string[] } {
  const isBinary = data.subarray(0, 6).toString('latin1') === 'bplist';
  const root = isBinary ? parseBinary(data) : parse(data.toString('utf8'));
  const entries: PluralEntry[] = [];
  const warnings: string[] = [];
  if (!isDict(root)) return { entries, warnings: ['The .stringsdict root is not a dictionary; it was ignored.'] };

  for (const [key, value] of Object.entries(root)) {
    if (!isDict(value) || typeof value.NSStringLocalizedFormatKey !== 'string') {
      warnings.push(`stringsdict key "${key}" has no NSStringLocalizedFormatKey; skipped.`);
      continue;
    }
    const format = value.NSStringLocalizedFormatKey;
    const variables = findPlaceholders(format).filter((p) => p.conversion === '#@');
    if (variables.length !== 1) {
      warnings.push(`stringsdict key "${key}" uses ${variables.length} plural variables; only one is supported, so it was skipped.`);
      continue;
    }
    const variable = variables[0]!;
    const rule = value[variable.pluralVariable!];
    if (!isDict(rule) || rule.NSStringFormatSpecTypeKey !== 'NSStringPluralRuleType') {
      warnings.push(`stringsdict key "${key}" has no plural rule for "${variable.pluralVariable}"; skipped.`);
      continue;
    }
    const prefix = format.slice(0, variable.offset);
    const suffix = format.slice(variable.offset + variable.raw.length);
    const forms: PluralForms = {};
    for (const category of PLURAL_CATEGORIES) {
      const form = rule[category];
      if (typeof form === 'string') forms[category] = prefix + form + suffix;
    }
    if (!forms.other) {
      warnings.push(`stringsdict key "${key}" has no "other" form; skipped.`);
      continue;
    }
    entries.push({
      kind: 'plural',
      key,
      forms,
      translatable: true,
      stringsdict: {
        variable: variable.pluralVariable,
        valueType: typeof rule.NSStringFormatValueTypeKey === 'string' ? rule.NSStringFormatValueTypeKey : undefined,
      },
    });
  }
  return { entries, warnings };
}

const INTEGER_CONVERSIONS = new Set(['d', 'i', 'u', 'D', 'U', 'o', 'x', 'X']);

/** Renders plural entries as a `.stringsdict` XML plist. */
export function writeStringsdict(entries: PluralEntry[]): string {
  const root: Dict = {};
  for (const entry of entries) {
    const forms: Dict = {};
    for (const category of PLURAL_CATEGORIES) {
      const form = entry.forms[category];
      if (form !== undefined) forms[category] = toIosText(form);
    }
    const reference = (forms.other ?? Object.values(forms)[0] ?? '') as string;
    const count = argumentPlaceholders(reference).find((p) => INTEGER_CONVERSIONS.has(p.conversion));
    const variable = entry.stringsdict?.variable ?? 'count';
    const valueType = entry.stringsdict?.valueType ?? (count ? `${count.lengthModifier ?? ''}${count.conversion}` : 'd');
    const position = count?.position !== undefined ? `${count.position}$` : '';
    root[entry.key] = {
      NSStringLocalizedFormatKey: `%${position}#@${variable}@`,
      [variable]: {
        NSStringFormatSpecTypeKey: 'NSStringPluralRuleType',
        NSStringFormatValueTypeKey: valueType,
        ...forms,
      },
    };
  }
  return build(root, { pretty: true, indent: '\t' }) + '\n';
}
