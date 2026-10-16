/**
 * Chunk editing.
 *
 * Editing a chunk re-embeds the new text with the same model, so the Atlas
 * Vector Search index immediately reflects the correction - a stale vector for
 * edited text would silently break retrieval.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, optionalAuth, requireAuth, validate } from '../middleware/index.js';
import { embedDocuments } from '../services/embeddings.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { notFound } from '../utils/errors.js';
import { idParamSchema, updateChunkSchema } from './schemas.js';

export const chunksRouter = Router();
// Chunk reads are part of the shared knowledge base; editing and deleting a
// chunk re-embeds or removes vectors and is restricted to the admin.
chunksRouter.use(optionalAuth);

chunksRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const chunk = await req.ctx.store.getChunk(id, kbId);
    if (!chunk) throw notFound('Chunk not found.');
    res.json({ chunk });
  }),
);

chunksRouter.patch(
  '/:id',
  requireAuth,
  validate(idParamSchema, 'params'),
  validate(updateChunkSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { text } = req.body as z.infer<typeof updateChunkSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);

    const existing = await req.ctx.store.getChunk(id, kbId);
    if (!existing) throw notFound('Chunk not found.');

    const [embedding] = await embedDocuments([text]);
    if (!embedding) throw new Error('Re-embedding the chunk produced no vector.');

    const updated = await req.ctx.store.updateChunk(id, kbId, { text, embedding, edited: true });
    if (!updated) throw notFound('Chunk not found.');

    res.json({ chunk: { ...updated, embedding: undefined, embeddingDimensions: embedding.length } });
  }),
);

chunksRouter.delete(
  '/:id',
  requireAuth,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const existing = await req.ctx.store.getChunk(id, kbId);
    if (!existing) throw notFound('Chunk not found.');

    const removed = await req.ctx.store.deleteChunk(id, kbId);
    if (!removed) throw notFound('Chunk not found.');

    const chunkCount = await req.ctx.store.syncChunkCounts(existing.documentId);
    res.json({ deleted: true, chunkId: id, documentChunkCount: chunkCount });
  }),
);