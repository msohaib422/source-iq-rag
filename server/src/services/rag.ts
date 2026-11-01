/**
 * Retrieval-augmented generation pipeline.
 *
 * Flow:
 *   question
 *     -> embedQuery()            (BAAI/bge-small-en-v1.5, CLS + L2 norm, instruction prefix)
 *     -> store.vectorSearch()    (Atlas $vectorSearch, or in-memory cosine fallback)
 *     -> buildPrompt()           (numbered, citation-friendly context blocks)
 *     -> llm.complete()/stream()
 *     -> citations               (mapped back to chunk + document metadata)
 *
 * Retrieval, grounding and citation assembly are identical for every LLM
 * provider; only the final generation step differs.
 */
import { env } from '../config/env.js';
import type { Store } from '../db/store.js';
import type { ChunkRecord, Citation, ScoredChunk } from '../types/domain.js';
import { embedQuery } from './embeddings.js';
import { getLlmProvider, type LlmProvider } from './llm/index.js';
import { applyCleanResponseFormatting, CleanResponseFormatter } from './formatting.js';
import { FALLBACK_REPLY } from './fallback.js';
import { getRagConfig } from './ragConfig.js';
import {
  answerRelevancy,
  checkFaithfulness,
  contextPrecision,
  tokenOverlap,
} from './evaluation.js';

export const SYSTEM_PROMPT = [
  'You are SourceIQ, a careful research assistant that answers questions strictly from the numbered context passages supplied by the user.',
  '',
  'Grounding rules:',
  '1. Use only information that appears in the context passages. Never use outside or pretrained knowledge to fill a gap.',
  '2. If the passages do not contain the answer, respond with exactly: "I\'d be happy to help! This information isn\'t available just yet, but stay tuned for future updates. Could you share a little more detail about what you\'re looking for?" Never guess a date, figure, name, policy or procedure.',
  '3. If the passages are off-topic, ambiguous or too vague to settle the question, respond with the same friendly message instead of forcing an answer.',
  '4. If only part of a question is supported, answer the supported part and state clearly which part you could not verify.',
  '5. Be concise and factual. Quote figures, names and dates exactly as written in the passages.',
  '',
  'Citation rules:',
  '6. Cite a passage with its bracketed number, e.g. [1] or [2][3], only when that passage actually supports the claim beside it.',
  '7. Never invent a citation number that is not in the context, and never imply a source says something it does not.',
  '',
  'Clean response formatting rules:',
  '8. Write the answer as clean, direct, natural prose in paragraphs. Inline [n] citations from rules 6-7 are fine - the application removes them and renders its own source list - but never narrate them further: no footnote-style labels, no "source 3" or "passage 2" wording, no mention of chunks, relevance scores or context labels, and never state how many sources were used.',
  '9. Never append a Sources, References, Bibliography, Further Reading, Works Cited or similar section, never list or enumerate sources at the end, and never cluster citations into a pseudo-list such as "x [1], [2] and [3]" - place each [n] directly beside the claim it supports. End the answer after its final sentence.',
].join('\n');

export interface RetrieveOptions {
  userId: string;
  question: string;
  documentIds?: string[];
  limit?: number;
  minScore?: number;
}

// ---------------------------------------------------------------------------
// Intent
//
// Small talk must not be answered as a retrieval question: asking the model to
// ground "Hi" in a knowledge base produces the robotic "there is no relevant
// information in the provided context" answer. Conversely a factual question
// must never be answered without retrieval. The split is made here, on the
// request text alone, so no extra model call is introduced.
// ---------------------------------------------------------------------------

export type SmallTalkKind = 'greeting' | 'wellbeing' | 'thanks' | 'farewell' | 'affirmation' | 'identity';

export type ChatIntent =
  /** Pure pleasantry: answer directly, never touch the knowledge base. */
  | { kind: 'conversational'; smallTalk: SmallTalkKind }
  /** Too vague to act on (there is no history to resolve it against). */
  | { kind: 'unclear' }
  /** A factual question, optionally opening with a greeting. */
  | { kind: 'knowledge'; greeting: SmallTalkKind | null };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETING_TOKENS = new Set([
  'hi', 'hello', 'hey', 'hiya', 'heyya', 'yo', 'greetings', 'greeting', 'howdy',
  'morning', 'afternoon', 'evening', 'namaste', 'hola', 'ciao',
]);

/**
 * Every token that can legitimately appear in a message that is nothing but
 * pleasantry. A message is conversational only when *all* of its tokens are in
 * here, which keeps "what is the greeting policy in this document?" a knowledge
 * question rather than a greeting.
 */
const CONVERSATIONAL_TOKENS = new Set([
  ...GREETING_TOKENS,
  'good', 'day', 'night', 'morning',
  'how', 'are', 'r', 'u', 'you', 'i', 'us', 'we', 'your', 'my',
  'doing', 'going', 'been', 'fine', 'okay', 'ok', 'today', 'feeling', 'whats', 'up', 'new', 'now',
  'thank', 'thanks', 'thx', 'ta', 'cheers', 'appreciated', 'welcome', 'pleasure', 'time', 'np', 'much',
  'bye', 'goodbye', 'later', 'care', 'take', 'see', 'cya',
  'yes', 'yep', 'yeah', 'yup', 'sure', 'no', 'problem', 'cool', 'nice', 'great', 'awesome', 'perfect',
  'got', 'it', 'understood', 'right', 'alright', 'alrighty', 'word', 'hm', 'hmm', 'huh', 'uh', 'eh',
  'who', 'what', 'can', 'do', 'introduce', 'yourself', 'ask', 'about',
  'there', 'everyone', 'folks', 'team', 'all', 'please', 'really', 'just', 'too', 'so', 'well', 'again',
]);

const GREETINGS = [/\bgood\s+(?:morning|afternoon|evening)\b/];
const WELLBEING = [
  /\bhow\s+(?:are|r)\s+(?:you|u)\b/,
  /\bhow\s+(?:are|r)\s+you\s+doing\b/,
  /\bhow\s+you\s+doing\b/,
  /\bhow'?s\s+(?:it|that|everything|your\s+day)\s+going\b/,
  /\bhow\s+(?:is|are)\s+it\s+going\b/,
  /\bwhat'?s\s+up\b/,
  /\bwhats\s+new\b/,
  /\bhow\s+have\s+you\s+been\b/,
  /\bhow\s+did\s+your\s+day\b/,
];
const IDENTITY = [
  /\bwho\s+(?:are|r)\s+(?:you|u)\b/,
  /\bwhat\s+are\s+you\b/,
  /\bwhat\s+can\s+you\s+do\b/,
  /\bwhat\s+can\s+i\s+ask\s+you\b/,
  /\bwhat\s+do\s+you\s+do\b/,
  /\bintroduce\s+yourself\b/,
];
const THANKS = [
  /\b(?:thanks|thank\s+you|thx|ta|cheers|much\s+appreciated|appreciate\s+it)\b/,
  /\b(?:you'?re\s+welcome|my\s+pleasure|any\s+time)\b/,
];
const FAREWELL = [/\b(?:bye|goodbye|good\s+night|see\s+you|see\s+ya|take\s+care|cya)\b/];

/** High-precision "there is nothing actionable here" shapes. */
const UNCLEAR_PATTERNS = [
  /^(?:why|how|what|when|where|who|which|really|and|then|so|hm+|hmm+|huh|uh)\??$/,
  /^(?:tell me more|more|go on|continue|and so|hm+|hmm+|huh|uh|eh)+$/,
  /^(?:and|so|then|but|ok|okay|what|how|why)\s+(?:about\s+)?(?:it|that|this|them|those|more|else)\??$/,
];

export function classifyIntent(question: string): ChatIntent {
  const text = normalize(question);
  if (!text) return { kind: 'unclear' };
  if (UNCLEAR_PATTERNS.some((re) => re.test(text))) return { kind: 'unclear' };

  const tokens = text.split(' ').filter((t) => t.length > 0);
  if (!tokens.length) return { kind: 'unclear' };

  if (tokens.every((t) => CONVERSATIONAL_TOKENS.has(t))) {
    if (WELLBEING.some((re) => re.test(text))) return { kind: 'conversational', smallTalk: 'wellbeing' };
    if (IDENTITY.some((re) => re.test(text))) return { kind: 'conversational', smallTalk: 'identity' };
    if (THANKS.some((re) => re.test(text))) return { kind: 'conversational', smallTalk: 'thanks' };
    if (FAREWELL.some((re) => re.test(text))) return { kind: 'conversational', smallTalk: 'farewell' };
    if (GREETINGS.some((re) => re.test(text)) || tokens.some((t) => GREETING_TOKENS.has(t))) {
      return { kind: 'conversational', smallTalk: 'greeting' };
    }
    return { kind: 'conversational', smallTalk: 'affirmation' };
  }

  // A greeting that carries a factual question is still a knowledge question;
  // only the leading pleasantry is answered conversationally.
  const opening = tokens[0];
  return { kind: 'knowledge', greeting: opening !== undefined && GREETING_TOKENS.has(opening) ? 'greeting' : null };
}

const SMALL_TALK_REPLIES: Record<SmallTalkKind, readonly string[]> = {
  greeting: [
    'Hello! How can I assist you today?',
    'Hello! What can I help you find today?',
    'Hi there! How can I help you today?',
    'Hello! Feel free to ask me anything about your documents.',
  ],
  wellbeing: [
    "I'm doing well, thank you! How can I help you today?",
    "I'm doing well, thanks for asking! What can I help you with?",
    'Doing well, thanks! What would you like to know?',
  ],
  thanks: [
    "You're welcome! Let me know if you need anything else.",
    "You're welcome! Feel free to ask if you need anything else.",
  ],
  farewell: [
    'Goodbye! Feel free to come back with any questions about your documents.',
    'Goodbye! Come back any time if you need something.',
  ],
  affirmation: ['Great! What would you like to know?', 'Sure! What can I help you find?'],
  identity: [
    "I'm your AI assistant. I can help answer questions using the information available in the provided knowledge sources.",
    "I'm the SourceIQ assistant. I answer questions strictly from the information available in the provided knowledge sources.",
  ],
};

/** Deterministic choice so the same greeting always gets the same reply. */
function pickReply(kind: SmallTalkKind, seed: string): string {
  const options = SMALL_TALK_REPLIES[kind];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return options[hash % options.length]!;
}

export const CLARIFY_REPLY =
  "I'm not sure what you're asking about - could you rephrase your question? " +
  'I answer using the information available in the knowledge sources.';

export { FALLBACK_REPLY };

/** Detect technical/generic fallback refusals so they can be normalized. */
function isTechnicalFallback(answer: string): boolean {
  const text = answer.trim();
  if (!text) return true;
  if (text.length > 400) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('could not find') ||
    lower.includes('provided context') ||
    lower.includes('context passages') ||
    lower.includes('no matching passages') ||
    lower.includes('indexed sources') ||
    lower.includes('knowledge sources') ||
    lower.includes('insufficient information') ||
    lower.includes('not enough information') ||
    lower.includes('no relevant information')
  );
}

/** Split into word-sized pieces so a fixed reply still streams like an answer. */
function* wordGroups(text: string): Generator<string, void, unknown> {
  for (const part of text.match(/\S+\s*/g) ?? [text]) yield part;
}

/** Acknowledge a leading greeting without letting it weaken the grounded answer. */
function withGreeting(answer: string, greeting: SmallTalkKind | null, seed: string): string {
  if (!greeting) return answer;
  return `${pickReply(greeting, seed)}\n\n${answer}`;
}

export interface RetrievedContext {
  chunks: ScoredChunk[];
  queryEmbedding: number[];
  question: string;
}

export async function retrieveContext(store: Store, options: RetrieveOptions): Promise<RetrievedContext> {
  const limit = options.limit ?? env.VECTOR_LIMIT;
  const queryEmbedding = await embedQuery(options.question);

  const chunks = await store.vectorSearch({
    userId: options.userId,
    queryEmbedding,
    limit,
    numCandidates: Math.max(env.VECTOR_NUM_CANDIDATES, limit * 10),
    ...(options.documentIds?.length ? { documentIds: options.documentIds } : {}),
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
  });

  return { chunks, queryEmbedding, question: options.question };
}

/** Truncate long passages so a handful of chunks cannot blow the context window. */
function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

const MAX_CONTEXT_CHARS_PER_CHUNK = 1600;

export function buildPrompt(question: string, chunks: ScoredChunk[]): { prompt: string; contextLabels: string[] } {
  if (!chunks.length) {
    return {
      prompt:
        `Question: ${question}\n\nContext:\n(no matching passages were found in the indexed documents)`,
      contextLabels: [],
    };
  }

  const blocks = chunks.map((scored, i) => {
    const label = String(i + 1);
    const header: string[] = [label];
    const { documentTitle, page } = citationMeta(scored.chunk);
    header.push(`source: ${documentTitle}`);
    if (page) header.push(`page: ${page}`);
    header.push(`chunk: ${scored.chunk.ordinal + 1}`);
    header.push(`relevance: ${scored.score.toFixed(4)}`);
    return `[${header.join(' | ')}]\n${excerpt(scored.chunk.text, MAX_CONTEXT_CHARS_PER_CHUNK)}`;
  });

  const prompt = `Context:\n${blocks.join('\n\n')}\n\nQuestion: ${question}\n\nAnswer using only the context above, citing with [n].`;
  return { prompt, contextLabels: blocks.map((_, i) => String(i + 1)) };
}

// Titles are carried on the chunk only through the document; the routes pass a
// resolver so this module stays storage-agnostic.
let documentTitleResolver: ((documentId: string) => string | null) | null = null;

export function setDocumentTitleResolver(fn: (documentId: string) => string | null): void {
  documentTitleResolver = fn;
}

function citationMeta(chunk: ChunkRecord): { documentTitle: string; page: number | null } {
  const title = documentTitleResolver?.(chunk.documentId) ?? 'Untitled document';
  return { documentTitle: title, page: chunk.page };
}

export function buildCitations(chunks: ScoredChunk[], maxChars = 320): Citation[] {
  return chunks.map(({ chunk, score }) => {
    const { documentTitle, page } = citationMeta(chunk);
    return {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle,
      ordinal: chunk.ordinal,
      page,
      score: Number(score.toFixed(6)),
      snippet: excerpt(chunk.text, maxChars),
    };
  });
}

/**
 * Keep only the passages the answer actually referenced, in retrieval order.
 *
 * A passage the model never cited is not evidence for the answer, so it is
 * dropped rather than shown as a "source considered": attaching a citation to a
 * claim would imply support that may not exist. When the model cites nothing,
 * the answer made no source-backed claim and no citation is returned.
 *
 * Models differ in the bracket they emit (`[1]`, `［1］`, `【1】`), so all
 * three are recognised here; `buildPrompt` only ever numbers real passages, so
 * an out-of-range number is simply ignored.
 */
export function alignCitationsToAnswer(answer: string, citations: Citation[]): Citation[] {
  const referenced = new Set<string>();
  for (const m of answer.matchAll(/[\[［【]\s*(\d{1,2})\s*[\]］】]/g)) {
    const citation = citations[Number(m[1]) - 1];
    if (citation) referenced.add(citation.chunkId);
  }
  return citations.filter((c) => referenced.has(c.chunkId));
}

export interface PipelineMeta {
  retrievalQuality: string | null;
  retryCount: number;
  selfRagDecisions: string[];
  cragActions: string[];
  retrievedChunks: ScoredChunk[];
  faithfulnessScore: number | null;
  answerRelevancyScore: number | null;
  contextPrecision: number | null;
  hallucinationFindings: string[];
  processingTimeMs: number;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  retrievedCount: number;
  usedProvider: string;
  usedModel: string;
  /** Internal metadata for evaluation; stripped before sending to clients. */
  meta?: PipelineMeta;
}

/** Answer that needs neither retrieval nor a model call. */
function directResult(answer: string, provider: LlmProvider): AnswerResult {
  return {
    answer,
    citations: [],
    retrievedCount: 0,
    usedProvider: provider.name,
    usedModel: provider.model,
  };
}

function tokenizeSimple(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function rewriteQuery(question: string, chunks: ScoredChunk[]): string {
  const qTokens = new Set(tokenizeSimple(question));
  const freq = new Map<string, number>();
  for (const c of chunks.slice(0, 3)) {
    for (const t of tokenizeSimple(c.chunk.text)) {
      if (!qTokens.has(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const extra = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t]) => t);
  return extra.length ? `${question} ${extra.join(' ')}` : question;
}

export function gradeRetrieval(chunks: ScoredChunk[], question: string): 'CORRECT' | 'AMBIGUOUS' | 'INCORRECT' {
  const cfg = getRagConfig();
  if (!cfg.cragEnabled) return chunks.length ? 'CORRECT' : 'INCORRECT';
  if (!chunks.length) return 'INCORRECT';
  const maxScore = Math.max(...chunks.map((c) => c.score));
  const overlap = chunks.slice(0, 3).some((c) => tokenOverlap(question, c.chunk.text) >= 0.1);
  if (maxScore >= cfg.correctThreshold && overlap) return 'CORRECT';
  if (maxScore >= cfg.ambiguousThreshold) return 'AMBIGUOUS';
  return 'INCORRECT';
}

export async function runRagPipeline(
  store: Store,
  options: RetrieveOptions,
  provider: LlmProvider = getLlmProvider(),
): Promise<{ result: AnswerResult; meta: PipelineMeta }> {
  const started = Date.now();
  const cfg = getRagConfig();
  const intent = classifyIntent(options.question);

  const meta: PipelineMeta = {
    retrievalQuality: null,
    retryCount: 0,
    selfRagDecisions: [],
    cragActions: [],
    retrievedChunks: [],
    faithfulnessScore: null,
    answerRelevancyScore: null,
    contextPrecision: null,
    hallucinationFindings: [],
    processingTimeMs: 0,
  };

  // Conversational / unclear: no retrieval.
  if (intent.kind === 'conversational') {
    const answer = pickReply(intent.smallTalk, options.question);
    const result = directResult(answer, provider);
    meta.processingTimeMs = Date.now() - started;
    result.meta = meta;
    return { result, meta };
  }
  if (intent.kind === 'unclear') {
    const result = directResult(CLARIFY_REPLY, provider);
    meta.processingTimeMs = Date.now() - started;
    result.meta = meta;
    return { result, meta };
  }

  const selfRagEnabled = cfg.selfRagEnabled;
  if (selfRagEnabled) meta.selfRagDecisions.push('retrieval-necessary:true');

  const maxRetries = selfRagEnabled ? cfg.maxRetries : 0;
  let attempt = 0;
  let currentQuestion = options.question;
  let combined: ScoredChunk[] = [];
  let quality: 'CORRECT' | 'AMBIGUOUS' | 'INCORRECT' = 'INCORRECT';

  while (true) {
    const ctx = await retrieveContext(store, { ...options, question: currentQuestion });
    const chunks = ctx.chunks;
    quality = gradeRetrieval(chunks, options.question);
    meta.retrievalQuality = quality;

    if (cfg.cragEnabled && quality === 'INCORRECT') {
      meta.cragActions.push('INCORRECT');
      if (attempt >= maxRetries) {
        meta.selfRagDecisions.push('abstain:no-evidence');
        const result = directResult(withGreeting(FALLBACK_REPLY, intent.greeting, options.question), provider);
        meta.retrievedChunks = [];
        meta.faithfulnessScore = 1;
        meta.answerRelevancyScore = answerRelevancy(options.question, result.answer);
        meta.processingTimeMs = Date.now() - started;
        meta.retryCount = attempt;
        result.meta = meta;
        return { result, meta };
      }
      meta.cragActions.push('rewrite-query');
      currentQuestion = rewriteQuery(options.question, chunks);
      attempt += 1;
      meta.retryCount = attempt;
      continue;
    }

    if (cfg.cragEnabled && quality === 'AMBIGUOUS') {
      meta.cragActions.push('AMBIGUOUS');
      const rewritten = rewriteQuery(options.question, chunks);
      const extraCtx = await retrieveContext(store, { ...options, question: rewritten });
      const map = new Map<string, ScoredChunk>();
      for (const c of chunks) map.set(c.chunk.id, c);
      for (const c of extraCtx.chunks) {
        const existing = map.get(c.chunk.id);
        if (!existing || c.score > existing.score) map.set(c.chunk.id, c);
      }
      combined = [...map.values()].sort((a, b) => b.score - a.score).slice(0, options.limit ?? env.VECTOR_LIMIT);
      meta.cragActions.push('additional-retrieval');
    } else {
      combined = chunks;
    }

    meta.retrievedChunks = combined;

    const threshold = cfg.ambiguousThreshold;
    let contextChunks = combined.filter((c) => c.score >= threshold);
    if (!contextChunks.length) contextChunks = combined.slice(0, Math.min(3, combined.length));

    if (!contextChunks.length) {
      const result = directResult(withGreeting(FALLBACK_REPLY, intent.greeting, options.question), provider);
      meta.faithfulnessScore = 1;
      meta.answerRelevancyScore = answerRelevancy(options.question, result.answer);
      meta.processingTimeMs = Date.now() - started;
      meta.retryCount = attempt;
      result.meta = meta;
      return { result, meta };
    }

    const { prompt } = buildPrompt(options.question, contextChunks);
    const citations = buildCitations(contextChunks);

    const raw = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const answerText = isTechnicalFallback(raw) ? FALLBACK_REPLY : raw;

    // Self-reflection
    let faithful = true;
    let unsupported: string[] = [];
    if (selfRagEnabled && answerText !== FALLBACK_REPLY) {
      const fr = checkFaithfulness(answerText, contextChunks);
      faithful = fr.score >= 0.5;
      unsupported = fr.unsupportedClaims;
      meta.faithfulnessScore = fr.score;
      meta.hallucinationFindings = unsupported;
      meta.selfRagDecisions.push(`faithfulness:${fr.score.toFixed(2)}`);
      if (!faithful && attempt < maxRetries) {
        meta.selfRagDecisions.push('retry:unfaithful');
        currentQuestion = rewriteQuery(options.question, contextChunks);
        attempt += 1;
        meta.retryCount = attempt;
        continue;
      }
    }

    if (answerText === FALLBACK_REPLY) {
      meta.faithfulnessScore = 1;
      meta.hallucinationFindings = [];
    }

    const finalAnswer = withGreeting(applyCleanResponseFormatting(answerText), intent.greeting, options.question);
    const finalCitations = isTechnicalFallback(raw) ? [] : alignCitationsToAnswer(raw, citations);

    const result: AnswerResult = {
      answer: finalAnswer,
      citations: finalCitations,
      retrievedCount: contextChunks.length,
      usedProvider: provider.name,
      usedModel: provider.model,
    };

    meta.retrievedChunks = contextChunks;
    meta.retrievalQuality = quality;
    meta.retryCount = attempt;
    meta.answerRelevancyScore = answerRelevancy(options.question, finalAnswer);
    meta.contextPrecision = contextPrecision(contextChunks, raw);
    meta.hallucinationFindings = unsupported;
    meta.processingTimeMs = Date.now() - started;
    result.meta = meta;
    return { result, meta };
  }
}

export async function answerQuestion(
  store: Store,
  options: RetrieveOptions,
  provider: LlmProvider = getLlmProvider(),
): Promise<AnswerResult> {
  const { result } = await runRagPipeline(store, options, provider);
  return result;
}

export async function* streamAnswer(
  store: Store,
  options: RetrieveOptions,
  provider: LlmProvider = getLlmProvider(),
): AsyncGenerator<{ type: 'citations' | 'delta' | 'done'; payload: unknown }> {
  const { result } = await runRagPipeline(store, options, provider);

  yield { type: 'citations', payload: { citations: result.citations, retrievedCount: result.retrievedCount } };

  let text = '';
  for (const part of wordGroups(result.answer)) {
    text += part;
    yield { type: 'delta', payload: { text: part } };
  }
  yield { type: 'done', payload: { citations: result.citations, answerLength: text.length } };
}
