/**
 * Every hosted provider SourceIQ supports (Groq, Mistral, OpenRouter, OpenAI)
 * exposes an OpenAI-compatible `/chat/completions` endpoint, so a single
 * implementation covers all of them by varying `baseURL` + `apiKey`.
 */
import OpenAI from 'openai';
import { env } from '../../config/env.js';
import {
  LlmConfigurationError,
  type LlmCompletionRequest,
  type LlmProvider,
  type LlmProviderInfo,
} from './types.js';

export interface OpenAiCompatibleConfig {
  name: string;
  defaultBaseUrl: string;
  apiKeyEnvHint: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly apiKeyEnvHint: string;
  private readonly disabled: boolean;
  private client: OpenAI | null = null;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = (config.baseUrl?.trim() || config.defaultBaseUrl).replace(/\/+$/, '');
    this.apiKey = config.apiKey?.trim() || undefined;
    this.apiKeyEnvHint = config.apiKeyEnvHint;
    this.disabled = env.DISABLE_LLM_REMOTE;
  }

  info(): LlmProviderInfo {
    if (this.disabled) {
      return {
        name: this.name,
        model: this.model,
        status: 'disabled',
        detail: 'DISABLE_LLM_REMOTE=true (test mode) - no outbound calls will be made.',
      };
    }
    if (!this.apiKey) {
      return {
        name: this.name,
        model: this.model,
        status: 'missing-credentials',
        detail: `Set LLM_API_KEY (${this.apiKeyEnvHint}) to enable ${this.name}.`,
      };
    }
    return { name: this.name, model: this.model, status: 'ready', detail: `endpoint ${this.baseUrl}` };
  }

  private ensureClient(): OpenAI {
    if (this.client) return this.client;
    if (this.disabled) {
      throw new LlmConfigurationError(
        `Remote LLM calls are disabled (DISABLE_LLM_REMOTE=true) but LLM_PROVIDER=${this.name}. ` +
          'Set LLM_PROVIDER=mock for offline development/tests.',
      );
    }
    if (!this.apiKey) {
      throw new LlmConfigurationError(
        `No API key configured for LLM provider "${this.name}". Set LLM_API_KEY in server/.env.`,
      );
    }
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      maxRetries: 2,
      timeout: 60_000,
    });
    return this.client;
  }

  private toMessages(request: LlmCompletionRequest) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) messages.push({ role: m.role, content: m.content });
    return messages;
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    const client = this.ensureClient();
    const response = await client.chat.completions.create(
      {
        model: this.model,
        messages: this.toMessages(request),
        temperature: request.temperature ?? env.LLM_TEMPERATURE,
        max_tokens: request.maxTokens ?? env.LLM_MAX_TOKENS,
      },
      { signal: request.signal },
    );
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new LlmConfigurationError(`${this.name} returned an empty completion.`);
    }
    return content.trim();
  }

  async *stream(request: LlmCompletionRequest): AsyncGenerator<string, void, unknown> {
    const client = this.ensureClient();
    const iterator = await client.chat.completions.create(
      {
        model: this.model,
        messages: this.toMessages(request),
        temperature: request.temperature ?? env.LLM_TEMPERATURE,
        max_tokens: request.maxTokens ?? env.LLM_MAX_TOKENS,
        stream: true,
      },
      { signal: request.signal },
    );
    for await (const part of iterator) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}