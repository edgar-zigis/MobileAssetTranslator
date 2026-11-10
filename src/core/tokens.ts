import { TAG_PATTERN, XLIFF_BLOCK_PATTERN } from './markup.js';
import { PLACEHOLDER_PATTERN } from './placeholders.js';

/**
 * Replaces placeholders and inline markup with `{{n}}` tokens before text goes to the model,
 * and puts them back afterwards. The model never sees platform syntax, so it cannot break it.
 *
 * One TokenMap is shared by all texts of an entry (plural forms, array items), so the same
 * placeholder always gets the same token.
 */
export class TokenMap {
  private readonly ids = new Map<string, number>();
  readonly raws: string[] = [];

  mask(text: string): string {
    let out = '';
    let last = 0;
    for (const t of scanProtected(text)) {
      out += text.slice(last, t.offset) + `{{${this.idFor(t.raw)}}}`;
      last = t.offset + t.raw.length;
    }
    return out + text.slice(last);
  }

  /** Restores tokens. Throws `UnknownTokenError` if the text has a token this map never issued. */
  unmask(text: string): string {
    return text.replace(TOKEN_RE(), (_, id: string) => {
      const raw = this.raws[Number(id)];
      if (raw === undefined) throw new UnknownTokenError(`{{${id}}}`);
      return raw;
    });
  }

  get size(): number {
    return this.raws.length;
  }

  private idFor(raw: string): number {
    let id = this.ids.get(raw);
    if (id === undefined) {
      id = this.raws.length;
      this.raws.push(raw);
      this.ids.set(raw, id);
    }
    return id;
  }
}

export class UnknownTokenError extends Error {}

const TOKEN_RE = () => /\{\{\s*(\d+)\s*\}\}/g;

/** The tokens in a masked text as a sorted list (a multiset), e.g. `['{{0}}', '{{0}}', '{{1}}']`. */
export function tokenMultiset(masked: string): string[] {
  return [...masked.matchAll(TOKEN_RE())].map((m) => `{{${m[1]}}}`).sort();
}

/** True when the text has something to translate once tokens, digits and punctuation are removed. */
export function hasTranslatableText(masked: string): boolean {
  return /\p{L}/u.test(masked.replace(TOKEN_RE(), ''));
}

interface Protected {
  offset: number;
  raw: string;
}

function scanProtected(text: string): Protected[] {
  const found: Protected[] = [];
  const patterns = [
    new RegExp(XLIFF_BLOCK_PATTERN, 'gi'),
    new RegExp(TAG_PATTERN, 'gi'),
    new RegExp(PLACEHOLDER_PATTERN, 'g'),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.push({ offset: m.index, raw: m[0] });
  }
  // Earliest first; at the same offset the longest wins (an xliff block beats the tag inside it).
  found.sort((a, b) => a.offset - b.offset || b.raw.length - a.raw.length);
  const out: Protected[] = [];
  let end = 0;
  for (const f of found) {
    if (f.offset >= end) {
      out.push(f);
      end = f.offset + f.raw.length;
    }
  }
  return out;
}
