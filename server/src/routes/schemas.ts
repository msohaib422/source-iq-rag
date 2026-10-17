/**
 * Request validation schemas shared by routes.
 */
import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.string().trim().min(1, 'id is required').max(64),
});

export const documentQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
});

export const chunksQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export const updateChunkSchema = z.object({
  text: z.string().min(1, 'Chunk text cannot be empty.').max(20_000, 'Chunk text is too long.'),
});

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty.').max(200).optional(),
});

export const chatRequestSchema = z.object({
  question: z.string().trim().min(1, 'Question cannot be empty.').max(2000, 'Question is too long.'),
  documentIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  topK: z.number().int().positive().max(20).optional(),
  minScore: z.number().min(-1).max(1).optional(),
});

export const reindexSchema = z.object({
  // Re-embed existing chunk text with the current model.
  reembed: z.boolean().default(true),
});

// ---- queries management ----

export const queriesQuerySchema = z.object({
  status: z.enum(['pending', 'edited']).optional(),
});

export const updateQuerySchema = z.object({
  question: z.string().trim().min(1, 'Query cannot be empty.').max(2000, 'Query is too long.'),
});
