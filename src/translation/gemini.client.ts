import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import {
  AbortedError,
  FatalLlmError,
  LlmClient,
  LlmUnavailableError,
  type LlmCallOptions,
  type LlmRequest,
  type LlmResponse,
} from './llm-client.js';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 180_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const THINKING_LEVELS: Record<Env['GEMINI_THINKING_LEVEL'], ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

@Injectable()
export class GeminiClient extends LlmClient {
  private ai?: GoogleGenAI;

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get model(): string {
    return this.config.get('GEMINI_MODEL', { infer: true });
  }

  get thinkingLevel(): Env['GEMINI_THINKING_LEVEL'] {
    return this.config.get('GEMINI_THINKING_LEVEL', { infer: true });
  }

  get description(): string {
    return `${this.model} · thinking ${this.thinkingLevel}`;
  }

  ensureReady(): void {
    this.client();
  }

  async generate(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const { signal, onRetry } = options;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new AbortedError();
      try {
        const res = await this.client().models.generateContent({
          model: this.model,
          contents: request.prompt,
          config: {
            systemInstruction: request.system,
            responseMimeType: 'application/json',
            responseJsonSchema: request.schema,
            thinkingConfig: { thinkingLevel: THINKING_LEVELS[this.thinkingLevel] },
            abortSignal: signal,
          },
        });
        const usage = res.usageMetadata;
        return {
          text: res.text ?? '',
          finishReason: res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason,
          usage: {
            inputTokens: usage?.promptTokenCount ?? 0,
            outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
          },
        };
      } catch (e) {
        if (signal?.aborted) throw new AbortedError();
        const status = e instanceof ApiError ? e.status : undefined;
        const message = (e as Error).message ?? String(e);
        if (status !== undefined && !RETRYABLE_STATUS.has(status)) throw new FatalLlmError(explain(status, message, this.model));
        if (attempt >= MAX_ATTEMPTS) {
          throw new LlmUnavailableError(`Gemini failed ${MAX_ATTEMPTS} times: ${status ? `HTTP ${status} ` : ''}${shorten(message)}`);
        }
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
        const delay = Math.min(MAX_DELAY_MS, Math.max(backoff, retryDelayMs(message) ?? 0)) * (0.8 + Math.random() * 0.4);
        onRetry?.(
          `Gemini ${status ? `HTTP ${status}` : 'network error'}, retrying in ${Math.round(delay / 1000)}s (${attempt}/${MAX_ATTEMPTS - 1})`,
        );
        await sleep(delay, signal);
      }
    }
  }

  private client(): GoogleGenAI {
    if (this.ai) return this.ai;
    const apiKey = this.config.get('GEMINI_API_KEY', { infer: true });
    if (!apiKey) throw new FatalLlmError('GEMINI_API_KEY is not set. Add it to .env (see .env.example).');
    // Retries are handled here so they can be reported in the progress view.
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    return this.ai;
  }
}

function explain(status: number, message: string, model: string): string {
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) return `Gemini rejected the API key (HTTP ${status}). Check GEMINI_API_KEY. ${shorten(message)}`;
  if (status === 404) return `Gemini model "${model}" was not found (HTTP 404). Check GEMINI_MODEL. ${shorten(message)}`;
  return `Gemini refused the request (HTTP ${status}): ${shorten(message)}`;
}

/** Reads `"retryDelay": "12s"` from a 429 error body. */
function retryDelayMs(message: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return m ? Number(m[1]) * 1000 : undefined;
}

function shorten(message: string): string {
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
