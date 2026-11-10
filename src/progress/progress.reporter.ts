import cliProgress from 'cli-progress';
import pc from 'picocolors';

/** What the pipeline reports while it runs. */
export interface ProgressSink {
  info(line: string): void;
  warn(message: string): void;
  notice(lang: string, message: string): void;
  addLanguage(lang: string, total: number, chunks: number): void;
  advance(lang: string, by: number): void;
  chunkDone(lang: string): void;
  languageDone(lang: string, note: string, ok: boolean): void;
  stop(): void;
}

interface LangState {
  bar?: cliProgress.SingleBar;
  total: number;
  done: number;
  chunks: number;
  chunksDone: number;
  startedAt?: number;
  finished: boolean;
}

/**
 * One progress bar per language when the output is a terminal; plain log lines otherwise
 * (for example when piped to a file).
 */
export class ProgressReporter implements ProgressSink {
  private readonly tty: boolean;
  private multibar?: cliProgress.MultiBar;
  private readonly langs = new Map<string, LangState>();
  private readonly width: number;

  constructor(langCodes: string[], stream: NodeJS.WriteStream = process.stdout) {
    this.tty = Boolean(stream.isTTY);
    this.width = Math.max(2, ...langCodes.map((l) => l.length));
  }

  info(line: string): void {
    this.print(line);
  }

  warn(message: string): void {
    this.print(pc.yellow(`! ${message}`));
  }

  notice(lang: string, message: string): void {
    this.print(pc.yellow(`! ${lang}: ${message}`));
  }

  addLanguage(lang: string, total: number, chunks: number): void {
    const state: LangState = { total, done: 0, chunks, chunksDone: 0, finished: false };
    this.langs.set(lang, state);
    if (!this.tty || total === 0) return;
    this.multibar ??= new cliProgress.MultiBar(
      {
        format: `{lang} {bar} {value}/{total}  {status}`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        barsize: 24,
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
        autopadding: true,
        forceRedraw: true,
      },
      cliProgress.Presets.shades_classic,
    );
    state.bar = this.multibar.create(total, 0, { lang: lang.padEnd(this.width), status: pc.dim('queued') });
  }

  advance(lang: string, by: number): void {
    const s = this.langs.get(lang);
    if (!s) return;
    s.startedAt ??= Date.now();
    s.done = Math.min(s.total, s.done + by);
    s.bar?.update(s.done, { status: this.status(s) });
  }

  chunkDone(lang: string): void {
    const s = this.langs.get(lang);
    if (!s) return;
    s.startedAt ??= Date.now();
    s.chunksDone++;
    if (s.bar) s.bar.update(s.done, { status: this.status(s) });
    else this.print(`${lang.padEnd(this.width)}  chunk ${s.chunksDone}/${s.chunks}  ${s.done}/${s.total} entries`);
  }

  languageDone(lang: string, note: string, ok: boolean): void {
    const s = this.langs.get(lang);
    if (!s || s.finished) return;
    s.finished = true;
    const text = ok ? pc.green(note) : pc.yellow(note);
    if (s.bar) s.bar.update(s.done, { status: text });
    else this.print(`${lang.padEnd(this.width)}  ${note}`);
  }

  stop(): void {
    this.multibar?.stop();
    this.multibar = undefined;
  }

  private status(s: LangState): string {
    const parts = [`chunk ${Math.min(s.chunksDone + 1, s.chunks)}/${s.chunks}`];
    if (s.startedAt && s.done > 0 && s.done < s.total) {
      const elapsed = (Date.now() - s.startedAt) / 1000;
      const eta = Math.round(((s.total - s.done) * elapsed) / s.done);
      parts.push(`ETA ${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, '0')}`);
    }
    return pc.dim(parts.join(' · '));
  }

  private print(line: string): void {
    if (this.multibar) this.multibar.log(`${line}\n`);
    else console.log(line);
  }
}
