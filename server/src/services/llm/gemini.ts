/**
 * Google Gemini provider via the official `@google/genai` SDK.
 *
 * Uses the streaming API for both `complete()` (collected) and `stream()`, so
 * behaviour matches the OpenAI-compatible providers.
 */
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import {
  LlmConfigurationError,
  type LlmCompletionRequest,
  type LlmProvider,
  type LlmProviderInfo,
} from './types.js';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly disabled: boolean;
  private client: GoogleGenAI | null = null;

  constructor(model: string, apiKey?: string) {
    this.model = model;
    this.apiKey = apiKey?.trim() || undefined;
    this.disabled = env.DISABLE_LLM_REMOTE;
  }

  info(): LlmProviderInfo {
    if (this.disabled) {
      return { name: this.name, model: this.model, status: 'disabled', detail: 'DISABLE_LLM_REMOTE=true (test mode).' };
    }
    if (!this.apiKey) {
      return {
        name: this.name,
        model: this.model,
        status: 'missing-credentials',
        detail: 'Set LLM_API_KEY (Google AI Studio key) to enable gemini.',
      };
    }
    return { name: this.name, model: this.model, status: 'ready', detail: 'generativelanguage.googleapis.com' };
  }

  private ensureClient(): GoogleGenAI {
    if (this.client) return this.client;
    if (this.disabled) {
      throw new LlmConfigurationError(
        `Remote LLM calls are disabled (DISABLE_LLM_REMOTE=true) but LLM_PROVIDER=gemini. ` +
          'Set LLM_PROVIDER=mock for offline development/tests.',
      );
    }
    if (!this.apiKey) {
      throw new LlmConfigurationError('No API key configured for LLM provider "gemini". Set LLM_API_KEY.');
    }
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
    return this.client;
  }

  private splitMessages(request: LlmCompletionRequest) {
    const system: string[] = [];
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    if (request.system) system.push(request.system);
    for (const m of request.messages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
    return { system: system.join('\n\n'), contents };
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    const client = this.ensureClient();
    const { system, contents } = this.splitMessages(request);
    const response = await client.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: system || undefined,
        temperature: request.temperature ?? env.LLM_TEMPERATURE,
        maxOutputTokens: request.maxTokens ?? env.LLM_MAX_TOKENS,
        abortSignal: request.signal,
      },
    });
    const text = response.text;
    if (!text) throw new LlmConfigurationError('Gemini returned an empty completion.');
    return text.trim();
  }

  async *stream(request: LlmCompletionRequest): AsyncGenerator<string, void, unknown> {
    const client = this.ensureClient();
    const { system, contents } = this.splitMessages(request);
    const stream = await client.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction: system || undefined,
        temperature: request.temperature ?? env.LLM_TEMPERATURE,
        maxOutputTokens: request.maxTokens ?? env.LLM_MAX_TOKENS,
        abortSignal: request.signal,
      },
    });
    for await (const part of stream) {
      const text = part.text;
      if (text) yield text;
    }
  }
}