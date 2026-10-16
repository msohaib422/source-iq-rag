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

export const SYSTEM_PROMPT = [
  'You are SourceIQ, a careful research assistant that answers questions strictly from the numbered context passages supplied by the user.',
  '',
  'Grounding rules:',
  '1. Use only information that appears in the context passages. Never use outside or pretrained knowledge to fill a gap.',
  '2. If the passages do not contain the answer, say plainly that you could not find it in the available knowledge sources. Never guess a date, figure, name, policy or procedure.',
  '3. If the passages are off-topic, ambiguous or too vague to settle the question, say so instead of forcing an answer.',
  '4. If only part of a question is supported, answer the supported part and state clearly which part you could not verify.',
  '5. Be concise and factual. Quote figures, names and dates exactly as written in the passages.',
  '',
  'Citation rules:',
  '6. Cite a passage with its bracketed number, e.g. [1] or [2][3], only when that passage actually supports the claim beside it.',
  '7. Never invent a citation number that is not in the context, and never imply a source says something it does not.',
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

function noSourcesReply(question: string): string {
  const topic = question.trim().replace(/\s+/g, ' ').slice(0, 160);
  return (
    `I couldn't find information about "${topic}" in the available knowledge sources, ` +
    "so I can't answer it without guessing. Please provide a relevant document or rephrase your question."
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

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  retrievedCount: number;
  usedProvider: string;
  usedModel: string;
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

export async function answerQuestion(
  store: Store,
  options: RetrieveOptions,
  provider: LlmProvider = getLlmProvider(),
): Promise<AnswerResult> {
  const intent = classifyIntent(options.question);

  // Small talk is answered conversationally; the knowledge base is not queried.
  if (intent.kind === 'conversational') {
    return directResult(pickReply(intent.smallTalk, options.question), provider);
  }
  if (intent.kind === 'unclear') {
    return directResult(CLARIFY_REPLY, provider);
  }

  const { chunks, question } = await retrieveContext(store, options);

  // Nothing retrieved: answer deterministically rather than asking the model to
  // fill the gap from its pretrained knowledge.
  if (!chunks.length) {
    return directResult(withGreeting(noSourcesReply(question), intent.greeting, options.question), provider);
  }

  const { prompt } = buildPrompt(question, chunks);
  const citations = buildCitations(chunks);

  const answer = await provider.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return {
    answer: withGreeting(answer, intent.greeting, options.question),
    citations: alignCitationsToAnswer(answer, citations),
    retrievedCount: chunks.length,
    usedProvider: provider.name,
    usedModel: provider.model,
  };
}

export async function* streamAnswer(
  store: Store,
  options: RetrieveOptions,
  provider: LlmProvider = getLlmProvider(),
): AsyncGenerator<{ type: 'citations' | 'delta' | 'done'; payload: unknown }> {
  const intent = classifyIntent(options.question);

  // Replay a fixed reply through the same SSE frames the UI already handles.
  async function* fixed(reply: string): AsyncGenerator<{ type: 'citations' | 'delta' | 'done'; payload: unknown }> {
    yield { type: 'citations', payload: { citations: [], retrievedCount: 0 } };
    let text = '';
    for (const part of wordGroups(reply)) {
      text += part;
      yield { type: 'delta', payload: { text: part } };
    }
    yield { type: 'done', payload: { citations: [], answerLength: text.length } };
  }

  if (intent.kind === 'conversational') {
    yield* fixed(pickReply(intent.smallTalk, options.question));
    return;
  }
  if (intent.kind === 'unclear') {
    yield* fixed(CLARIFY_REPLY);
    return;
  }

  const { chunks, question } = await retrieveContext(store, options);

  if (!chunks.length) {
    yield* fixed(withGreeting(noSourcesReply(question), intent.greeting, options.question));
    return;
  }

  const { prompt } = buildPrompt(question, chunks);
  const citations = buildCitations(chunks);

  yield { type: 'citations', payload: { citations, retrievedCount: chunks.length } };

  let answer = '';
  const prefix = intent.greeting ? `${pickReply(intent.greeting, options.question)}\n\n` : '';
  if (prefix) {
    answer += prefix;
    for (const part of wordGroups(prefix)) yield { type: 'delta', payload: { text: part } };
  }

  for await (const delta of provider.stream({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] })) {
    answer += delta;
    yield { type: 'delta', payload: { text: delta } };
  }

  yield {
    type: 'done',
    payload: { citations: alignCitationsToAnswer(answer, citations), answerLength: answer.length },
  };
}