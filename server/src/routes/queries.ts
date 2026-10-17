/**
 * Queries Management endpoints.
 *
 * Chat questions the RAG pipeline could not answer from the indexed chunks are
 * collected under the shared knowledge-base workspace. The admin curates them
 * here: mark a query as indexed for tracking (pending -> indexed) or delete it
 * outright. The original question text is immutable and no document, chunk or
 * embedding is ever created from, or by, Queries Management.
 *
 *  GET    /api/queries               - list records (optional ?status=pending|indexed) + counts
 *  POST   /api/queries/:id/indexed   - mark a query as indexed (pending -> indexed)
 *  DELETE /api/queries/:id           - remove a single record
 *
 * Every route is admin-only (requireAuth): regular chat users are anonymous and
 * hold no token, so they can never list, index or delete these records.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { notFound } from '../utils/errors.js';
import { idParamSchema, queriesQuerySchema } from './schemas.js';

export const queriesRouter = Router();
queriesRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// List + section counts
// ---------------------------------------------------------------------------
queriesRouter.get(
  '/',
  validate(queriesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { status } = req.query as unknown as z.infer<typeof queriesQuerySchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const [queries, pending, indexed] = await Promise.all([
      req.ctx.store.listUnansweredQueries(kbId, status ? { status } : {}),
      req.ctx.store.countUnansweredQueries(kbId, 'pending'),
      req.ctx.store.countUnansweredQueries(kbId, 'indexed'),
    ]);
    res.json({ queries, counts: { pending, indexed, total: pending + indexed } });
  }),
);

// ---------------------------------------------------------------------------
// Mark as indexed (pending -> indexed)
//
// Only the status changes: the question text and metadata are preserved and the
// knowledge base is never touched.
// ---------------------------------------------------------------------------
queriesRouter.post(
  '/:id/indexed',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const query = await req.ctx.store.updateUnansweredQuery(id, kbId, { status: 'indexed' });
    if (!query) throw notFound('Query not found.');
    res.json({ query });
  }),
);

// ---------------------------------------------------------------------------
// Delete (single record)
// ---------------------------------------------------------------------------
queriesRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const deleted = await req.ctx.store.deleteUnansweredQuery(id, kbId);
    if (!deleted) throw notFound('Query not found.');
    res.status(204).end();
  }),
);