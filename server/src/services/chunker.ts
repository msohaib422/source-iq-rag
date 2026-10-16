/**
 * Recursive character chunking tuned for PDF-extracted prose.
 *
 * PDF text extraction yields hard-wrapped lines, so we normalise whitespace
 * first (keeping paragraph breaks) and then split on the largest separators that
 * fit, recursing down to words only when necessary. A configurable overlap keeps
 * sentences that straddle a boundary retrievable.
 */
export interface ChunkingOptions {
  size: number;
  overlap: number;
}

export interface TextChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Collapse PDF whitespace noise while preserving paragraph structure.
 *
 * pdf.js returns hard-wrapped lines, so a single `\n` inside a paragraph means
 * "the line broke here", not "new paragraph". We therefore:
 *   1. normalise line endings and strip NUL / soft-hyphen noise,
 *   2. collapse runs of spaces and tabs,
 *   3. trim whitespace around every newline,
 *   4. collapse runs of 2+ newlines into a paragraph marker,
 *   5. turn any remaining *single* newline into a space (unwrapping),
 *   6. restore the paragraph breaks.
 */
export function normalizeWhitespace(input: string): string {
  const PARAGRAPH = '\u241F';
  return (
    input
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000\u00ad]/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim()
      .replace(/\n{2,}/g, PARAGRAPH)
      .replace(/\n/g, ' ')
      .split(PARAGRAPH)
      .join('\n\n')
      .trim()
  );
}

const SEPARATORS = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ', ''] as const;

function findSplitIndex(text: string, start: number, end: number, size: number): { index: number; separator: string } {
  // Look for the last separator that still fits inside `size`.
  for (const sep of SEPARATORS) {
    if (sep === '') continue;
    let idx = text.lastIndexOf(sep, start + size);
    if (idx > start && idx + sep.length <= end) {
      return { index: idx, separator: sep };
    }
    // `lastIndexOf(needle, from)` searches backwards from `from`, so also try
    // searching from the nominal end for long separators.
    if (sep.length > 1) {
      const window = text.slice(start, end);
      const rel = window.lastIndexOf(sep, size);
      if (rel > 0) return { index: start + rel, separator: sep };
    }
  }
  return { index: -1, separator: '' };
}

/**
 * Split normalised text into overlapping chunks. Returns chunks in reading
 * order with absolute character offsets back into the *normalised* text.
 */
export function chunkText(text: string, options: ChunkingOptions): TextChunk[] {
  const normalized = normalizeWhitespace(text);
  const { size, overlap } = options;

  if (normalized.length === 0) return [];
  if (normalized.length <= size) {
    return [{ text: normalized, charStart: 0, charEnd: normalized.length }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);

    if (end < normalized.length) {
      const { index, separator } = findSplitIndex(normalized, start, end, size);
      if (index > start) {
        end = index + separator.length;
      }
    }

    const slice = normalized.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({ text: slice, charStart: start, charEnd: end });
    }

    if (end >= normalized.length) break;

    // Advance past the overlap, but always make forward progress.
    let next = end - overlap;
    if (next <= start) next = end;
    // Skip leading whitespace at the new start.
    while (next < normalized.length && /\s/.test(normalized[next] as string)) next += 1;
    start = next;
  }

  return chunks;
}

/**
 * Approximate 1-based page number for a character offset, using per-page text
 * boundaries captured during PDF extraction. Returns null when page data is
 * unavailable so citations degrade gracefully.
 */
export function pageForOffset(offset: number, pageBoundaries: number[]): number | null {
  if (!pageBoundaries.length) return null;
  for (let i = 0; i < pageBoundaries.length; i += 1) {
    const start = pageBoundaries[i] ?? 0;
    const end = pageBoundaries[i + 1] ?? Number.MAX_SAFE_INTEGER;
    if (offset >= start && offset < end) return i + 1;
  }
  return pageBoundaries.length;
}