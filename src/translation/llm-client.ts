export interface LlmRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  finishReason?: string;
  usage: LlmUsage;
}

export interface LlmCallOptions {
  signal?: AbortSignal;
  /** Called before waiting to retry a failed call. */
  onRetry?: (message: string) => void;
}

/** DI token and contract for the model. `GeminiClient` is the real one; tests pass a fake. */
export abstract class LlmClient {
  abstract readonly description: string;
  /** Throws `FatalLlmError` if the API key or configuration is unusable. */
  abstract ensureReady(): void;
  abstract generate(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
}

/** The whole run must stop (bad key, unknown model, bad request). */
export class FatalLlmError extends Error {}

/** The call kept failing after all retries; other chunks may still work. */
export class LlmUnavailableError extends Error {}

export class AbortedError extends Error {
  constructor() {
    super('Cancelled');
  }
}
