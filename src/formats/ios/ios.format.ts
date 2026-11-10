import type { Entry, PluralEntry, ResourceDocument } from '../../core/entry.model.js';
import { decodeTextFile } from '../text-decoding.js';
import { parseStrings } from './strings.parser.js';
import { parseStringsdict, writeStringsdict } from './stringsdict.js';
import { writeStrings } from './strings.writer.js';

/** Builds one document from a `.strings` file and, if present, its sibling `.stringsdict`. */
export function readIosDocument(strings: Buffer, stringsdict: Buffer | undefined, baseName: string): ResourceDocument {
  const parsed = parseStrings(decodeTextFile(strings));
  const warnings = [...parsed.warnings];
  let entries: Entry[] = parsed.entries;
  if (stringsdict) {
    const plurals = parseStringsdict(stringsdict);
    warnings.push(...plurals.warnings);
    const pluralKeys = new Set(plurals.entries.map((e) => e.key));
    const shadowed = entries.filter((e) => pluralKeys.has(e.key));
    for (const e of shadowed) warnings.push(`"${e.key}" is in both .strings and .stringsdict; the .stringsdict version is used.`);
    entries = [...entries.filter((e) => !pluralKeys.has(e.key)), ...plurals.entries];
  }
  return { platform: 'ios', baseName, entries, warnings };
}

export interface IosFiles {
  strings: string;
  /** Only present when there are plural entries. */
  stringsdict?: string;
}

export function renderIos(entries: Entry[]): IosFiles {
  const plurals = entries.filter((e): e is PluralEntry => e.kind === 'plural');
  return {
    strings: writeStrings(entries),
    stringsdict: plurals.length ? writeStringsdict(plurals) : undefined,
  };
}
