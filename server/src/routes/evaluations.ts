import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { resolveKnowledgeBaseId } from '../services/accounts.js';
import { getRagConfig, setRagConfig } from '../services/ragConfig.js';
import { runRagPipeline } from '../services/rag.js';
import { getLlmProvider } from '../services/llm/index.js';

export const evaluationsRouter = Router();
evaluationsRouter.use(requireAuth);

evaluationsRouter.get('/config', asyncHandler(async (_req, res) => {
  res.json({ config: getRagConfig() });
}));

evaluationsRouter.patch('/config', validate(z.object({
  selfRagEnabled: z.boolean().optional(),
  cragEnabled: z.boolean().optional(),
  onlineEvalEnabled: z.boolean().optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  correctThreshold: z.number().min(0).max(1).optional(),
  ambiguousThreshold: z.number().min(0).max(1).optional(),
})), asyncHandler(async (req, res) => {
  const config = setRagConfig(req.body);
  res.json({ config });
}));

evaluationsRouter.get('/stats', asyncHandler(async (req, res) => {
  const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
  const stats = await req.ctx.store.evaluationStats(kbId);
  res.json({ stats });
}));

evaluationsRouter.get('/', validate(z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  mode: z.enum(['online', 'offline']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
  const { limit, skip, mode } = req.query as any;
  const result = await req.ctx.store.listEvaluations(kbId, { limit, skip, mode });
  res.json(result);
}));

evaluationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
  const ev = await req.ctx.store.getEvaluation(req.params.id as string, kbId);
  if (!ev) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Evaluation not found.' } });
    return;
  }
  res.json({ evaluation: ev });
}));

// Benchmark run
evaluationsRouter.post('/benchmark', asyncHandler(async (req, res) => {
  const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
  const body = req.body ?? {};
  const items = Array.isArray(body.items) ? body.items : [];
  const provider = getLlmProvider();
  const results: any[] = [];
  const benchmarkId = `bench-${Date.now()}`;
  for (const item of items.slice(0, 50)) {
    const question = String(item.question ?? '').trim();
    if (!question) continue;
    const { result, meta } = await runRagPipeline(req.ctx.store, { userId: kbId, question }, provider);
    // compute correctness if expected answer provided
    let answerCorrectness: number | null = null;
    let contextRecall: number | null = null;
    if (item.expectedAnswer) {
      const { tokenOverlap } = await import('../services/evaluation.js');
      answerCorrectness = tokenOverlap(item.expectedAnswer, result.answer);
    }
    if (Array.isArray(item.relevantChunkIds)) {
      const { contextRecallFromGroundTruth } = await import('../services/evaluation.js');
      // need chunks; reconstruct from meta
      contextRecall = contextRecallFromGroundTruth(meta.retrievedChunks ?? [], item.relevantChunkIds);
    }
    await req.ctx.store.createEvaluation({
      userId: kbId,
      question,
      answer: result.answer,
      retrievedChunkIds: (result.citations ?? []).map((c: any) => c.chunkId),
      retrievedDocumentIds: [...new Set((result.citations ?? []).map((c: any) => c.documentId))],
      retrievalScores: (result.citations ?? []).map((c: any) => c.score),
      retrievalQuality: meta.retrievalQuality,
      faithfulnessScore: meta.faithfulnessScore,
      answerRelevancyScore: meta.answerRelevancyScore,
      contextPrecision: meta.contextPrecision,
      contextRecall,
      answerCorrectness,
      hallucinationFindings: meta.hallucinationFindings,
      retryCount: meta.retryCount,
      selfRagDecisions: meta.selfRagDecisions,
      cragActions: meta.cragActions,
      processingTimeMs: meta.processingTimeMs,
      tokenUsage: Math.round((result.answer?.length ?? 0) / 4),
      mode: 'offline',
      benchmarkId,
    });
    results.push({ question, answer: result.answer, answerCorrectness, contextRecall });
  }
  res.json({ benchmarkId, count: results.length, results });
}));

evaluationsRouter.get('/benchmark/results', asyncHandler(async (req, res) => {
  const kbId = await resolveKnowledgeBaseId(req.ctx.store, req.user!);
  const result = await req.ctx.store.listEvaluations(kbId, { limit: 200, mode: 'offline' });
  res.json(result);
}));