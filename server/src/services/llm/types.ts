/** Provider-agnostic LLM contract shared by every backend. */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  system?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProviderInfo {
  name: string;
  model: string;
  /** Human-readable note surfaced on /api/health, e.g. missing API key. */
  status: 'ready' | 'missing-credentials' | 'disabled';
  detail?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  info(): LlmProviderInfo;
  complete(request: LlmCompletionRequest): Promise<string>;
  stream(request: LlmCompletionRequest): AsyncGenerator<string, void, unknown>;
}

export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigurationError';
  }
}