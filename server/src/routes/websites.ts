/**
 * Website ingestion routes (admin only).
 *
 *  POST /api/websites            start a Firecrawl crawl for a URL
 *  POST /api/websites/:id/advance run one bounded slice of crawl/index work
 *
 * Progress is deliberately client-driven: no request is held open while the
 * crawl runs (serverless friendly), and every advance call does a small,
 * single-flight amount of work before returning the persisted document.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { advanceWebsiteCrawl, createWebsiteCrawl } from '../services/websiteIngest.js';
import { idParamSchema, normalizeWebsiteUrl, websiteCrawlSchema } from './schemas.js';

export const websitesRouter = Router();

// Management surface: the admin token is required for every route here.
websitesRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Start a crawl
// ---------------------------------------------------------------------------
websitesRouter.post(
  '/',
  validate(websiteCrawlSchema),
  asyncHandler(async (req, res) => {
    const { url } = req.body as z.infer<typeof websiteCrawlSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await createWebsiteCrawl(req.ctx.store, {
      userId: kbId,
      url: normalizeWebsiteUrl(url),
    });
    req.ctx.invalidateTitle(document.id);

    if (document.status === 'failed') {
      // Keep the failed record so the user can see and delete it (mirrors a
      // failed PDF upload returning 422 with its document).
      res.status(422).json({ document });
      return;
    }
    res.status(201).json({ document });
  }),
);

// ---------------------------------------------------------------------------
// Advance one bounded slice of work (client polls this every few seconds)
// ---------------------------------------------------------------------------
websitesRouter.post(
  '/:id/advance',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await advanceWebsiteCrawl(req.ctx.store, { documentId: id, userId: kbId });
    res.json({ document });
  }),
);
