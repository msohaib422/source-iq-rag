/**
 * Queries Management endpoints.
 *
 * Chat questions the RAG pipeline could not answer from the indexed chunks are
 * collected under the shared knowledge-base workspace. The admin curates them
 * here: rename the question (pending -> edited) or delete it outright. Editing
 * only updates this record - no document, chunk or embedding is ever created
 * from, or by, Queries Management.
 *
 *  GET    /api/queries      - list records (optional ?status=pending|edited) + counts
 *  PATCH  /api/queries/:id  - edit the query text
 *  DELETE /api/queries/:id  - remove a single record
 *
 * Every route is admin-only (requireAuth): regular chat users are anonymous and
 * hold no token, so they can never list, edit or delete these records.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { notFound } from '../utils/errors.js';
import { idParamSchema, queriesQuerySchema, updateQuerySchema } from './schemas.js';

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
    const [queries, pending, edited] = await Promise.all([
      req.ctx.store.listUnansweredQueries(kbId, status ? { status } : {}),
      req.ctx.store.countUnansweredQueries(kbId, 'pending'),
      req.ctx.store.countUnansweredQueries(kbId, 'edited'),
    ]);
    res.json({ queries, counts: { pending, edited, total: pending + edited } });
  }),
);

// ---------------------------------------------------------------------------
// Edit (pending -> edited, or a further edit of an edited record)
// ---------------------------------------------------------------------------
queriesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateQuerySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { question } = req.body as z.infer<typeof updateQuerySchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    // The original submission (query.question) is left untouched; the new text
    // becomes the edited phrasing and the record moves to the Edited section.
    const query = await req.ctx.store.updateUnansweredQuery(id, kbId, {
      editedQuestion: question,
      status: 'edited',
    });
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
