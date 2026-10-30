/**
 * Deterministic offline provider.
 *
 * This is the default for a fresh checkout so that the entire application -
 * upload, indexing, retrieval, citations, chat UI - is usable end to end without
 * any API key. It performs *extractive* answering: it selects the sentences from
 * the retrieved chunks that best match the question. Answers are grounded in the
 * retrieved chunks (never invented), which also makes it a useful oracle for the
 * automated tests.
 */
import { LlmConfigurationError, type LlmCompletionRequest, type LlmProvider, type LlmProviderInfo } from './types.js';
import { FALLBACK_REPLY } from '../fallback.js';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'it', 'its', 'as', 'by', 'from', 'how',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'do', 'does', 'did', 'can', 'could', 'will', 'would',
  'should', 'shall', 'may', 'might', 'must', 'i', 'you', 'we', 'they', 'he', 'she', 'his', 'her', 'their', 'our',
  'your', 'my', 'me', 'us', 'them', 'about', 'into', 'over', 'under', 'there', 'here', 'so', 'not', 'no', 'yes',
]);

/**
 * Very small suffix stripper so that "declined"/"decline", "fisheries"/"fishery"
 * and similar pairs collide during scoring. This provider is a development
 * stand-in for a real LLM, so a light stemmer is proportionate — it makes the
 * offline mode genuinely useful instead of frustrating.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  // Trailing silent "e": makes decline == declined == declining.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pull the numbered context blocks apart so we can score against them.
 *
 * The prompt produced by `buildPrompt()` uses blocks of the form:
 *
 *     [1 | source: My Doc | page: 2 | chunk: 7 | relevance: 0.8123]
 *     <passage text>
 *
 * so the header is `[<n> | ...]` rather than a bare `[<n>]`.
 */
function parseContext(messages: Array<{ role: string; content: string }>) {
  const last = messages[messages.length - 1]?.content ?? '';
  const blockPattern = /\[(\d+)\s*\|[^\]]*\]\n?([\s\S]*?)(?=\n\[\d+\s*\||\n\nQuestion:|$)/g;
  const blocks = [...last.matchAll(blockPattern)];
  if (!blocks.length) return { question: last, blocks: [] as Array<{ label: string; text: string }> };
  const questionMatch = last.match(/Question:\s*([\s\S]*?)(?:\n\n|$)/);
  return {
    question: questionMatch?.[1]?.trim() ?? last,
    blocks: blocks.map((b) => ({ label: b[1] as string, text: (b[2] ?? '').trim() })),
  };
}

export class MockExtractiveProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'extractive-mock-v1';

  info(): LlmProviderInfo {
    return {
      name: this.name,
      model: this.model,
      status: 'ready',
      detail: 'Deterministic offline extractive answering - no API key required, no network calls.',
    };
  }

  private buildAnswer(request: LlmCompletionRequest): string {
    const { question, blocks } = parseContext(request.messages);
    if (!blocks.length) {
      return FALLBACK_REPLY;
    }

    const qTokens = new Set(tokenize(question));
    const scored = blocks
      .map((block) => {
        const sentences = splitSentences(block.text);
        const ranked = sentences
          .map((sentence, index) => {
            const tokens = tokenize(sentence);
            if (!tokens.length) return { sentence, index, score: 0 };
            const hits = tokens.filter((t) => qTokens.has(t)).length;
            const coverage = hits / Math.max(1, qTokens.size);
            const density = hits / Math.sqrt(tokens.length);
            return { sentence, index, score: coverage * 2 + density };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .sort((a, b) => a.index - b.index);
        return { block, ranked };
      })
      .filter((r) => r.ranked.length > 0)
      .sort((a, b) => b.ranked[0]!.score - a.ranked[0]!.score)
      .slice(0, 3);

    if (!scored.length) {
      // Grounding: the retrieved passages do not answer this question, so use
      // the friendly fallback rather than a technical refusal.
      return FALLBACK_REPLY;
    }

    const body = scored
      .map(
        ({ block, ranked }) =>
          `[${block.label}] ${ranked.map((r) => r.sentence).join(' ').replace(/\s+/g, ' ').trim()}`,
      )
      .join('\n\n');

    return `${body}\n\n_(Answer assembled locally from the retrieved passages - no external LLM was called because LLM_PROVIDER=mock.)_`;
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    if (request.signal?.aborted) throw new LlmConfigurationError('Request aborted.');
    return this.buildAnswer(request);
  }

  async *stream(request: LlmCompletionRequest): AsyncGenerator<string, void, unknown> {
    // Emit in word groups so the client's streaming path is genuinely exercised.
    const answer = this.buildAnswer(request);
    const parts = answer.match(/\S+\s*/g) ?? [answer];
    for (const part of parts) {
      if (request.signal?.aborted) return;
      yield part;
    }
  }
}