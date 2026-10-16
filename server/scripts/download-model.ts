#!/usr/bin/env node
/**
 * Download the embedding model into the project-local cache.
 *
 *   npm run model:download
 *
 * SourceIQ runs BAAI/bge-small-en-v1.5 locally through Transformers.js + ONNX
 * Runtime. This script pre-fetches the weights into server/models/ so the first
 * server boot does not need the network.
 *
 * Storage: the checkpoint publishes only `onnx/model.onnx` (fp32, ~133 MB). No
 * quantised variant exists for this model, so ~133 MB plus the ~0.7 MB
 * tokenizer is what lands on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { hfEnvironment } from '../src/services/embeddings.js';

const { cacheDir, modelId } = hfEnvironment();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(path.join(entry.parentPath ?? dir, entry.name));
      total += stat.size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

async function main(): Promise<void> {
  console.log('');
  console.log('  SourceIQ — embedding model download');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  Model        ${modelId}`);
  console.log(`  Runtime      @huggingface/transformers (ONNX Runtime, local)`);
  console.log(`  Precision    ${env.EMBEDDING_DTYPE}`);
  console.log(`  Dimensions   ${env.EMBEDDING_DIMENSIONS}`);
  console.log(`  Cache dir    ${cacheDir}`);
  console.log('');

  await fs.mkdir(cacheDir, { recursive: true });

  const before = await directorySize(cacheDir);
  console.log('  ▸ Fetching weights from huggingface.co (first run downloads ~133 MB) …\n');

  const { loadEmbeddingModel, getDiagnostics } = await import('../src/services/embeddings.js');
  const started = Date.now();

  const lastByFile = new Map<string, number>();
  await loadEmbeddingModel((info) => {
    if (!info.file) return;
    if (info.status === 'progress') {
      const pct = Math.round(info.progress ?? 0);
      if (pct % 20 === 0 && lastByFile.get(info.file) !== pct) {
        lastByFile.set(info.file, pct);
        process.stdout.write(`    ${info.file} … ${pct}%\n`);
      }
    } else if (info.status === 'done') {
      process.stdout.write(`    ${info.file} ✓\n`);
    }
  });

  const after = await directorySize(cacheDir);
  const diag = getDiagnostics();

  console.log('');
  console.log('  ✓ Model ready');
  console.log(`    Loaded in   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`    Dimensions  ${diag?.dimensions}`);
  console.log(`    Pooling     CLS + L2 normalisation (matches sentence-transformers)`);
  console.log(`    Disk used   ${formatBytes(after)} (cache directory)`);
  if (after > before) console.log(`    Added       ${formatBytes(after - before)}`);
  console.log('');
  console.log('  Next: npm run model:verify   # end-to-end embedding sanity check');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('  ✗ Model download failed');
  console.error(`    ${(err as Error).message}`);
  console.error('');
  console.error('  Checklist:');
  console.error('    • Network access to https://huggingface.co');
  console.error(`    • Writable cache directory: ${cacheDir}`);
  console.error('    • Free disk space (~150 MB)');
  console.error('    • Native ONNX Runtime: npm rebuild onnxruntime-node --workspace server');
  console.error('');
  process.exit(1);
});