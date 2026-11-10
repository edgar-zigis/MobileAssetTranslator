import { Injectable } from '@nestjs/common';
import type { EntryContent } from '../core/entry.model.js';
import { LlmClient, LlmUnavailableError, type LlmUsage } from './llm-client.js';
import { RESPONSE_SCHEMA, systemInstruction, userPrompt, type PromptContext } from './prompt.builder.js';
import { checkTranslation, parseModelResponse, ResponseFormatError, type RawTranslation } from './response.validator.js';
import type { WorkItem } from './work-item.js';

/** How many more times entries that failed the checks are sent again. */
export const MAX_CORRECTION_ROUNDS = 2;

export interface ChunkResult {
  translated: Map<string, EntryContent>;
  /** Key → why it could not be translated. */
  failed: Map<string, string>;
  usage: LlmUsage;
}

export interface ChunkHooks {
  signal?: AbortSignal;
  /** Retries and correction rounds, for the progress view. */
  onNotice?: (message: string) => void;
  /** Entries accepted so far, so progress can move during correction rounds. */
  onAccepted?: (count: number) => void;
}

@Injectable()
export class TranslationService {
  constructor(private readonly llm: LlmClient) {}

  /**
   * Translates one chunk. Entries whose translation fails the checks are sent again on their
   * own (up to MAX_CORRECTION_ROUNDS times). If the whole response was unusable, the retry is
   * split in two smaller requests.
   */
  async translateChunk(items: WorkItem[], ctx: PromptContext, hooks: ChunkHooks = {}): Promise<ChunkResult> {
    const system = systemInstruction(ctx);
    const translated = new Map<string, EntryContent>();
    const reasons = new Map<string, string>();
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

    let pending = items;
    let wholeResponseFailed = false;
    for (let round = 0; round <= MAX_CORRECTION_ROUNDS && pending.length; round++) {
      const batches = wholeResponseFailed && pending.length > 1 ? halves(pending) : [pending];
      const retry: WorkItem[] = [];
      wholeResponseFailed = false;

      for (const batch of batches) {
        let byId: Map<string, RawTranslation>;
        try {
          const res = await this.llm.generate(
            { system, prompt: userPrompt(batch), schema: RESPONSE_SCHEMA },
            { signal: hooks.signal, onRetry: hooks.onNotice },
          );
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
          byId = parseModelResponse(res.text);
          if (res.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(res.finishReason) && byId.size === 0) {
            throw new ResponseFormatError(`the model stopped early (${res.finishReason})`);
          }
        } catch (e) {
          if (e instanceof ResponseFormatError) {
            wholeResponseFailed = true;
            for (const item of batch) reasons.set(item.entry.key, e.message);
            retry.push(...batch);
            continue;
          }
          if (e instanceof LlmUnavailableError) {
            for (const item of batch) reasons.set(item.entry.key, e.message);
            continue; // no point re-asking; leave these as failed
          }
          throw e;
        }

        let accepted = 0;
        batch.forEach((item, i) => {
          const result = checkTranslation(item, byId.get(String(i + 1)), ctx.targetPlurals);
          if (result.ok) {
            translated.set(item.entry.key, result.content);
            reasons.delete(item.entry.key);
            accepted++;
          } else {
            reasons.set(item.entry.key, result.reason);
            retry.push(item);
          }
        });
        if (accepted) hooks.onAccepted?.(accepted);
      }

      pending = retry;
      if (pending.length && round < MAX_CORRECTION_ROUNDS) {
        const sample = reasons.get(pending[0]!.entry.key);
        hooks.onNotice?.(`${pending.length} ${pending.length === 1 ? 'entry' : 'entries'} rejected (${sample}), asking again (${round + 1}/${MAX_CORRECTION_ROUNDS})`);
      }
    }

    const failed = new Map<string, string>();
    for (const item of items) {
      if (!translated.has(item.entry.key)) failed.set(item.entry.key, reasons.get(item.entry.key) ?? 'not translated');
    }
    return { translated, failed, usage };
  }
}

function halves<T>(list: T[]): T[][] {
  const mid = Math.ceil(list.length / 2);
  return [list.slice(0, mid), list.slice(mid)];
}
