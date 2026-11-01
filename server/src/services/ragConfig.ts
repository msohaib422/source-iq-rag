import { env } from '../config/env.js';

export interface RagRuntimeConfig {
  selfRagEnabled: boolean;
  cragEnabled: boolean;
  onlineEvalEnabled: boolean;
  maxRetries: number;
  correctThreshold: number;
  ambiguousThreshold: number;
}

let config: RagRuntimeConfig = {
  selfRagEnabled: env.SELF_RAG_ENABLED ?? true,
  cragEnabled: env.CRAG_ENABLED ?? true,
  onlineEvalEnabled: env.RAG_ONLINE_EVAL ?? true,
  maxRetries: env.RAG_MAX_RETRIES ?? 2,
  correctThreshold: env.RAG_CORRECT_THRESHOLD ?? 0.35,
  ambiguousThreshold: env.RAG_AMBIGUOUS_THRESHOLD ?? 0.2,
};

export function getRagConfig(): RagRuntimeConfig {
  return { ...config };
}

export function setRagConfig(patch: Partial<RagRuntimeConfig>): RagRuntimeConfig {
  config = { ...config, ...patch };
  if (config.maxRetries < 0) config.maxRetries = 0;
  if (config.maxRetries > 5) config.maxRetries = 5;
  return { ...config };
}