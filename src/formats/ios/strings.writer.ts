import type { Entry } from '../../core/entry.model.js';
import { stripXliff } from '../../core/markup.js';
import { ensurePositional } from '../../core/placeholders.js';

/** Key used on iOS for item `i` of an Android `<string-array>`. */
export function arrayItemKey(key: string, index: number): string {
  return `${key}_${index}`;
}

/** Converts canonical text to the value written in iOS files (positions added, xliff wrappers removed). */
export function toIosText(text: string): string {
  return ensurePositional(stripXliff(text));
}

/**
 * Renders string and array entries as a `.strings` file (UTF-8).
 * Plural entries are skipped: they belong in the `.stringsdict`.
 */
export function writeStrings(entries: Entry[]): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'plural') continue;
    const lines: string[] = [];
    if (entry.section) lines.push(`/* ${commentText(entry.section)} */`, '');
    if (entry.comment) lines.push(`/* ${commentText(entry.comment)} */`);
    if (entry.kind === 'string') {
      lines.push(line(entry.key, entry.value));
    } else {
      entry.items.forEach((item, i) => lines.push(line(arrayItemKey(entry.key, i), item)));
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

function line(key: string, value: string): string {
  return `"${escape(key)}" = "${escape(toIosText(value))}";`;
}

function escape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function commentText(text: string): string {
  return text.replace(/\*\//g, '* /');
}
