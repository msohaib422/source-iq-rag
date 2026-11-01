import type { Store } from '../db/store.js';
import { getRagConfig } from './ragConfig.js';

export async function recordEvaluation(
  store: Store,
  userId: string,
  question: string,
  result: { answer: string; citations: { chunkId: string; documentId: string; score: number }[]; retrievedCount: number; meta?: any },
  mode: 'online' | 'offline' = 'online',
): Promise<void> {
  const cfg = getRagConfig();
  if (!cfg.onlineEvalEnabled && mode === 'online') return;
  const meta = result.meta ?? {};
  try {
    await store.createEvaluation({
      userId,
      question,
      answer: result.answer,
      retrievedChunkIds: (result.citations ?? []).map((c: any) => c.chunkId),
      retrievedDocumentIds: [...new Set((result.citations ?? []).map((c: any) => c.documentId))],
      retrievalScores: (result.citations ?? []).map((c: any) => c.score),
      retrievalQuality: meta.retrievalQuality ?? null,
      faithfulnessScore: meta.faithfulnessScore ?? null,
      answerRelevancyScore: meta.answerRelevancyScore ?? null,
      contextPrecision: meta.contextPrecision ?? null,
      hallucinationFindings: meta.hallucinationFindings ?? [],
      retryCount: meta.retryCount ?? 0,
      selfRagDecisions: meta.selfRagDecisions ?? [],
      cragActions: meta.cragActions ?? [],
      processingTimeMs: meta.processingTimeMs ?? null,
      tokenUsage: Math.round((result.answer?.length ?? 0) / 4),
      mode,
    });
  } catch (err) {
    console.warn(`  ! could not record evaluation: ${(err as Error).message}`);
  }
}