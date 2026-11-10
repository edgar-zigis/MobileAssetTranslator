/**
 * Inline markup that Android allows inside string resources (and that iOS apps sometimes keep
 * for attributed strings). Only known tag names count as markup, so text like "a <b and c>"
 * written in an iOS file is not mistaken for a tag unless the tag name is a real one.
 */

const TAG_NAMES =
  'a|abbr|annotation|b|big|blockquote|br|cite|code|del|dfn|div|em|font|h[1-6]|i|img|li|ol|p|q|s|small|span|strike|strong|sub|sup|tt|u|ul|xliff:g';

/** A whole `<xliff:g …>…</xliff:g>` element: its content is never translated. */
export const XLIFF_BLOCK_PATTERN = '<xliff:g\\b[^>]*>[\\s\\S]*?</xliff:g>';

export const TAG_PATTERN = `</?(?:${TAG_NAMES})(?=[\\s/>])(?:\\s+[^<>]*?)?\\s*/?>`;

const TAG_AT_START = new RegExp(`^(?:${TAG_PATTERN})`, 'i');

/** If a markup tag starts at `index`, returns its length. */
export function tagLengthAt(text: string, index: number): number {
  if (text[index] !== '<') return 0;
  const m = TAG_AT_START.exec(text.slice(index, index + 512));
  return m ? m[0].length : 0;
}

/** Removes `<xliff:g>` wrappers but keeps their content (iOS has no use for them). */
export function stripXliff(text: string): string {
  return text.replace(/<xliff:g\b[^>]*>([\s\S]*?)<\/xliff:g>/g, '$1');
}
