/**
 * Embedding pipeline tests — the mandated BAAI/bge-small-en-v1.5 contract.
 *
 * These exercise the real local model (no mocks): shape, normalisation, query
 * instruction handling, batching and truncation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  MODEL_ID,
  QUERY_INSTRUCTION,
  cosineSimilarity,
  embedDocuments,
  embedQuery,
  getDiagnostics,
  loadEmbeddingModel,
} from '../src/services/embeddings.js';

describe('embedding model', () => {
  beforeAll(async () => {
    await loadEmbeddingModel();
  });

  afterAll(() => {
    /* the model is intentionally kept warm for the rest of the suite */
  });

  it('is the mandated BAAI/bge-small-en-v1.5 checkpoint', () => {
    expect(MODEL_ID).toBe('BAAI/bge-small-en-v1.5');
    expect(getDiagnostics()?.modelId).toBe('BAAI/bge-small-en-v1.5');
  });

  it('reports 384 dimensions and CLS pooling with L2 normalisation', () => {
    const diag = getDiagnostics();
    expect(EMBEDDING_DIMENSIONS).toBe(384);
    expect(diag?.dimensions).toBe(384);
    expect(diag?.pooling).toBe('cls');
    expect(diag?.normalize).toBe(true);
  });

  it('produces 384-dimensional document embeddings', async () => {
    const [vector] = await embedDocuments(['The mitochondria is the powerhouse of the cell.']);
    expect(vector).toHaveLength(384);
    expect(vector!.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('produces 384-dimensional query embeddings', async () => {
    const vector = await embedQuery('What is the powerhouse of the cell?');
    expect(vector).toHaveLength(384);
  });

  it('L2-normalises output vectors', async () => {
    const vectors = await embedDocuments(['Normalisation check.', 'Another short passage about physics.']);
    for (const vector of vectors) {
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(Math.abs(norm - 1)).toBeLessThan(1e-4);
    }
  });

  it('applies the BGE query instruction only to queries', async () => {
    const text = 'Retrieval instruction handling.';
    const asQuery = await embedQuery(text);
    const asDocument = (await embedDocuments([text]))[0]!;

    // Same underlying text, different prefix -> different vectors.
    expect(cosineSimilarity(asQuery, asDocument)).toBeLessThan(0.999);
    expect(QUERY_INSTRUCTION).toBe('Represent this sentence for searching relevant passages: ');
  });

  it('ranks the semantically relevant passage first', async () => {
    const passages = [
      'Photosynthesis converts light energy into chemical energy stored in glucose.',
      'The Great Wall of China was built over many centuries by successive dynasties.',
      'Baking soda reacts with acid to release carbon dioxide gas.',
    ];
    const vectors = await embedDocuments(passages);
    const query = await embedQuery('How do plants make sugar using sunlight?');

    const ranked = vectors
      .map((v, i) => ({ i, score: cosineSimilarity(query, v) }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0]!.i).toBe(0);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[2]!.score);
  });

  it('batches inputs and keeps per-item alignment', async () => {
    const texts = Array.from({ length: 37 }, (_, i) => `Batch item number ${i} describing something unique.`);
    const vectors = await embedDocuments(texts);
    expect(vectors).toHaveLength(37);
    expect(vectors.every((v) => v.length === 384)).toBe(true);

    // The same sentence embedded alone must match its batched counterpart.
    const alone = await embedDocuments([texts[10] as string]);
    expect(cosineSimilarity(vectors[10]!, alone[0]!)).toBeGreaterThan(0.999);
  });

  it('truncates input beyond 512 tokens instead of failing', async () => {
    const vector = await embedQuery('word '.repeat(2000));
    expect(vector).toHaveLength(384);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('returns zero vectors for empty text rather than NaN', async () => {
    const [vector] = await embedDocuments(['   ']);
    expect(vector).toHaveLength(384);
    expect(vector!.every((v) => v === 0)).toBe(true);
  });

  it('is idempotent — repeated calls reuse the loaded model', async () => {
    const before = getDiagnostics()?.loadMs;
    const [a] = await embedDocuments(['Reuse check.']);
    const [b] = await embedDocuments(['Reuse check.']);
    expect(a).toEqual(b);
    expect(getDiagnostics()?.loadMs).toBe(before);
  });
});