import { describe, expect, it } from 'vitest';
import { chunkText, normalizeWhitespace, pageForOffset } from '../src/services/chunker.js';

describe('normalizeWhitespace', () => {
  it('collapses PDF line-wrapping while keeping paragraphs', () => {
    const input = 'First line\n  wrapped   here\n\n\nSecond   paragraph\n';
    const out = normalizeWhitespace(input);
    expect(out).toBe('First line wrapped here\n\nSecond paragraph');
  });

  it('handles empty input', () => {
    expect(normalizeWhitespace('   \n\n  ')).toBe('');
  });
});

describe('chunkText', () => {
  const options = { size: 200, overlap: 40 };

  it('returns a single chunk when text fits', () => {
    const text = 'A short document.';
    const chunks = chunkText(text, options);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('A short document.');
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(text.length);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('', options)).toEqual([]);
    expect(chunkText('    ', options)).toEqual([]);
  });

  it('splits long text into chunks within the size budget', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} describing the topic.`).join(' ');
    const chunks = chunkText(text, options);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(options.size);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('preserves reading order and non-overlapping offsets', () => {
    const text = Array.from({ length: 120 }, (_, i) => `Line ${i}.`).join(' ');
    const chunks = chunkText(text, options);

    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
    }
  });

  it('applies overlap so boundary content is retrievable', () => {
    const text = Array.from({ length: 150 }, (_, i) => `Fact ${i} about the subject.`).join(' ');
    const chunks = chunkText(text, options);

    // Consecutive chunks must share some content thanks to the overlap window.
    const firstTail = chunks[0]!.text.split(' ').slice(-8).join(' ');
    const secondText = chunks[1]!.text;
    const shared = firstTail
      .split(' ')
      .filter((word) => word.length > 3 && secondText.includes(word));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('prefers paragraph and sentence boundaries over mid-word cuts', () => {
    const text = `${'Alpha beta gamma delta. '.repeat(20)}\n\n${'Epsilon zeta eta theta. '.repeat(20)}`;
    const chunks = chunkText(text, { size: 180, overlap: 20 });
    for (const chunk of chunks) {
      expect(chunk.text.trim()).not.toMatch(/^[a-z]{1,3}\b.*\b[a-z]{1,3}$/);
    }
  });

  it('handles a single very long unbroken token without hanging', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text, { size: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 300)).toBe(true);
  });

  it('always makes forward progress even with an extreme overlap ratio', () => {
    // overlap (95) is nearly the whole size (100). Each chunk must still advance,
    // so the loop terminates instead of spinning forever.
    const chunks = chunkText('word '.repeat(400), { size: 100, overlap: 95 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
    }
  });

  it('keeps chunk counts proportional with the production settings', () => {
    // Production defaults: size 900, overlap 150 -> ~750 chars of progress.
    const text = 'Sentence about the subject matter. '.repeat(300);
    const chunks = chunkText(text, { size: 900, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(text.length / 650);
  });
});

describe('pageForOffset', () => {
  const boundaries = [0, 100, 250, 400];

  it('maps offsets to 1-based page numbers', () => {
    expect(pageForOffset(0, boundaries)).toBe(1);
    expect(pageForOffset(99, boundaries)).toBe(1);
    expect(pageForOffset(100, boundaries)).toBe(2);
    expect(pageForOffset(300, boundaries)).toBe(3);
    expect(pageForOffset(999, boundaries)).toBe(4);
  });

  it('returns null when page data is unavailable', () => {
    expect(pageForOffset(10, [])).toBeNull();
  });
});