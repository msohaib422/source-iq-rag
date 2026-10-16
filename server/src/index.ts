#!/usr/bin/env node
/**
 * Server bootstrap.
 *
 * Order matters:
 *   1. load + validate env (fails fast)
 *   2. connect datastore (Atlas or in-memory)
 *   3. load the embedding model into the project-local cache
 *   4. start listening
 *
 * If the model cannot load we exit non-zero when STRICT_EMBEDDINGS=true rather
 * than starting a server that would fail every request. There is no fallback to
 * a different model.
 */
import { createApp } from './app.js';
import { env, isProd, resolveStoreDriver, SERVER_ROOT } from './config/env.js';
import { getContext } from './context.js';
import type { Store } from './db/store.js';
import { ensureAdminUser } from './services/accounts.js';
import { getDiagnostics, loadEmbeddingModel } from './services/embeddings.js';
import { getLlmProvider } from './services/llm/index.js';

const banner = (lines: string[]) => {
  console.log(lines.join('\n'));
  console.log('');
};

const STORE_RETRY_MS = 30_000;

/**
 * Connect the datastore without making the API hostage to it.
 *
 * A database outage used to abort boot, so the whole API appeared down and the
 * dashboard showed "API unreachable" for what was really a connectivity
 * problem. Instead: start listening, report the real state on `/api/health`
 * ("degraded", `store.connected: false`), answer datastore-backed requests
 * with 503, and keep retrying in the background.
 */
async function initStore(store: Store): Promise<boolean> {
  try {
    await store.init();
    return true;
  } catch (err) {
    console.error(`  ✗ datastore unavailable: ${(err as Error).message}`);
    console.error('    Starting the API anyway - /api/health reports "degraded" and');
    console.error('    datastore-backed routes answer 503 until the connection recovers.');
    return false;
  }
}

/** Retry the connection periodically so a transient outage heals without a restart. */
function scheduleStoreRetry(store: Store): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        await store.init();
        if (env.BOOTSTRAP_ADMIN) {
          const admin = await ensureAdminUser(store);
          if (admin.created) console.log(`  ✓ admin account created (${admin.email})`);
        }
        console.log('  ✓ datastore connection recovered');
        const vectorIndex = await store.refreshVectorIndexStatus(true);
        if (vectorIndex.ready !== true) {
          console.warn(`  ! vector index "${env.VECTOR_INDEX_NAME}" is not ready: ${vectorIndex.detail}`);
        }
        clearInterval(timer);
      } catch {
        // Still unreachable; the next tick retries.
      }
    })();
  }, STORE_RETRY_MS);
  timer.unref();
}

async function main(): Promise<void> {
  const ctx = getContext();
  const driver = resolveStoreDriver(env);

  banner([
    '  ┌───────────────────────────────────────────────┐',
    '  │  SourceIQ API                                 │',
    '  └───────────────────────────────────────────────┘',
  ]);

  // 1. Datastore ---------------------------------------------------------
  if (driver === 'atlas') {
    console.log(`▸ Connecting to MongoDB Atlas (db: ${env.MONGODB_DB_NAME}) …`);
    if (await initStore(ctx.store)) {
      // Verify the actual search index - Atlas returns empty results (not an
      // error) when it is missing, so a config-only "✓" would be misleading.
      const vectorIndex = await ctx.store.refreshVectorIndexStatus(true);
      if (vectorIndex.ready === true) {
        console.log(
          `  ✓ connected · vector index "${env.VECTOR_INDEX_NAME}" verified (${env.EMBEDDING_DIMENSIONS} dims, cosine)`,
        );
      } else if (vectorIndex.ready === false) {
        console.warn(`  ! connected, but vector search cannot work: ${vectorIndex.detail}`);
        console.warn('    Retrieval will report the outage until the index is created (npm run atlas:index).');
      } else {
        console.warn(`  ! connected · could not verify vector index "${env.VECTOR_INDEX_NAME}": ${vectorIndex.detail}`);
      }
    } else {
      scheduleStoreRetry(ctx.store);
    }
  } else {
    console.log('▸ No MONGODB_URI configured - using the in-memory datastore.');
    console.log('  Set MONGODB_URI in server/.env to switch to MongoDB Atlas.');
    await ctx.store.init();
  }

  // 1b. Admin account ----------------------------------------------------
  // Authentication is admin-only: there is no public registration, so the
  // single admin account is provisioned from the environment on first boot.
  // Skipped while the datastore is unreachable; the retry provisions it as
  // soon as the connection recovers.
  if (env.BOOTSTRAP_ADMIN && ctx.store.isConnected()) {
    const admin = await ensureAdminUser(ctx.store);
    if (admin.created) {
      console.log(`  ✓ admin account created (${admin.email})`);
    } else if (admin.existingRole && admin.existingRole !== 'admin') {
      console.warn(
        `  ! ${admin.email} already exists but is not an admin; sign-in will be rejected. ` +
          'Point ADMIN_EMAIL at a different address or fix the account role.',
      );
    } else {
      console.log(`  ✓ admin account ready (${admin.email})`);
    }
  }

  // 2. Embedding model ----------------------------------------------------
  if (env.EMBEDDING_PRELOAD) {
    console.log(`▸ Loading ${env.EMBEDDING_MODEL_ID} (local inference, ${env.EMBEDDING_DTYPE}) …`);
    const started = Date.now();
    try {
      await loadEmbeddingModel((info) => {
        if (info.status === 'initiate' || info.status === 'done') {
          console.log(`  · ${info.status} ${info.file ?? ''}`);
        }
      });
      const diag = getDiagnostics();
      console.log(
        `  ✓ model ready in ${Date.now() - started}ms · ${diag?.dimensions} dims · CLS pooling · L2 normalised`,
      );
    } catch (err) {
      console.error(`\n✗ ${(err as Error).message}\n`);
      if (env.STRICT_EMBEDDINGS) {
        console.error('Refusing to start: STRICT_EMBEDDINGS=true and the embedding model is unavailable.');
        await ctx.store.close();
        process.exit(1);
      }
      console.error('Continuing without the model (STRICT_EMBEDDINGS=false). RAG requests will fail.');
    }
  }

  // 3. LLM ---------------------------------------------------------------
  const provider = getLlmProvider();
  const info = provider.info();
  const statusIcon = info.status === 'ready' ? '✓' : '!';
  console.log(`  ${statusIcon} LLM: ${info.name} / ${info.model} — ${info.status}${info.detail ? ` (${info.detail})` : ''}`);

  // 4. Listen ------------------------------------------------------------
  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () => {
    banner([
      `  SourceIQ API listening on http://localhost:${env.PORT}`,
      `  Environment      ${env.NODE_ENV}`,
      `  Datastore        ${driver}`,
      `  Embeddings       ${env.EMBEDDING_MODEL_ID} (${env.EMBEDDING_DIMENSIONS}d, local)`,
      `  Model cache      ${env.EMBEDDING_CACHE_DIR}`,
      `  Health           http://localhost:${env.PORT}/api/health`,
      `  Readiness        http://localhost:${env.PORT}/api/health/ready`,
    ]);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n▸ ${signal} received, shutting down …`);
    server.close(async () => {
      await ctx.store.close();
      process.exit(0);
    });
    // Don't hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    if (isProd) void shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  console.error('✗ Failed to start SourceIQ API:', err);
  process.exit(1);
});

export { SERVER_ROOT };