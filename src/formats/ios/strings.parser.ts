import type { StringEntry } from '../../core/entry.model.js';

export class StringsSyntaxError extends Error {}

interface PendingComment {
  text: string;
  /** A blank line separates this comment from whatever follows it. */
  detached: boolean;
}

/**
 * Parses an iOS `.strings` file (old-style plist dictionary of strings).
 *
 * A comment directly above an entry becomes its `comment`. A comment followed by a blank line
 * becomes the `section` of the next entry (e.g. `// MARK: - Settings`).
 */
export function parseStrings(source: string): { entries: StringEntry[]; warnings: string[] } {
  const p = new Parser(source);
  return p.parse();
}

class Parser {
  private pos = 0;
  private readonly entries: StringEntry[] = [];
  private readonly byKey = new Map<string, StringEntry>();
  private readonly warnings: string[] = [];
  private pending: PendingComment[] = [];

  constructor(private readonly src: string) {}

  parse(): { entries: StringEntry[]; warnings: string[] } {
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) break;
      if (this.src.startsWith('/*', this.pos)) {
        this.pending.push({ text: this.blockComment(), detached: false });
        this.lastWasLineComment = false;
        continue;
      }
      if (this.src.startsWith('//', this.pos)) {
        this.lineComment();
        continue;
      }
      this.entry();
    }
    return { entries: this.entries, warnings: this.warnings };
  }

  private entry(): void {
    const line = this.lineAt(this.pos);
    const key = this.stringOrWord();
    this.skipTrivia();
    let value: string;
    if (this.peek() === ';') {
      value = key; // `"key";` means the value equals the key.
    } else {
      this.expect('=');
      this.skipTrivia();
      value = this.stringOrWord();
      this.skipTrivia();
    }
    this.expect(';');

    const { comment, section } = this.takeComments();
    const existing = this.byKey.get(key);
    if (existing) {
      this.warnings.push(`Duplicate key "${key}" on line ${line}; the last value is used.`);
      existing.value = value;
      return;
    }
    const entry: StringEntry = { kind: 'string', key, value, translatable: true };
    if (comment) entry.comment = comment;
    if (section) entry.section = section;
    this.entries.push(entry);
    this.byKey.set(key, entry);
  }

  private takeComments(): { comment?: string; section?: string } {
    const pending = this.pending;
    this.pending = [];
    let comment: string | undefined;
    let i = pending.length;
    const attached: string[] = [];
    while (i > 0 && !pending[i - 1]!.detached) attached.unshift(pending[--i]!.text);
    if (attached.length) comment = attached.join('\n');
    const section = i > 0 ? pending[i - 1]!.text : undefined;
    return { comment, section };
  }

  private skipWhitespace(): void {
    let newlines = 0;
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) {
      if (this.src[this.pos] === '\n') newlines++;
      this.pos++;
    }
    const last = this.pending[this.pending.length - 1];
    if (newlines >= 2 && last) last.detached = true;
  }

  /** Whitespace and comments inside an entry (rare, but legal). */
  private skipTrivia(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
      if (this.src.startsWith('/*', this.pos)) this.blockComment();
      else if (this.src.startsWith('//', this.pos)) this.readLine();
      else return;
    }
  }

  private blockComment(): string {
    const end = this.src.indexOf('*/', this.pos + 2);
    if (end < 0) this.fail('Unterminated /* comment');
    const text = this.src.slice(this.pos + 2, end);
    this.pos = end + 2;
    return cleanComment(text);
  }

  private lineComment(): void {
    const text = this.readLine();
    // Consecutive `//` lines form one comment.
    const last = this.pending[this.pending.length - 1];
    if (last && !last.detached && last.text !== '' && this.lastWasLineComment) {
      last.text += '\n' + text;
    } else {
      this.pending.push({ text, detached: false });
    }
    this.lastWasLineComment = true;
  }

  private lastWasLineComment = false;

  private readLine(): string {
    const nl = this.src.indexOf('\n', this.pos);
    const end = nl < 0 ? this.src.length : nl;
    const text = this.src.slice(this.pos + 2, end).trim();
    this.pos = end;
    return text;
  }

  private stringOrWord(): string {
    this.lastWasLineComment = false;
    const ch = this.peek();
    if (ch === '"') return this.quoted();
    const m = /^[A-Za-z0-9_$+/:.-]+/.exec(this.src.slice(this.pos, this.pos + 1024));
    if (!m) this.fail(`Unexpected ${ch === undefined ? 'end of file' : `"${ch}"`}`);
    this.pos += m[0].length;
    return m[0];
  }

  private quoted(): string {
    this.pos++; // opening quote
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) this.fail('Unterminated string');
      const ch = this.src[this.pos++]!;
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = this.src[this.pos++];
      switch (esc) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'U':
        case 'u': {
          const hex = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.pos, this.pos + 4));
          if (!hex) {
            out += esc;
            break;
          }
          out += String.fromCharCode(parseInt(hex[0], 16));
          this.pos += 4;
          break;
        }
        default:
          if (esc !== undefined && /[0-7]/.test(esc)) {
            const oct = /^[0-7]{0,2}/.exec(this.src.slice(this.pos, this.pos + 2))![0];
            out += String.fromCharCode(parseInt(esc + oct, 8));
            this.pos += oct.length;
          } else if (esc !== undefined) {
            out += esc; // \" \\ \' and anything else
          }
      }
    }
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      const got = this.peek();
      this.fail(`Expected "${ch}" but found ${got === undefined ? 'end of file' : `"${got}"`}`);
    }
    this.pos++;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private lineAt(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos; i++) if (this.src[i] === '\n') line++;
    return line;
  }

  private fail(message: string): never {
    throw new StringsSyntaxError(`${message} (line ${this.lineAt(this.pos)})`);
  }
}

function cleanComment(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim();
}
