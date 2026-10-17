/**
 * Chat endpoints.
 *
 *  POST /api/chat            - non-streaming JSON answer + citations
 *  POST /api/chat/stream     - Server-Sent Events (citations -> deltas -> done)
 *
 * Chat is stateless: a request is answered from the shared knowledge base and
 * the exchange itself is not stored. The one exception is a knowledge question
 * that ends with no citation at all - the pipeline found no chunk that
 * sufficiently supports it - which is recorded for the admin's Queries
 * Management page (services/queries.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, optionalAuth, validate } from '../middleware/index.js';
import { recordUnansweredQuery } from '../services/queries.js';
import { getLlmProvider } from '../services/llm/index.js';
import { LlmConfigurationError } from '../services/llm/types.js';
import { answerQuestion, classifyIntent, streamAnswer } from '../services/rag.js';
import type { Citation } from '../types/domain.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { notFound } from '../utils/errors.js';
import { chatRequestSchema } from './schemas.js';

type ChatInput = z.infer<typeof chatRequestSchema>;

export const chatRouter = Router();
// Anonymous visitors can chat in the public workspace; the admin uses their own
// workspace via a token. No account is required for regular users.
chatRouter.use(optionalAuth);

/** Verify every requested document belongs to the shared knowledge base. */
async function assertDocumentsOwned(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], kbId: string, documentIds?: string[]) {
  if (!documentIds?.length) return;
  for (const id of documentIds) {
    const doc = await req.ctx.store.getDocument(id, kbId);
    if (!doc) throw notFound(`Document ${id} was not found in the knowledge base.`);
  }
}

chatRouter.post(
  '/',
  validate(chatRequestSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as ChatInput;
    // Retrieval reads the shared knowledge base, which anonymous visitors and
    // the admin both address.
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    await assertDocumentsOwned(req, kbId, input.documentIds);

    // Prime citation titles before building the prompt.
    if (input.documentIds?.length) await req.ctx.primeDocumentTitles(kbId, input.documentIds);
    // Always prime the documents that retrieval actually returns titles for by
    // loading the full library (cheap: metadata only).
    const all = await req.ctx.store.listDocuments(kbId);
    await req.ctx.primeDocumentTitles(
      kbId,
      all.map((d) => d.id),
    );

    const provider = getLlmProvider();
    const intent = classifyIntent(input.question);
    const result = await answerQuestion(
      req.ctx.store,
      {
        userId: kbId,
        question: input.question,
        ...(input.documentIds?.length ? { documentIds: input.documentIds } : {}),
        ...(input.topK ? { limit: input.topK } : {}),
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
      },
      provider,
    );

    // The pipeline's own relevance verdict: a knowledge question whose answer
    // cites nothing was not supported by any chunk it saw. Small talk and
    // unclear messages never record, and a retriever/LLM failure throws before
    // this line, so technical errors are never mistaken for a bad question.
    if (intent.kind === 'knowledge' && result.citations.length === 0) {
      await recordUnansweredQuery(req.ctx.store, kbId, input.question);
    }

    res.json(result);
  }),
);

chatRouter.post(
  '/stream',
  validate(chatRequestSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as ChatInput;
    const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
    await assertDocumentsOwned(req, kbId, input.documentIds);
    const intent = classifyIntent(input.question);

    const all = await req.ctx.store.listDocuments(kbId);
    await req.ctx.primeDocumentTitles(kbId, all.map((d) => d.id));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let answer = '';
    let doneSent = false;
    /** Citations of the pipeline's own done frame (aligned to what was grounded). */
    let finalCitations: Citation[] | null = null;

    try {
      for await (const event of streamAnswer(
        req.ctx.store,
        {
          userId: kbId,
          question: input.question,
          ...(input.documentIds?.length ? { documentIds: input.documentIds } : {}),
          ...(input.topK ? { limit: input.topK } : {}),
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        },
        getLlmProvider(),
      )) {
        if (controller.signal.aborted) break;
        if (event.type === 'citations') {
          send('citations', event.payload);
        } else if (event.type === 'delta') {
          answer += (event.payload as { text: string }).text;
          send('delta', event.payload);
        } else if (event.type === 'done') {
          // Forward the pipeline's own payload: it carries the citations the
          // answer actually referenced, not everything that was retrieved.
          doneSent = true;
          finalCitations = (event.payload as { citations: Citation[] }).citations;
          send('done', event.payload);
        }
      }

      // The client was disconnected before the answer completed.
      if (!doneSent && !controller.signal.aborted) {
        send('done', { citations: [], answerLength: answer.length });
      }

      // Same relevance verdict as the non-streaming endpoint: a knowledge
      // question whose grounded reply referenced no chunk is recorded for the
      // admin. Aborted or errored streams never reach this point (the abort
      // guard above, or the catch below).
      if (!controller.signal.aborted && intent.kind === 'knowledge' && finalCitations?.length === 0) {
        await recordUnansweredQuery(req.ctx.store, kbId, input.question);
      }
    } catch (err) {
      send('error', {
        message: err instanceof Error ? err.message : 'Streaming failed.',
        code: err instanceof LlmConfigurationError ? 'LLM_UNAVAILABLE' : 'STREAM_ERROR',
      });
    } finally {
      res.end();
    }
  }),
);