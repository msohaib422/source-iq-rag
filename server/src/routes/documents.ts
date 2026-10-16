import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler, optionalAuth, requireAuth, validate } from '../middleware/index.js';
import { deleteUpload, ingestDocument, persistUpload, reembedDocument } from '../services/ingest.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { badRequest, notFound, unprocessable } from '../utils/errors.js';
import { chunksQuerySchema, documentQuerySchema, idParamSchema, reindexSchema, updateDocumentSchema } from './schemas.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';
    if (!ok) {
      cb(badRequest('Only PDF files are supported.'));
      return;
    }
    cb(null, true);
  },
});

function titleFromFilename(name: string): string {
  return path
    .basename(name, path.extname(name))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled document';
}

export const documentsRouter = Router();
// Reads are open: anonymous visitors and the admin both browse the shared
// knowledge base. Management (upload/edit/delete) additionally requires the
// admin token - see requireAuth on the mutating routes below.
documentsRouter.use(optionalAuth);

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
documentsRouter.get(
  '/',
  validate(documentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { search, status } = req.query as unknown as z.infer<typeof documentQuerySchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const documents = await req.ctx.store.listDocuments(kbId, {
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
    });
    res.json({ documents });
  }),
);

// ---------------------------------------------------------------------------
// Upload + index (admin only)
// ---------------------------------------------------------------------------
documentsRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Attach a PDF using the "file" form field.');
    if (file.size === 0) throw unprocessable('The uploaded file is empty.');

    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const storagePath = await persistUpload(file.buffer, file.originalname);
    const document = await req.ctx.store.createDocument({
      userId: kbId,
      title: titleFromFilename(file.originalname),
      originalName: path.basename(file.originalname),
      storagePath,
      mimeType: file.mimetype || 'application/pdf',
      sizeBytes: file.size,
    });

    // Index synchronously so the client gets a definitive ready/failed result
    // (and honest progress states) for a document of a reasonable size.
    const result = await ingestDocument(req.ctx.store, {
      documentId: document.id,
      userId: kbId,
      buffer: file.buffer,
    });

    const updated = await req.ctx.store.getDocument(document.id, kbId);
    req.ctx.invalidateTitle(document.id);

    if (result.status === 'failed') {
      // Keep the failed record so the user can see and delete it.
      res.status(422).json({ document: updated, ingestion: result });
      return;
    }
    res.status(201).json({ document: updated, ingestion: result });
  }),
);

// ---------------------------------------------------------------------------
// Metadata / chunks / reindex / delete
// ---------------------------------------------------------------------------
documentsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await req.ctx.store.getDocument(id, kbId);
    if (!document) throw notFound('Document not found.');
    const chunks = await req.ctx.store.listChunks(id, { limit: 100_000 });
    res.json({ document, chunks });
  }),
);

documentsRouter.patch(
  '/:id',
  requireAuth,
  validate(idParamSchema, 'params'),
  validate(updateDocumentSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { title } = req.body as z.infer<typeof updateDocumentSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await req.ctx.store.updateDocument(id, kbId, title ? { title } : {});
    if (!document) throw notFound('Document not found.');
    req.ctx.invalidateTitle(id);
    res.json({ document });
  }),
);

documentsRouter.get(
  '/:id/chunks',
  validate(idParamSchema, 'params'),
  validate(chunksQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { limit, skip } = req.query as unknown as z.infer<typeof chunksQuerySchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await req.ctx.store.getDocument(id, kbId);
    if (!document) throw notFound('Document not found.');
    const chunks = await req.ctx.store.listChunks(id, { limit, skip });
    res.json({ document, chunks, pagination: { limit, skip, total: document.chunkCount } });
  }),
);

documentsRouter.post(
  '/:id/reindex',
  requireAuth,
  validate(idParamSchema, 'params'),
  validate(reindexSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await req.ctx.store.getDocument(id, kbId);
    if (!document) throw notFound('Document not found.');
    const { updated } = await reembedDocument(req.ctx.store, { documentId: id, userId: kbId });
    res.json({ document: { ...document, chunkCount: updated }, updated });
  }),
);

documentsRouter.delete(
  '/:id',
  requireAuth,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    const document = await req.ctx.store.getDocument(id, kbId);
    if (!document) throw notFound('Document not found.');

    await req.ctx.store.deleteDocument(id, kbId);
    await deleteUpload(document.storagePath);
    req.ctx.invalidateTitle(id);
    res.status(204).end();
  }),
);

export { upload };