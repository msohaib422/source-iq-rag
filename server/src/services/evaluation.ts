/**
 * RAG evaluation helpers.
 *
 * Provides lightweight, deterministic metric computations that do not depend on
 * a remote LLM. LLM-as-a-judge can be layered on top by callers; the
 * functions here form the always-available baseline so evaluation never
 * silently fails when the provider is unavailable.
 */
import type { ScoredChunk } from '../types/domain.js';

const STOP = new Set([
  'a','an','the','is','are','was','were','be','been','being','of','in','on','at','to','for','with','and','or','but',
  'if','then','than','that','this','these','those','it','its','as','by','from','how','what','when','where','which',
  'who','whom','why','do','does','did','can','could','will','would','should','shall','may','might','must',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / ta.size;
}

export interface FaithfulnessResult {
  score: number;
  supportedSentences: number;
  totalSentences: number;
  unsupportedClaims: string[];
}

export function checkFaithfulness(answer: string, chunks: ScoredChunk[]): FaithfulnessResult {
  const contextText = chunks.map((c) => c.chunk.text).join('\n');
  const contextTokens = new Set(tokens(contextText));
  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!sentences.length) return { score: 1, supportedSentences: 0, totalSentences: 0, unsupportedClaims: [] };
  let supported = 0;
  const unsupported: string[] = [];
  for (const s of sentences) {
    // Skip fallback / conversational lines.
    if (/i'd be happy to help/i.test(s)) continue;
    const st = tokens(s);
    if (!st.length) { supported += 1; continue; }
    const hits = st.filter((t) => contextTokens.has(t)).length;
    const ratio = hits / st.length;
    if (ratio >= 0.4) supported += 1;
    else unsupported.push(s);
  }
  const total = sentences.length;
  return { score: total ? supported / total : 1, supportedSentences: supported, totalSentences: total, unsupportedClaims: unsupported };
}

export function answerRelevancy(question: string, answer: string): number {
  return tokenOverlap(question, answer);
}

export function contextPrecision(chunks: ScoredChunk[], answer: string): number {
  if (!chunks.length) return 0;
  const cited = new Set<string>();
  for (const m of answer.matchAll(/[\[［【]\s*(\d{1,2})\s*[\]］】]/g)) {
    cited.add(String(Number(m[1]) - 1));
  }
  // If no explicit citations, fall back to chunks that share tokens with answer.
  let relevant = 0;
  chunks.forEach((c, i) => {
    if (cited.has(String(i))) relevant += 1;
    else if (tokenOverlap(c.chunk.text, answer) >= 0.2) relevant += 1;
  });
  return relevant / chunks.length;
}

export function contextRecallFromGroundTruth(chunks: ScoredChunk[], relevantChunkIds: string[]): number {
  if (!relevantChunkIds.length) return 0;
  const retrieved = new Set(chunks.map((c) => c.chunk.id));
  const hit = relevantChunkIds.filter((id) => retrieved.has(id)).length;
  return hit / relevantChunkIds.length;
}

export function mrr(chunks: ScoredChunk[], relevantChunkIds: string[]): number {
  const set = new Set(relevantChunkIds);
  for (let i = 0; i < chunks.length; i++) {
    if (set.has(chunks[i]!.chunk.id)) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(chunks: ScoredChunk[], relevantChunkIds: string[], k?: number): number {
  const K = k ?? chunks.length;
  const relSet = new Set(relevantChunkIds);
  let dcg = 0;
  for (let i = 0; i < Math.min(K, chunks.length); i++) {
    const rel = relSet.has(chunks[i]!.chunk.id) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }
  // ideal
  const idealHits = Math.min(K, relevantChunkIds.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

export function precisionAtK(chunks: ScoredChunk[], relevantChunkIds: string[], k: number): number {
  const set = new Set(relevantChunkIds);
  const slice = chunks.slice(0, k);
  if (!slice.length) return 0;
  const hit = slice.filter((c) => set.has(c.chunk.id)).length;
  return hit / slice.length;
}

export function recallAtK(chunks: ScoredChunk[], relevantChunkIds: string[], k: number): number {
  if (!relevantChunkIds.length) return 0;
  const set = new Set(relevantChunkIds);
  const slice = chunks.slice(0, k);
  const hit = slice.filter((c) => set.has(c.chunk.id)).length;
  return hit / relevantChunkIds.length;
}

export function hallucinationFindings(answer: string, chunks: ScoredChunk[]): string[] {
  const r = checkFaithfulness(answer, chunks);
  return r.unsupportedClaims;
}

export function evidenceCoverage(answer: string, chunks: ScoredChunk[]): number {
  return checkFaithfulness(answer, chunks).score;
}