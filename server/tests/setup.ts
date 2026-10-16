/**
 * Vitest global setup.
 *
 * Pins the environment before any `src/` module is imported, so the config
 * module (which reads process.env at import time) sees test-safe values:
 * in-memory datastore, offline LLM provider, no remote calls.
 */
process.env.NODE_ENV = 'test';
process.env.STORE_DRIVER = 'memory';
process.env.LLM_PROVIDER = 'mock';
process.env.DISABLE_LLM_REMOTE = 'true';
process.env.JWT_SECRET = 'test-secret-for-sourceiq-suite-only-000';
process.env.EMBEDDING_CACHE_DIR = './models';
// Tests share one loaded model; keep the log quiet but visible on failure.
process.env.EMBEDDING_PRELOAD = 'false';

export {};