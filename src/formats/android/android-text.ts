import { tagLengthAt } from '../../core/markup.js';
import { ensurePositional, fromAndroidPlaceholders, toAndroidPlaceholders } from '../../core/placeholders.js';

type Segment = { markup: string } | { text: string };

/**
 * Turns the raw inner XML of a `<string>`/`<item>` into canonical text, the way aapt2 reads it:
 * entities decoded, CDATA unwrapped, backslash escapes applied, whitespace collapsed outside
 * double quotes, and inline markup kept as literal tags.
 */
export function decodeAndroidValue(raw: string): { text: string; cdata: boolean } {
  const { segments, cdata } = xmlSegments(raw);
  let out = '';
  let inQuotes = false;
  let pendingSpace = false;
  const emit = (s: string) => {
    if (pendingSpace && out !== '') out += ' ';
    pendingSpace = false;
    out += s;
  };
  for (const seg of segments) {
    if ('markup' in seg) {
      emit(seg.markup);
      continue;
    }
    const t = seg.text;
    for (let i = 0; i < t.length; i++) {
      const c = t[i]!;
      if (c === '\\' && i + 1 < t.length) {
        const n = t[++i]!;
        if (n === 'n') emit('\n');
        else if (n === 't') emit('\t');
        else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 1, i + 5))) {
          emit(String.fromCharCode(parseInt(t.slice(i + 1, i + 5), 16)));
          i += 4;
        } else emit(n);
      } else if (c === '"') {
        inQuotes = !inQuotes;
      } else if (/\s/.test(c)) {
        if (inQuotes) emit(c);
        else pendingSpace = true;
      } else {
        emit(c);
      }
    }
  }
  return { text: fromAndroidPlaceholders(out), cdata };
}

/** Canonical text → raw inner XML for Android. */
export function encodeAndroidValue(text: string, cdata = false): string {
  const value = toAndroidPlaceholders(ensurePositional(text));
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const tag = cdata ? 0 : tagLengthAt(value, i);
    if (tag) {
      out += value.slice(i, i + tag);
      i += tag - 1;
      continue;
    }
    const c = value[i]!;
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === "'") out += "\\'";
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if ((c === '@' || c === '?') && i === 0) out += `\\${c}`;
    else if (!cdata && c === '&') out += '&amp;';
    else if (!cdata && c === '<') out += '&lt;';
    else if (!cdata && c === '>') out += '&gt;';
    else out += c;
  }
  // Leading/trailing or repeated spaces only survive inside double quotes.
  if (/^ | $| {2}/.test(value)) out = `"${out}"`;
  return cdata ? `<![CDATA[${out.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlSegments(raw: string): { segments: Segment[]; cdata: boolean } {
  const segments: Segment[] = [];
  let text = '';
  let cdata = false;
  const flush = () => {
    if (text) segments.push({ text });
    text = '';
  };
  for (let i = 0; i < raw.length; i++) {
    if (raw.startsWith('<![CDATA[', i)) {
      const end = raw.indexOf(']]>', i);
      const stop = end < 0 ? raw.length : end;
      text += raw.slice(i + 9, stop);
      cdata = true;
      i = stop + 2;
    } else if (raw.startsWith('<!--', i)) {
      const end = raw.indexOf('-->', i);
      i = end < 0 ? raw.length : end + 2;
    } else if (raw[i] === '<') {
      const end = raw.indexOf('>', i);
      const stop = end < 0 ? raw.length - 1 : end;
      flush();
      segments.push({ markup: raw.slice(i, stop + 1) });
      i = stop;
    } else if (raw[i] === '&') {
      const m = /^&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/.exec(raw.slice(i, i + 12));
      if (m) {
        const name = m[1]!;
        text += name.startsWith('#x')
          ? String.fromCodePoint(parseInt(name.slice(2), 16))
          : name.startsWith('#')
            ? String.fromCodePoint(parseInt(name.slice(1), 10))
            : (ENTITIES[name] ?? m[0]);
        i += m[0].length - 1;
      } else {
        text += '&';
      }
    } else {
      text += raw[i];
    }
  }
  flush();
  return { segments, cdata };
}
