/** LLM provider factory and offline provider behaviour. */
import { describe, expect, it } from 'vitest';
import { MockExtractiveProvider } from '../src/services/llm/mock.js';
import { buildPrompt, SYSTEM_PROMPT, alignCitationsToAnswer, classifyIntent } from '../src/services/rag.js';
import type { Citation, ScoredChunk } from '../src/types/domain.js';

function fakeChunk(ordinal: number, text: string): ScoredChunk {
  return {
    chunk: {
      id: `chunk-${ordinal}`,
      documentId: 'doc-1',
      userId: 'user-1',
      ordinal,
      text,
      embedding: new Array(384).fill(0.01),
      page: ordinal + 1,
      charStart: 0,
      charEnd: text.length,
      edited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    score: 1 - ordinal * 0.1,
  };
}

describe('buildPrompt', () => {
  it('numbers passages and includes metadata for citation resolution', () => {
    const { prompt } = buildPrompt('What is the process?', [
      fakeChunk(0, 'The process begins with extraction.'),
      fakeChunk(1, 'Then the data is chunked.'),
    ]);

    expect(prompt).toContain('[1 | source:');
    expect(prompt).toContain('[2 | source:');
    expect(prompt).toContain('chunk: 1');
    expect(prompt).toContain('relevance: 1.0000');
    expect(prompt).toContain('Question: What is the process?');
  });

  it('handles the no-results case explicitly', () => {
    const { prompt } = buildPrompt('Anything?', []);
    expect(prompt).toContain('no matching passages');
  });

  it('truncates very long passages', () => {
    const { prompt } = buildPrompt('q', [fakeChunk(0, 'x'.repeat(5000))]);
    expect(prompt).toContain('…');
    expect(prompt.length).toBeLessThan(4000);
  });
});

describe('alignCitationsToAnswer', () => {
  const citations: Citation[] = [
    { chunkId: 'a', documentId: 'd', documentTitle: 'Doc', ordinal: 0, page: 1, score: 0.9, snippet: 'a' },
    { chunkId: 'b', documentId: 'd', documentTitle: 'Doc', ordinal: 1, page: 2, score: 0.8, snippet: 'b' },
    { chunkId: 'c', documentId: 'd', documentTitle: 'Doc', ordinal: 2, page: 3, score: 0.7, snippet: 'c' },
  ];

  it('keeps only the passages the answer actually cited', () => {
    const kept = alignCitationsToAnswer('The answer is based on [1] and [3].', citations);
    expect(kept.map((c) => c.chunkId)).toEqual(['a', 'c']);
  });

  it('returns no citation when the answer cites nothing', () => {
    // Nothing was referenced, so no passage may be presented as evidence.
    const kept = alignCitationsToAnswer('No markers here.', citations);
    expect(kept).toHaveLength(0);
  });

  it('ignores out-of-range citation numbers', () => {
    const kept = alignCitationsToAnswer('Only [9] which does not exist.', citations);
    expect(kept).toHaveLength(0);
  });

  it('recognises the full-width brackets some models emit', () => {
    expect(alignCitationsToAnswer('Grounded here 【2】.', citations).map((c) => c.chunkId)).toEqual(['b']);
    expect(alignCitationsToAnswer('Grounded here ［1］.', citations).map((c) => c.chunkId)).toEqual(['a']);
  });
});

describe('classifyIntent', () => {
  it('routes greetings and pleasantries away from retrieval', () => {
    const cases: Array<[string, string]> = [
      ['Hi', 'greeting'],
      ['Hello', 'greeting'],
      ['hey there!', 'greeting'],
      ['Good morning', 'greeting'],
      ['How are you?', 'wellbeing'],
      ["Hey, how are you?", 'wellbeing'],
      ["what's up", 'wellbeing'],
      ['Thanks', 'thanks'],
      ['thank you!', 'thanks'],
      ['Who are you?', 'identity'],
      ['what can you do', 'identity'],
      ['Goodbye', 'farewell'],
      ['ok', 'affirmation'],
    ];

    for (const [text, expected] of cases) {
      const intent = classifyIntent(text);
      expect(intent.kind, text).toBe('conversational');
      expect(intent.kind === 'conversational' && intent.smallTalk, text).toBe(expected);
    }
  });

  it('treats factual questions as knowledge questions', () => {
    for (const text of [
      "What is the university's scholarship deadline?",
      'How much did the Aral Sea shrink?',
      'Who wrote this document?',
      'Summarise the key findings.',
      // "greeting" must not make this look like small talk.
      'What is the greeting policy in this document?',
      'What about the deadlines?',
    ]) {
      expect(classifyIntent(text).kind, text).toBe('knowledge');
    }
  });

  it('keeps a leading greeting alongside a factual question', () => {
    const intent = classifyIntent('Hi, what is the scholarship deadline?');
    expect(intent.kind).toBe('knowledge');
    expect(intent.kind === 'knowledge' && intent.greeting).toBe('greeting');
  });

  it('flags messages with nothing actionable', () => {
    for (const text of ['what about it?', 'tell me more', 'why?', 'hmm']) {
      expect(classifyIntent(text).kind, text).toBe('unclear');
    }
  });

  it('is stable: the same text always classifies the same way', () => {
    expect(classifyIntent('Hi')).toEqual(classifyIntent('Hi'));
  });
});

describe('MockExtractiveProvider', () => {
  const provider = new MockExtractiveProvider();

  it('reports itself as ready without credentials', () => {
    const info = provider.info();
    expect(info.status).toBe('ready');
    expect(info.name).toBe('mock');
  });

  it('answers strictly from the supplied context', async () => {
    const { prompt } = buildPrompt('What causes the decline?', [
      fakeChunk(0, 'Fisheries declined by forty percent over two decades.'),
      fakeChunk(1, 'The Great Wall was built by successive dynasties.'),
    ]);

    const answer = await provider.complete({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] });

    expect(answer).toContain('[1]');
    expect(answer.toLowerCase()).toContain('fisheries');
    expect(answer.toLowerCase()).not.toContain('great wall');
  });

  it('streams the same answer in pieces', async () => {
    const { prompt } = buildPrompt('decline', [fakeChunk(0, 'Fisheries declined sharply.')]);
    let streamed = '';
    for await (const delta of provider.stream({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })) {
      streamed += delta;
    }
    const complete = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    expect(streamed.trim()).toBe(complete.trim());
  });

  it('declines gracefully with no context', async () => {
    const answer = await provider.complete({
      messages: [{ role: 'user', content: 'Question: anything?\n\nContext:\n(no matching passages)' }],
    });
    expect(answer).toContain('could not find any indexed sources');
  });
});