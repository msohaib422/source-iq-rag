#!/usr/bin/env node
/**
 * Report what the local embedding model configuration looks like and whether the
 * weights are already present in the project-local cache.
 *
 *   npm run model:info
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, publicConfig, resolveStoreDriver } from '../src/config/env.js';
import { hfEnvironment } from '../src/services/embeddings.js';

const { cacheDir, modelId } = hfEnvironment();

async function walk(dir: string): Promise<Array<{ file: string; size: number }>> {
  const out: Array<{ file: string; size: number }> = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? dir, entry.name);
    try {
      const stat = await fs.stat(full);
      out.push({ file: path.relative(dir, full), size: stat.size });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

async function main(): Promise<void> {
  const config = publicConfig();
  const files = await walk(cacheDir);
  const total = files.reduce((s, f) => s + f.size, 0);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  console.log('');
  console.log('  SourceIQ — embedding model status');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  Model id            ${modelId}`);
  console.log(`  Required            BAAI/bge-small-en-v1.5 ${modelId === 'BAAI/bge-small-en-v1.5' ? '✓' : '✗ OVERRIDDEN'}`);
  console.log(`  Dimensions          ${config.embedding.dimensions}`);
  console.log(`  Pooling             ${config.embedding.pooling} (BGE v1.5 uses CLS, not mean)`);
  console.log(`  Normalisation       L2`);
  console.log(`  Max tokens          ${config.embedding.maxTokens}`);
  console.log(`  Precision           ${config.embedding.dtype}`);
  console.log(`  Query instruction   "${config.embedding.queryInstruction}"`);
  console.log(`  Chunking            ${config.chunking.size} chars, ${config.chunking.overlap} overlap`);
  console.log(`  Vector index        ${config.vectorSearch.index} (numCandidates=${config.vectorSearch.numCandidates}, limit=${config.vectorSearch.limit})`);
  console.log('');
  console.log(`  Cache directory     ${cacheDir}`);
  console.log(`  Cached files        ${files.length}`);
  console.log(`  Disk usage          ${mb(total)}`);

  if (files.length) {
    console.log('');
    console.log('  Largest artifacts:');
    for (const f of files.slice(0, 6)) {
      console.log(`    ${mb(f.size).padStart(10)}  ${f.file}`);
    }
  } else {
    console.log('');
    console.log('  ! No cached artifacts yet. Run: npm run model:download');
  }

  console.log('');
  console.log(`  Datastore driver    ${resolveStoreDriver(env)}`);
  console.log(`  Vector backend      ${config.store.driver === 'atlas' ? 'Atlas Vector Search ($vectorSearch)' : 'in-memory cosine (set MONGODB_URI for Atlas)'}`);
  console.log(`  LLM provider        ${config.llm.provider} / ${config.llm.model}`);
  console.log('');
  process.exit(files.length ? 0 : 1);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});