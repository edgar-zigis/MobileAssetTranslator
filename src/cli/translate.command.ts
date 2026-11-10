import { resolve } from 'node:path';
import { Command, CommandRunner, Option } from 'nest-commander';
import pc from 'picocolors';
import { normalizeLocale } from '../core/locale.js';
import { ProgressReporter } from '../progress/progress.reporter.js';
import { DEFAULT_LIMITS } from '../translation/chunker.js';
import { FatalLlmError } from '../translation/llm-client.js';
import { TranslatePipeline, type RunResult } from '../translation/translate.pipeline.js';

interface Options {
  from: string;
  to: string[];
  out: string;
  context?: string;
  glossary?: string;
  force?: boolean;
  dryRun?: boolean;
  concurrency: number;
  chunkSize: number;
  chunkChars: number;
}

export const EXIT = { ok: 0, fatal: 1, partial: 2, cancelled: 130 } as const;

@Command({
  name: 'translate',
  arguments: '<file>',
  description:
    'Translate an iOS .strings or Android strings.xml file with Gemini and write iOS and Android files for every target language.',
  options: { isDefault: true },
})
export class TranslateCommand extends CommandRunner {
  constructor(private readonly pipeline: TranslatePipeline) {
    super();
  }

  async run([file]: string[], options: Options): Promise<void> {
    let opts: Options;
    try {
      opts = { ...options, from: normalizeLocale(options.from), to: options.to.map(normalizeLocale) };
    } catch (e) {
      return this.fail((e as Error).message);
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = () => {
      interrupts++;
      if (interrupts > 1) process.exit(EXIT.cancelled);
      controller.abort();
      console.error(pc.yellow('\nStopping… saving what is done. Press Ctrl+C again to quit at once.'));
    };
    process.on('SIGINT', onSigint);

    const progress = new ProgressReporter(opts.to);
    let result: RunResult;
    try {
      result = await this.pipeline.run(
        {
          input: resolve(file!),
          from: opts.from,
          to: opts.to,
          out: resolve(opts.out),
          context: opts.context,
          glossary: opts.glossary ? resolve(opts.glossary) : undefined,
          force: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          concurrency: opts.concurrency,
          limits: { maxEntries: opts.chunkSize, maxChars: opts.chunkChars },
        },
        progress,
        controller.signal,
      );
    } catch (e) {
      progress.stop();
      return this.fail((e as Error).message);
    } finally {
      process.off('SIGINT', onSigint);
    }
    this.summarize(result, Boolean(opts.dryRun));
  }

  @Option({ flags: '-f, --from <code>', description: 'language of the input file, e.g. en', required: true })
  parseFrom(value: string): string {
    return value;
  }

  @Option({ flags: '-t, --to <codes>', description: 'comma-separated target languages, e.g. de,fr,lt', required: true })
  parseTo(value: string): string[] {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  @Option({ flags: '-o, --out <dir>', description: 'output folder', defaultValue: './output' })
  parseOut(value: string): string {
    return value;
  }

  @Option({ flags: '-c, --context <text>', description: 'what the app is about, tone, audience (added to every prompt)' })
  parseContext(value: string): string {
    return value;
  }

  @Option({ flags: '-g, --glossary <file>', description: 'JSON glossary: { "doNotTranslate": [...], "terms": { "de": { ... } } }' })
  parseGlossary(value: string): string {
    return value;
  }

  @Option({ flags: '--force', description: 'translate everything again, ignoring existing output' })
  parseForce(): boolean {
    return true;
  }

  @Option({ flags: '--dry-run', description: 'parse and chunk only; no API calls, nothing written' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--concurrency <n>', description: 'requests in flight at once', defaultValue: 3 })
  parseConcurrency(value: string): number {
    return positiveInt(value, '--concurrency');
  }

  @Option({ flags: '--chunk-size <n>', description: 'most entries per request', defaultValue: DEFAULT_LIMITS.maxEntries })
  parseChunkSize(value: string): number {
    return positiveInt(value, '--chunk-size');
  }

  @Option({ flags: '--chunk-chars <n>', description: 'most source characters per request', defaultValue: DEFAULT_LIMITS.maxChars })
  parseChunkChars(value: string): number {
    return positiveInt(value, '--chunk-chars');
  }

  private summarize(result: RunResult, dryRun: boolean): void {
    const out = console.log;
    if (dryRun) {
      out(pc.dim('\nDry run: nothing was sent to Gemini and no files were written.'));
      process.exitCode = EXIT.ok;
      return;
    }
    out('');
    const rows = result.languages.map((r) => [
      r.lang,
      String(r.translated),
      String(r.reused),
      String(r.copied),
      String(r.failed.size),
      `${fmt(r.usage.inputTokens)} / ${fmt(r.usage.outputTokens)}`,
    ]);
    table(['lang', 'translated', 'kept', 'copied', 'failed', 'tokens in / out'], rows).forEach((l) => out(l));

    const files = [...result.sourceFiles, ...result.languages.flatMap((r) => r.files)];
    if (files.length) {
      out(pc.dim(`\nWrote ${files.length} ${files.length === 1 ? 'file' : 'files'}:`));
      for (const f of files) out(pc.dim(`  ${f}`));
    }

    const failed = result.languages.reduce((n, r) => n + r.failed.size, 0);
    if (result.fatal) {
      console.error(pc.red(`\n✖ ${result.fatal.message}`));
      if (!(result.fatal instanceof FatalLlmError) && result.fatal.stack) console.error(pc.dim(result.fatal.stack));
      process.exitCode = EXIT.fatal;
    } else if (result.cancelled) {
      out(pc.yellow('\nStopped. Run the same command again to continue where it left off.'));
      process.exitCode = EXIT.cancelled;
    } else if (failed) {
      out(pc.yellow(`\n${failed} entries could not be translated and were left out. Run the command again to retry them.`));
      process.exitCode = EXIT.partial;
    } else {
      out(pc.green('\n✔ All done.'));
      process.exitCode = EXIT.ok;
    }
  }

  private fail(message: string): void {
    console.error(pc.red(`✖ ${message}`));
    process.exitCode = EXIT.fatal;
  }
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number`);
  return n;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('   ');
  return [pc.bold(line(head)), ...rows.map(line)];
}
