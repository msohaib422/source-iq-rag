/**
 * LLM provider factory.
 *
 * SourceIQ supports several hosted providers behind one interface. Select with
 * `LLM_PROVIDER` and supply `LLM_API_KEY`; `LLM_MODEL` and `LLM_BASE_URL`
 * override the defaults when a specific model or a self-hosted
 * OpenAI-compatible gateway is required.
 */
import { env, resolveLlmModel } from '../../config/env.js';
import { GeminiProvider } from './gemini.js';
import { MockExtractiveProvider } from './mock.js';
import { OpenAiCompatibleProvider } from './openaiCompatible.js';
import type { LlmProvider } from './types.js';

const PROVIDERS: Record<
  string,
  { label: string; defaultBaseUrl: string; apiKeyEnvHint: string }
> = {
  groq: {
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvHint: 'GROQ_API_KEY',
  },
  mistral: {
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvHint: 'MISTRAL_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvHint: 'OPENROUTER_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnvHint: 'OPENAI_API_KEY',
  },
};

/** Per-provider env var fallbacks, so users can drop in their usual key name. */
const API_KEY_FALLBACKS: Record<string, string[]> = {
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

function resolveApiKey(provider: string): string | undefined {
  const candidates = API_KEY_FALLBACKS[provider] ?? [];
  for (const name of candidates) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return env.LLM_API_KEY?.trim() || undefined;
}

let cached: LlmProvider | null = null;

export function createLlmProvider(): LlmProvider {
  const provider = env.LLM_PROVIDER;
  const model = resolveLlmModel();

  if (provider === 'mock') return new MockExtractiveProvider();
  if (provider === 'gemini') return new GeminiProvider(model, resolveApiKey('gemini'));

  const meta = PROVIDERS[provider];
  if (!meta) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Supported: ${[...Object.keys(PROVIDERS), 'gemini', 'mock'].join(', ')}.`,
    );
  }

  return new OpenAiCompatibleProvider({
    name: provider,
    model,
    defaultBaseUrl: meta.defaultBaseUrl,
    apiKeyEnvHint: meta.apiKeyEnvHint,
    apiKey: resolveApiKey(provider),
    baseUrl: env.LLM_BASE_URL,
  });
}

/** Memoised provider used by the request handlers. */
export function getLlmProvider(): LlmProvider {
  if (!cached) cached = createLlmProvider();
  return cached;
}

export function resetLlmProvider(): void {
  cached = null;
}

export type { LlmProvider, LlmCompletionRequest, LlmProviderInfo } from './types.js';