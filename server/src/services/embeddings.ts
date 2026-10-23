/**
 * Local embedding pipeline for BAAI/bge-small-en-v1.5.
 *
 * ---------------------------------------------------------------------------
 * Why this is hand-rolled instead of `pipeline('feature-extraction')`
 * ---------------------------------------------------------------------------
 * Transformers.js' generic feature-extraction pipeline applies **mean**
 * pooling. BAAI/bge-* models are trained with **CLS** pooling:
 *
 *     1_Pooling/config.json
 *       { "pooling_mode_cls_token": true, "pooling_mode_mean_tokens": false,
 *         "word_embedding_dimension": 384 }
 *
 * Using mean pooling would produce vectors that differ from the reference
 * sentence-transformers implementation and measurably degrade retrieval. So we
 * load the tokenizer + model directly, take the `[CLS]` token of the last
 * hidden state, and L2-normalise - exactly what `sentence_transformers` does for
 * this checkpoint.
 *
 * ---------------------------------------------------------------------------
 * Query vs. document preprocessing
 * ---------------------------------------------------------------------------
 * The BGE v1.5 model card specifies a retrieval instruction that is prepended
 * to *queries only* (never to the passages being indexed):
 *
 *     "Represent this sentence for searching relevant passages: "
 *
 * `embedQuery()` applies it; `embedDocuments()` does not. Both share the same
 * tokenizer, truncation (512 tokens) and CLS+normalise post-processing.
 *
 * ---------------------------------------------------------------------------
 * Model identity is mandatory
 * ---------------------------------------------------------------------------
 * BAAI/bge-small-en-v1.5 is a hard requirement of this project. The loader
 * verifies the resolved model's hidden size against the configured dimension
 * and refuses to start on mismatch. A different model id may be supplied via
 * EMBEDDING_MODEL_ID, but that produces a loud, explicit console warning - it is
 * never a silent fallback.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { env as hfEnv, AutoModel, AutoTokenizer } from '@huggingface/transformers';
import { env } from '../config/env.js';

// Silence the noisy, harmless warning Transformers.js emits while streaming a
// file whose response lacks a Content-Length header. The download still
// completes; the message only clutters boot output ("come again and again").
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  if (msg.includes('Unable to determine content-length from response headers')) return;
  originalWarn(...args);
};

export const EMBEDDING_DIMENSIONS = env.EMBEDDING_DIMENSIONS;
export const MODEL_ID = env.EMBEDDING_MODEL_ID;
export const CACHE_DIR = path.resolve(env.EMBEDDING_CACHE_DIR);

/** Instruction prepended to queries only, per the BGE v1.5 model card. */
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

type ProgressFn = (info: { status: string; file?: string; progress?: number }) => void;

let tokenizerPromise: Promise<unknown> | null = null;
let modelPromise: Promise<unknown> | null = null;
let loadDiagnostics: LoadDiagnostics | null = null;

export interface LoadDiagnostics {
  modelId: string;
  dtype: string;
  dimensions: number;
  maxTokens: number;
  pooling: 'cls';
  normalize: true;
  queryInstruction: string;
  cacheDir: string;
  loadMs: number;
  parameterCount?: number;
}

function configureHfEnv() {
  // Project-local cache: weights land in server/models/... and are gitignored.
  hfEnv.cacheDir = CACHE_DIR;
  // Never silently load a different local checkpoint that happens to exist.
  hfEnv.allowLocalModels = false;
  // We provide the tokenizer ourselves; do not also try to load tokenizer.json
  // from a `./tokenizer.json` path relative to the server root.
  if (hfEnv.backends?.onnx?.wasm) {
    hfEnv.backends.onnx.wasm.numThreads = 1;
  }
}

/**
 * Download (or read from the project-local cache) and instantiate the model.
 * Safe to call repeatedly: the underlying promise is memoised so weights are
 * loaded exactly once per process.
 */
/** Absolute path of the cached ONNX weights for this model id. */
export function modelOnnxPath(): string {
  return path.join(CACHE_DIR, ...MODEL_ID.split('/'), 'onnx', 'model.onnx');
}

/** Minimum plausible size (bytes) for a complete bge-small ONNX file. */
const MIN_MODEL_BYTES = 100 * 1024 * 1024;

/** Remove a partial/corrupt cached model file so it can be re-fetched. */
async function invalidateModelCache(): Promise<void> {
  const p = modelOnnxPath();
  try {
    await fs.unlink(p);
  } catch {
    // File may not exist; nothing to do.
  }
}

/** Delete the cached file if it is missing or implausibly small. */
export async function ensureModelFileHealthy(): Promise<void> {
  const p = modelOnnxPath();
  try {
    const stat = await fs.stat(p);
    if (stat.size < MIN_MODEL_BYTES) {
      await fs.unlink(p);
    }
  } catch {
    // Missing file is fine - Transformers.js will download it.
  }
}

export async function loadEmbeddingModel(onProgress?: ProgressFn): Promise<void> {
  await ensureModelFileHealthy();
  try {
    await getTokenizer(onProgress);
    await getModel(onProgress);
  } catch (err) {
    // A corrupt/partial cache entry is the usual cause of "Protobuf parsing
    // failed" on every boot. Drop it and retry the load once.
    await invalidateModelCache();
    _resetEmbeddingCache();
    await ensureModelFileHealthy();
    await getTokenizer(onProgress);
    await getModel(onProgress);
  }
}

async function getTokenizer(onProgress?: ProgressFn) {
  if (!tokenizerPromise) {
    configureHfEnv();
    tokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback: makeProgressLogger('tokenizer', onProgress),
    }).catch((err) => {
      tokenizerPromise = null;
      throw wrapLoadError(err);
    });
  }
  return tokenizerPromise;
}

async function getModel(onProgress?: ProgressFn) {
  if (!modelPromise) {
    configureHfEnv();
    const started = Date.now();
    modelPromise = AutoModel.from_pretrained(MODEL_ID, {
      // bge-small-en-v1.5 publishes only onnx/model.onnx (fp32). There is no
      // quantised variant for this checkpoint, so fp32 is the correct choice.
      dtype: env.EMBEDDING_DTYPE as 'fp32',
      progress_callback: makeProgressLogger('model', onProgress),
    })
      .then((model) => {
        validateHiddenSize(model);
        loadDiagnostics = {
          modelId: MODEL_ID,
          dtype: env.EMBEDDING_DTYPE,
          dimensions: EMBEDDING_DIMENSIONS,
          maxTokens: env.EMBEDDING_MAX_TOKENS,
          pooling: 'cls',
          normalize: true,
          queryInstruction: QUERY_INSTRUCTION,
          cacheDir: CACHE_DIR,
          loadMs: Date.now() - started,
        };
        return model;
      })
      .catch((err) => {
        modelPromise = null;
        throw wrapLoadError(err);
      });
  }
  return modelPromise;
}

/** Surface actionable errors instead of opaque ONNX/network failures. */
function wrapLoadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const hint =
    `Failed to load the local embedding model "${MODEL_ID}".\n` +
    `  * Model is required to be BAAI/bge-small-en-v1.5 (384 dims, CLS pooling).\n` +
    `  * Check the cache directory is writable: ${CACHE_DIR}\n` +
    `  * Run "npm run model:download" to fetch the ONNX weights, or\n` +
    `    "npm run model:verify" for a full end-to-end embedding check.\n` +
    `  * Underlying error: ${message}`;
  return new Error(hint, { cause: err });
}

function validateHiddenSize(model: unknown): void {
  const cfg = (model as { config?: { hidden_size?: number; model_type?: string } }).config;
  const hidden = cfg?.hidden_size;
  if (typeof hidden === 'number' && hidden !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: "${MODEL_ID}" reports hidden_size=${hidden} but ` +
        `EMBEDDING_DIMENSIONS is ${EMBEDDING_DIMENSIONS}. ` +
        `Update EMBEDDING_DIMENSIONS and the Atlas Vector Search index definition to match.`,
    );
  }
}

function makeProgressLogger(label: string, onProgress?: ProgressFn) {
  const seen = new Map<string, number>();
  return (info: unknown) => {
    const i = info as { status?: string; file?: string; progress?: number; loaded?: number; total?: number };
    if (!i?.status) return;
    const key = i.file ?? '';
    // Throttle: log only on meaningful state changes to keep boot output readable.
    const prev = seen.get(key) ?? -1;
    const pct = typeof i.progress === 'number' ? i.progress : prev;
    if (pct === prev && i.status !== 'done' && i.status !== 'ready' && i.status !== 'initiate') {
      return;
    }
    seen.set(key, pct);
    onProgress?.({ status: i.status, ...(i.file ? { file: i.file } : {}), progress: i.progress });
  };
}

interface TensorLike {
  data: ArrayLike<number> | Float32Array;
  dims: readonly number[];
}

function clsPool(lastHiddenState: TensorLike, batchSize: number): Float32Array {
  const [, seqLen, hidden] = lastHiddenState.dims;
  if (!seqLen || !hidden) throw new Error(`Unexpected last_hidden_state dims: [${lastHiddenState.dims.join(', ')}]`);
  const stride = seqLen * hidden;
  const out = new Float32Array(batchSize * hidden);
  for (let b = 0; b < batchSize; b += 1) {
    const base = b * stride; // position 0 == [CLS]
    for (let d = 0; d < hidden; d += 1) out[b * hidden + d] = lastHiddenState.data[base + d] as number;
  }
  return out;
}

/** L2-normalise in place-ish; returns unit-length rows. */
function l2Normalize(matrix: Float32Array, rows: number, cols: number): void {
  for (let r = 0; r < rows; r += 1) {
    let sum = 0;
    for (let c = 0; c < cols; c += 1) {
      const v = matrix[r * cols + c] as number;
      sum += v * v;
    }
    const norm = Math.sqrt(sum);
    if (norm > 0) {
      for (let c = 0; c < cols; c += 1) matrix[r * cols + c] = (matrix[r * cols + c] as number) / norm;
    }
  }
}

function toPlainVector(matrix: Float32Array, row: number, cols: number): number[] {
  const vec = Array.from(matrix.subarray(row * cols, row * cols + cols));
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new Error('Embedding produced a non-finite value.');
  }
  return vec;
}

/**
 * Core encoder. Batches internally to bound peak memory and is safe to call
 * concurrently (model inference is synchronous under the hood).
 */
async function encode(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
  const cleaned = texts.map((t) => (typeof t === 'string' ? t : String(t ?? '')));
  if (cleaned.length === 0) return [];

  const blank = cleaned.map((t) => t.trim().length === 0);
  const inputs = kind === 'query' ? cleaned.map((t) => QUERY_INSTRUCTION + t) : cleaned;

  await loadEmbeddingModel();
  const tokenizer = (await getTokenizer()) as {
    (...args: unknown[]): Promise<Record<string, unknown>>;
  };

  const model = (await getModel()) as { (...args: unknown[]): Promise<{ last_hidden_state: TensorLike }> };

  const batchSize = env.EMBEDDING_BATCH_SIZE;
  const vectors: number[][] = [];

  for (let start = 0; start < inputs.length; start += batchSize) {
    const slice = inputs.slice(start, start + batchSize);
    const encoded = (await tokenizer(slice, {
      padding: true,
      truncation: true,
      max_length: env.EMBEDDING_MAX_TOKENS,
    })) as Record<string, unknown>;

    const output = await model(encoded);
    const hidden = output.last_hidden_state;
    const hiddenSize = hidden.dims[2] as number;
    const pooled = clsPool(hidden, hidden.dims[0] as number);
    l2Normalize(pooled, hidden.dims[0] as number, hiddenSize);

    for (let i = 0; i < slice.length; i += 1) {
      const originalIndex = start + i;
      vectors[originalIndex] = blank[originalIndex] ? new Array(hiddenSize).fill(0) : toPlainVector(pooled, i, hiddenSize);
    }
  }

  return vectors;
}

/** Embed a single user question. Applies the BGE retrieval instruction. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await encode([text], 'query');
  if (!vec) throw new Error('Embedding the query produced no vector.');
  return vec;
}

/** Embed a batch of document chunks. No instruction prefix. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return encode(texts, 'document');
}

export function isModelLoaded(): boolean {
  return loadDiagnostics !== null;
}

export function getDiagnostics(): LoadDiagnostics | null {
  return loadDiagnostics;
}

/** Cosine similarity for two equal-length vectors (both assumed L2-normalised). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

/**
 * Test seam: forget the memoised model. Used between tests so each suite can
 * assert cold-start behaviour. Never called in production code paths.
 */
export function _resetEmbeddingCache(): void {
  tokenizerPromise = null;
  modelPromise = null;
  loadDiagnostics = null;
}

/** Exposed for the download/verify scripts. */
export function hfEnvironment() {
  configureHfEnv();
  return { cacheDir: hfEnv.cacheDir, allowLocalModels: hfEnv.allowLocalModels, modelId: MODEL_ID };
}