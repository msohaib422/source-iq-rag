/** Liveness / readiness + runtime diagnostics. */
import os from 'node:os';
import { Router } from 'express';
import { env, publicConfig, resolveStoreDriver } from '../config/env.js';
import { getContext } from '../context.js';
import { asyncHandler, currentUser, optionalAuth } from '../middleware/index.js';
import { getDiagnostics, isModelLoaded } from '../services/embeddings.js';
import { getLlmProvider } from '../services/llm/index.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';

export const healthRouter = Router();

function modelStatus() {
  const diag = getDiagnostics();
  return {
    loaded: isModelLoaded(),
    expectedModel: env.EMBEDDING_MODEL_ID,
    dimensions: env.EMBEDDING_DIMENSIONS,
    pooling: 'cls',
    normalize: true,
    queryInstruction: 'Represent this sentence for searching relevant passages: ',
    dtype: env.EMBEDDING_DTYPE,
    cacheDir: env.EMBEDDING_CACHE_DIR,
    ...(diag ? { loadMs: diag.loadMs } : {}),
  };
}

/** Cheap probe: never throws, never requires auth. Mounted at /api/health. */
healthRouter.get('/', (req, res) => {
  const config = publicConfig();
  // The process is up by definition (this handler ran). The datastore state is
  // reported honestly instead of making the API look unreachable: with Atlas
  // unreachable the status is "degraded", not a 5xx.
  const storeConnected = req.ctx.store.isConnected();
  // Keep the cached index probe fresh without blocking this cheap handler; the
  // cached value below is the last verified state (see refreshVectorIndexStatus).
  void req.ctx.store.refreshVectorIndexStatus();
  const vectorIndex = req.ctx.store.getVectorIndexStatus();
  res.json({
    status: storeConnected && vectorIndex.ready !== false ? 'ok' : 'degraded',
    service: 'sourceiq-api',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    store: {
      driver: resolveStoreDriver(env),
      dbName: env.MONGODB_DB_NAME,
      configured: Boolean(env.MONGODB_URI),
      connected: storeConnected,
    },
    vectorSearch: {
      backend: vectorIndex.backend,
      indexName: vectorIndex.indexName,
      ready: vectorIndex.ready,
      detail: vectorIndex.detail,
      checkedAt: vectorIndex.checkedAt,
    },
    embedding: modelStatus(),
    llm: { provider: config.llm.provider, model: config.llm.model, remoteCallsEnabled: config.llm.remoteCallsEnabled },
  });
});

/**
 * Deep probe: confirms the datastore is reachable, the embedding model actually
 * produces 384-dim vectors, and the LLM provider is usable. Used by the
 * end-to-end verification suite and by `GET /api/health/ready`.
 */
healthRouter.get(
  '/ready',
  asyncHandler(async (req, res) => {
    const problems: string[] = [];

    let storeStats = null;
    try {
      storeStats = await req.ctx.store.stats();
    } catch (err) {
      // Public diagnostics stay free of driver internals; full detail is logged.
      console.error('[error] GET /api/health/ready store stats failed:', err);
      problems.push('Datastore unreachable.');
    }

    // A missing/not-queryable Atlas search index breaks retrieval silently at
    // the Atlas layer, so readiness must surface it explicitly - always probe
    // fresh here (this is the deep check; /api/health uses the cached value).
    const vectorIndex = await req.ctx.store.refreshVectorIndexStatus(true);
    if (vectorIndex.ready === false) {
      problems.push(`Vector search is unavailable: ${vectorIndex.detail}`);
    }

    let embeddingProbe: Record<string, unknown> | null = null;
    try {
      const { embedQuery } = await import('../services/embeddings.js');
      const vector = await embedQuery('SourceIQ readiness probe');
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      embeddingProbe = {
        dimensions: vector.length,
        expectedDimensions: env.EMBEDDING_DIMENSIONS,
        l2Norm: Number(norm.toFixed(6)),
        finite: vector.every((v) => Number.isFinite(v)),
      };
      if (vector.length !== env.EMBEDDING_DIMENSIONS) {
        problems.push(`Embedding dimension is ${vector.length}, expected ${env.EMBEDDING_DIMENSIONS}.`);
      }
    } catch (err) {
      problems.push(`Embedding model failed to load: ${(err as Error).message}`);
    }

    const provider = getLlmProvider();
    const llmInfo = provider.info();

    res.status(problems.length ? 503 : 200).json({
      status: problems.length ? 'degraded' : 'ready',
      problems,
      embedding: { ...modelStatus(), probe: embeddingProbe },
      llm: llmInfo,
      store: storeStats ? { driver: req.ctx.store.driver, ...storeStats } : null,
      vectorSearch: {
        backend: vectorIndex.backend,
        indexName: vectorIndex.indexName,
        ready: vectorIndex.ready,
        detail: vectorIndex.detail,
        checkedAt: vectorIndex.checkedAt,
      },
      runtime: {
        node: process.version,
        platform: `${os.type()} ${os.release()}`,
        rssMB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
        heapUsedMB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
      },
    });
  }),
);

/** Workspace stats for the dashboard: anonymous visitors and the admin alike. */
healthRouter.get(
  '/me/stats',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // Documents/chunks describe the shared knowledge base, which anonymous
    // visitors and the admin both address.
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, user);
    const documents = await req.ctx.store.listDocuments(kbId);
    res.json({
      documents: documents.length,
      chunks: documents.reduce((sum, d) => sum + d.chunkCount, 0),
      pages: documents.reduce((sum, d) => sum + d.pageCount, 0),
      ready: documents.filter((d) => d.status === 'ready').length,
      failed: documents.filter((d) => d.status === 'failed').length,
    });
  }),
);

export { getContext };