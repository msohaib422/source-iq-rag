/**
 * Central, validated runtime configuration.
 *
 * Every environment variable the server reads is declared here exactly once so
 * that (a) `.env.example` can be generated from the same source of truth and
 * (b) misconfiguration fails fast at boot with an actionable message instead of
 * surfacing as a confusing runtime error deep in a request handler.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config -> src -> server
export const SERVER_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// ---------------------------------------------------------------------------
// Load server/.env before anything reads process.env.
//
// The path is resolved from SERVER_ROOT (not process.cwd()) so it works whether
// you run `npm run dev` from the repo root or from server/, and whether you run
// the TypeScript sources (tsx) or the compiled output (dist/). Variables already
// present in the environment always win, so shell/CI overrides still work.
// ---------------------------------------------------------------------------
export const ENV_FILE = path.join(SERVER_ROOT, '.env');
try {
  loadDotenvFile({ path: ENV_FILE, quiet: true });
} catch {
  // A missing .env is legitimate (defaults are usable); parseEnv handles the
  // result either way.
}

const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  HOST: z.string().default('0.0.0.0'),

  // Comma separated list of origins allowed to call the API.
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  // JWT signing secret. Required outside development/test.
  JWT_SECRET: z.string().min(16).default('sourceiq-dev-only-insecure-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // ---- Admin-only authentication ----
  // There is no public registration: the single admin account is provisioned
  // from these values on first boot (services/accounts.ts) when BOOTSTRAP_ADMIN
  // is true. Regular users need no account and are served anonymously.
  BOOTSTRAP_ADMIN: boolish(true),
  ADMIN_EMAIL: z.string().trim().toLowerCase().email('ADMIN_EMAIL must be a valid email address.').default('admin@gmail.com'),
  ADMIN_PASSWORD: z
    .string()
    .min(8, 'ADMIN_PASSWORD must be at least 8 characters.')
    .max(128, 'ADMIN_PASSWORD must be at most 128 characters.')
    .default('12345678'),
  ADMIN_NAME: z.string().trim().min(2).max(80).default('Administrator'),

  // Datastore selection.
  //   atlas  -> real MongoDB Atlas (requires MONGODB_URI)
  //   memory -> in-process datastore, used by the automated test-suite and for
  //             local development when Atlas credentials are not configured.
  STORE_DRIVER: z.enum(['atlas', 'memory']).optional(),
  MONGODB_URI: z.string().optional(),
  MONGODB_DB_NAME: z.string().default('sourceiq'),

  // ---- Embedding model (BAAI/bge-small-en-v1.5, run locally) ----
  EMBEDDING_MODEL_ID: z.string().default('BAAI/bge-small-en-v1.5'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
  // bge-small-en-v1.5 only ships onnx/model.onnx (fp32). We intentionally do not
  // substitute another model or another quantisation variant.
  EMBEDDING_DTYPE: z.string().default('fp32'),
  // Project-local cache directory for the downloaded ONNX weights.
  EMBEDDING_CACHE_DIR: z.string().default(path.join(SERVER_ROOT, 'models')),
  EMBEDDING_MAX_TOKENS: z.coerce.number().int().positive().default(512),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(16),
  // Preload weights during boot instead of lazily on the first request.
  EMBEDDING_PRELOAD: boolish(true),

  // ---- Chunking ----
  CHUNK_SIZE: z.coerce.number().int().positive().default(900),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),

  // ---- Vector search ----
  VECTOR_INDEX_NAME: z.string().default('vector_index'),
  VECTOR_NUM_CANDIDATES: z.coerce.number().int().positive().default(150),
  VECTOR_LIMIT: z.coerce.number().int().positive().default(8),

  // ---- LLM providers ----
  LLM_PROVIDER: z.enum(['groq', 'mistral', 'openrouter', 'openai', 'gemini', 'mock']).default('mock'),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(900),

  // ---- Uploads ----
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
  UPLOAD_DIR: z.string().default(path.join(SERVER_ROOT, 'uploads')),

  // When true the server refuses to start if the embedding model cannot load.
  STRICT_EMBEDDINGS: boolish(true),

  // Set by the test-suite to use deterministic, network-free behaviour.
  DISABLE_LLM_REMOTE: boolish(false),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Edit ${ENV_FILE} (see server/.env.example). Note that variables already present in the ` +
        `shell environment take precedence over that file.`,
    );
  }
  const env = parsed.data;

  // Resolve relative directories against SERVER_ROOT (not process.cwd()), so the
  // same config works whether you run `npm run dev` from the repo root or from
  // server/. The project-local model cache must always land in server/models.
  env.EMBEDDING_CACHE_DIR = path.resolve(SERVER_ROOT, env.EMBEDDING_CACHE_DIR);
  env.UPLOAD_DIR = path.resolve(SERVER_ROOT, env.UPLOAD_DIR);

  if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('sourceiq-dev-only')) {
    throw new Error(
      'JWT_SECRET still holds the development placeholder. Set a strong secret before running in production.',
    );
  }

  if (
    env.NODE_ENV === 'production' &&
    env.BOOTSTRAP_ADMIN &&
    env.ADMIN_PASSWORD === '12345678'
  ) {
    throw new Error(
      'ADMIN_PASSWORD is still the built-in default. Set a different admin password before running in production.',
    );
  }

  if (env.CHUNK_OVERLAP >= env.CHUNK_SIZE) {
    throw new Error(
      `CHUNK_OVERLAP (${env.CHUNK_OVERLAP}) must be smaller than CHUNK_SIZE (${env.CHUNK_SIZE}).`,
    );
  }

  return env;
}

export const env: Env = loadEnv();

export const isTest = env.NODE_ENV === 'test';
export const isProd = env.NODE_ENV === 'production';

/** Resolve the datastore driver: explicit STORE_DRIVER wins, otherwise Atlas when a URI is present. */
export function resolveStoreDriver(e: Env = env): 'atlas' | 'memory' {
  if (e.STORE_DRIVER) return e.STORE_DRIVER;
  if (e.MONGODB_URI && e.MONGODB_URI.trim().length > 0) return 'atlas';
  return 'memory';
}

/** Public (non-secret) configuration safe to expose on /api/health. */
export function publicConfig(e: Env = env) {
  return {
    embedding: {
      modelId: e.EMBEDDING_MODEL_ID,
      dimensions: e.EMBEDDING_DIMENSIONS,
      dtype: e.EMBEDDING_DTYPE,
      cacheDir: path.relative(REPO_ROOT, path.resolve(e.EMBEDDING_CACHE_DIR)) || e.EMBEDDING_CACHE_DIR,
      maxTokens: e.EMBEDDING_MAX_TOKENS,
      pooling: 'cls',
      normalize: true,
      queryInstruction:
        'Represent this sentence for searching relevant passages: ',
    },
    chunking: { size: e.CHUNK_SIZE, overlap: e.CHUNK_OVERLAP },
    vectorSearch: { index: e.VECTOR_INDEX_NAME, numCandidates: e.VECTOR_NUM_CANDIDATES, limit: e.VECTOR_LIMIT },
    llm: {
      provider: e.LLM_PROVIDER,
      model: resolveLlmModel(e),
      remoteCallsEnabled: e.LLM_PROVIDER !== 'mock' && !e.DISABLE_LLM_REMOTE,
    },
    store: { driver: resolveStoreDriver(e), dbName: resolveDbName(e) },
  };
}

function resolveDbName(e: Env): string {
  return e.MONGODB_DB_NAME;
}

/**
 * Per-provider default models. Kept here so the health endpoint can advertise
 * exactly which model will be used without any secret leaking.
 */
const LLM_DEFAULT_MODELS: Record<string, string> = {
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-small-latest',
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  mock: 'extractive-mock-v1',
};

export function resolveLlmModel(e: Env = env): string {
  return e.LLM_MODEL?.trim() || LLM_DEFAULT_MODELS[e.LLM_PROVIDER] || 'unknown';
}