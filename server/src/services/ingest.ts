/**
 * Document ingestion pipeline.
 *
 *   PDF buffer
 *     -> extractPdfText()        (pdf.js via unpdf, per-page boundaries)
 *     -> chunkText()             (recursive character split with overlap)
 *     -> embedDocuments()        (BAAI/bge-small-en-v1.5, CLS + L2 norm, 384 dims)
 *     -> store.insertChunks()    (Atlas Vector Search index target)
 *
 * The document status is updated at each stage so the UI can show real progress
 * rather than an optimistic spinner. Failures are recorded on the document and
 * never leave it stuck in `processing`.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { Store } from '../db/store.js';
import { chunkText, pageForOffset } from './chunker.js';
import { embedDocuments } from './embeddings.js';
import { extractPdfText, PdfExtractionError } from './pdf.js';

export interface IngestionResult {
  documentId: string;
  status: 'ready' | 'failed';
  pageCount: number;
  charCount: number;
  chunkCount: number;
  dimensions: number;
  elapsedMs: number;
  error?: string;
}

export async function persistUpload(buffer: Buffer, originalName: string): Promise<string> {
  await fs.mkdir(env.UPLOAD_DIR, { recursive: true });
  // Never trust the client filename on disk - generate our own and keep the
  // original only as metadata.
  const storagePath = path.join(env.UPLOAD_DIR, `${randomUUID()}.pdf`);
  await fs.writeFile(storagePath, buffer);
  return storagePath;
}

export async function deleteUpload(storagePath: string | null): Promise<void> {
  if (!storagePath) return;
  const resolved = path.resolve(storagePath);
  const uploadsRoot = path.resolve(env.UPLOAD_DIR);
  if (!resolved.startsWith(uploadsRoot)) return; // never delete outside the upload dir
  await fs.rm(resolved, { force: true });
}

export async function ingestDocument(
  store: Store,
  params: { documentId: string; userId: string; buffer: Buffer },
): Promise<IngestionResult> {
  const started = Date.now();
  const { documentId, userId, buffer } = params;

  try {
    await store.updateDocument(documentId, userId, { status: 'processing', error: null });

    // 1. Extract -----------------------------------------------------------
    const extracted = await extractPdfText(buffer);
    await store.updateDocument(documentId, userId, {
      pageCount: extracted.pageCount,
      charCount: extracted.text.length,
    });

    // 2. Chunk -------------------------------------------------------------
    const pieces = chunkText(extracted.text, { size: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP });
    if (pieces.length === 0) {
      throw new PdfExtractionError('The PDF produced no usable text after normalisation.');
    }

    // 3. Embed -------------------------------------------------------------
    // Batch to bound memory; encode() already batches internally, so pass all.
    const embeddings = await embedDocuments(pieces.map((p) => p.text));

    const badIndex = embeddings.findIndex((e) => e.length !== env.EMBEDDING_DIMENSIONS);
    if (badIndex >= 0) {
      throw new Error(
        `Embedding ${badIndex} has ${embeddings[badIndex]?.length} dimensions, expected ${env.EMBEDDING_DIMENSIONS}.`,
      );
    }

    // 4. Persist -----------------------------------------------------------
    // Replace any previous chunks (safe re-ingestion).
    await store.deleteChunksByDocument(documentId, userId);
    await store.insertChunks(
      pieces.map((piece, i) => ({
        documentId,
        userId,
        ordinal: i,
        text: piece.text,
        embedding: embeddings[i] as number[],
        page: pageForOffset(piece.charStart, extracted.pageBoundaries),
        charStart: piece.charStart,
        charEnd: piece.charEnd,
      })),
    );
    const chunkCount = await store.syncChunkCounts(documentId);
    await store.updateDocument(documentId, userId, { status: 'ready', error: null });

    return {
      documentId,
      status: 'ready',
      pageCount: extracted.pageCount,
      charCount: extracted.text.length,
      chunkCount,
      dimensions: env.EMBEDDING_DIMENSIONS,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Ensure a partially ingested document does not keep stale chunks around.
    await store.deleteChunksByDocument(documentId, userId);
    await store.syncChunkCounts(documentId);
    await store.updateDocument(documentId, userId, { status: 'failed', error: message });
    return {
      documentId,
      status: 'failed',
      pageCount: 0,
      charCount: 0,
      chunkCount: 0,
      dimensions: env.EMBEDDING_DIMENSIONS,
      elapsedMs: Date.now() - started,
      error: message,
    };
  }
}

/**
 * Re-embed every chunk of a document in place (e.g. after a model or chunking
 * configuration change). Chunk text is preserved.
 */
export async function reembedDocument(
  store: Store,
  params: { documentId: string; userId: string },
): Promise<{ updated: number }> {
  const chunks = await store.listChunks(params.documentId, { limit: 100_000 });
  if (!chunks.length) return { updated: 0 };

  const embeddings = await embedDocuments(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i += 1) {
    await store.updateChunk(chunks[i]!.id, params.userId, {
      embedding: embeddings[i] as number[],
      edited: chunks[i]!.edited,
    });
  }
  return { updated: chunks.length };
}