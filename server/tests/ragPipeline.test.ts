import { describe, expect, it } from 'vitest';
import type { ScoredChunk } from '../src/types/domain.js';
import { gradeRetrieval, rewriteQuery } from '../src/services/rag.js';

function chunk(text: string, score: number): ScoredChunk {
  return {
    chunk: {
      id: Math.random().toString(36).slice(2),
      documentId: 'd',
      userId: 'u',
      ordinal: 0,
      text,
      embedding: [],
      page: null,
      charStart: null,
      charEnd: null,
      edited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    score,
  };
}

describe('CRAG grading', () => {
  it('CORRECT when high score and overlap', () => {
    const chunks = [chunk('cotton irrigation consumed 2500 cubic metres water', 0.8)];
    expect(gradeRetrieval(chunks, 'how much water cotton irrigation')).toBe('CORRECT');
  });
  it('INCORRECT when no chunks', () => {
    expect(gradeRetrieval([], 'anything')).toBe('INCORRECT');
  });
  it('AMBIGUOUS or INCORRECT for low score', () => {
    const chunks = [chunk('totally unrelated text about rockets', 0.1)];
    const g = gradeRetrieval(chunks, 'scholarship deadline');
    expect(['AMBIGUOUS', 'INCORRECT']).toContain(g);
  });
});

describe('query rewriting', () => {
  it('expands query with chunk terms', () => {
    const chunks = [chunk('scholarship deadline application process', 0.5)];
    const rw = rewriteQuery('scholarship', chunks);
    expect(rw).toContain('scholarship');
    expect(rw.length).toBeGreaterThan('scholarship'.length);
  });
});