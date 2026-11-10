/**
 * printf-style placeholders shared by iOS (`%@`, `%ld`, `%1$@`) and Android (`%s`, `%d`, `%1$s`).
 *
 * Canonical text uses iOS spelling for objects (`%@`). Android files are converted on the way in
 * (`fromAndroidPlaceholders`) and on the way out (`toAndroidPlaceholders`).
 */

export interface Placeholder {
  raw: string;
  offset: number;
  position?: number;
  flags: string;
  width?: string;
  precision?: string;
  lengthModifier?: string;
  conversion: string;
  /** `%#@name@` variable from a `.stringsdict` format key. */
  pluralVariable?: string;
}

// The space flag is left out on purpose: "50% off" would otherwise parse as `% o`.
const SPEC_SOURCE =
  "%(?:(\\d+)\\$)?(?:#@([^@\\s]+)@|([-+#0']*)(\\d+|\\*)?(?:\\.(\\d+|\\*))?(hh|h|ll|l|q|L|z|t|j)?([@dDiuUxXoOfFeEgGcCsSaAp%]))";

export const PLACEHOLDER_PATTERN = SPEC_SOURCE;

export function findPlaceholders(text: string): Placeholder[] {
  const re = new RegExp(SPEC_SOURCE, 'g');
  const out: Placeholder[] = [];
  for (const m of text.matchAll(re)) {
    out.push({
      raw: m[0],
      offset: m.index,
      position: m[1] !== undefined ? Number(m[1]) : undefined,
      pluralVariable: m[2],
      flags: m[3] ?? '',
      width: m[4],
      precision: m[5],
      lengthModifier: m[6],
      conversion: m[2] !== undefined ? '#@' : (m[7] ?? ''),
    });
  }
  return out;
}

/** Placeholders that consume an argument (everything except `%%`). */
export function argumentPlaceholders(text: string): Placeholder[] {
  return findPlaceholders(text).filter((p) => p.conversion !== '%');
}

function render(p: Placeholder, overrides: Partial<Placeholder> = {}): string {
  const q = { ...p, ...overrides };
  if (q.conversion === '#@') {
    return `%${q.position !== undefined ? `${q.position}$` : ''}#@${q.pluralVariable}@`;
  }
  return (
    '%' +
    (q.position !== undefined ? `${q.position}$` : '') +
    q.flags +
    (q.width ?? '') +
    (q.precision !== undefined ? `.${q.precision}` : '') +
    (q.lengthModifier ?? '') +
    q.conversion
  );
}

function replacePlaceholders(text: string, fn: (p: Placeholder, index: number) => string): string {
  let out = '';
  let last = 0;
  findPlaceholders(text).forEach((p, i) => {
    out += text.slice(last, p.offset) + fn(p, i);
    last = p.offset + p.raw.length;
  });
  return out + text.slice(last);
}

/**
 * When a string has two or more argument placeholders, give every one an explicit position
 * (`%@ and %@` → `%1$@ and %2$@`) so translations can reorder them safely.
 */
export function ensurePositional(text: string): string {
  const args = argumentPlaceholders(text);
  if (args.length < 2 || args.every((p) => p.position !== undefined)) return text;
  let seq = 0;
  return replacePlaceholders(text, (p) => {
    if (p.conversion === '%') return p.raw;
    seq += 1;
    return p.position !== undefined ? p.raw : render(p, { position: seq });
  });
}

/** Android → canonical: `%s`/`%S` become `%@`. */
export function fromAndroidPlaceholders(text: string): string {
  return replacePlaceholders(text, (p) =>
    p.conversion === 's' || p.conversion === 'S' ? render(p, { conversion: '@' }) : p.raw,
  );
}

const ANDROID_CONVERSION: Record<string, string> = {
  '@': 's',
  i: 'd',
  u: 'd',
  U: 'd',
  D: 'd',
  O: 'o',
  F: 'f',
  C: 'c',
  p: 'x',
};

/** Canonical → Android (Java Formatter): `%@` → `%s`, no C length modifiers, `%u` → `%d`. */
export function toAndroidPlaceholders(text: string): string {
  return replacePlaceholders(text, (p) => {
    if (p.conversion === '%' || p.conversion === '#@') return p.raw;
    return render(p, {
      conversion: ANDROID_CONVERSION[p.conversion] ?? p.conversion,
      lengthModifier: undefined,
      flags: p.flags.replace(/'/g, ','),
    });
  });
}
