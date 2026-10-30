/**
 * Clean response formatting rule.
 *
 * Every user-facing answer must be clean, direct, natural prose:
 *
 *   - no bracketed citation markers ([1], [2][3], [1, 2], full-width variants),
 *   - no footnote-style source labels, source counts or "source 3" wording,
 *   - no trailing "Sources:" / "References:" / "Bibliography:" section,
 *   - no technical artifacts (double spaces, stray punctuation) left behind
 *     once markers are removed.
 *
 * The LLM still emits inline [n] markers while drafting: they are the
 * pipeline's grounding signal, and `alignCitationsToAnswer()` in rag.ts uses
 * them to keep only passages that actually support the answer. This module is
 * the presentation layer on top of that - the raw answer is cleaned before it
 * is returned, streamed or rendered, so the rule never breaks citation
 * alignment.
 *
 * The one artifact code cannot fully repair mid-sentence is prose that reads
 * like "rates [1], [2] and [3] rose": removing the markers leaves "rates, and
 * rose" behind. SYSTEM_PROMPT forbids that phrasing; the cleaner makes
 * whatever remains as tidy as possible.
 */

/**
 * Citation markers in every style models actually emit: ASCII [1], full-width
 * ［1］ and 【1】, consecutive runs [1][2][3], comma/semicolon lists [1, 2]
 * and ranges [1-3]. Two-digit markers only, matching the recognition window
 * of `alignCitationsToAnswer()`.
 */
const CITATION = new RegExp(
  [
    "(?:[\\[［【]\\s*\\d{1,2}\\s*[\\]］】])+",
    "[\\[［【]\\s*\\d{1,2}(?:\\s*[,;]\\s*\\d{1,2})+\\s*[\\]］】]",
    "[\\[［【]\\s*\\d{1,2}\\s*[-–—]\\s*\\d{1,2}\\s*[\\]］】]",
  ].join('|'),
  'g',
);

/**
 * Optional markdown/list decorations in front of (and around) a standalone
 * section heading: ###, >, -, bold and italic markers, list numbering.
 */
const HEADING_DECORATION_PREFIX = '(?:[#>*•\\-]+\\s*|\\d{1,2}\\.\\s*)*';
const HEADING_BOLD = '(?:\\*\\*|__|\\*|_)?';
const HEADING_KEYWORD =
  '(?:sources?|references?|reference list|bibliography|works? cited|further reading|citations?|cited sources)';

/**
 * A standalone source-section heading: "Sources:", "## References", "**Works
 * Cited**", "- Further reading", "2. Citations", and similar. The keyword must
 * stand alone on its line, so ordinary prose like "see the references below
 * the table" is never mistaken for a section title.
 */
const SOURCE_HEADING_LINE = new RegExp(
  `^\\s*${HEADING_DECORATION_PREFIX}${HEADING_BOLD}${HEADING_KEYWORD}${HEADING_BOLD}[:,#*_\\-—>\\s]*$`,
  'i',
);

/**
 * A line that has only started and could still grow into a standalone heading,
 * e.g. "Referen" or "**Sour". Used by the streaming formatter to hold such a
 * line back instead of emitting half a heading it may later have to remove.
 */
const SOURCE_HEADING_PENDING = new RegExp(
  `^\\s*(?:[#>*•\\-]+\\s*|\\d{1,2}\\.\\s*)*(?:\\*\\*|__|\\*|_)?(?:source|sorc|refer|resour|bibli|work|further|citat|cites?|cited)`,
  'i',
);

/**
 * Longest line we keep suspecting could become a standalone heading. Past
 * this, with no newline seen, the line is prose and emission resumes.
 */
const MAX_HEADING_LENGTH = 40;

/** Bracket characters that can open a citation marker. */
const OPENING_BRACKETS = new Set(['[', '［', '【']);
/** Bracket characters that close a citation marker. */
const CLOSING_BRACKETS = new Set([']', '］', '】']);

function stripCitationMarkers(text: string): string {
  return text.replace(CITATION, '');
}

/**
 * A parenthetical whose content was nothing but a citation pointer:
 * "(see [3])", "([1], [4])", "(cf. [2])". With its citation gone it carries no
 * meaning, so the whole husk is dropped - not repaired into "(see)".
 */
const PAREN_WITH_MARKER_ONLY = new RegExp(
  `\\(\\s*(?:see|cites?|cf\\.?|ref(?:erences?|s?)?|sources?|source of)?\\s*(?:${CITATION.source}` +
    `(?:\\s*[,;.-]\\s*(?:${CITATION.source}))*)\\s*[,.]?\\s*\\)`,
  'gi',
);

/**
 * Repair the glue text left behind where markers used to be.
 *
 * `trimRight` controls what happens at the end of a segment:
 *   - `'preserve'`: leave the raw tail so the caller's holdback can decide
 *     whether trailing whitespace/separator is fused with the next segment;
 *   - `'trim'`: whitespace goes (batch/inline use);
 *   - `'sever'`: whitespace and any dangling [,;] go (final text).
 * `trimLeft` is `'preserve'` for streamed segments (the leading whitespace is
 * the separator left from the previous emission) and `'trim'` for full text.
 */
type TrimLeft = 'trim' | 'preserve';
type TrimRight = 'preserve' | 'trim' | 'sever';

function tidyPunctuation(text: string, trimLeft: TrimLeft = 'trim', trimRight: TrimRight = 'trim'): string {
  let cleaned = text
    // Parentheticals that were only a citation pointer: drop the husk BEFORE
    // the markers they contain are removed (otherwise "(see [3])" first
    // degrades into an empty "(see )" husk nobody can trace back).
    .replace(PAREN_WITH_MARKER_ONLY, '')
    // Remove every citation marker.
    .replace(CITATION, '')
    // "( )" and "( )" had their content removed or emptied: drop what is left.
    .replace(/\(\s*[,;.]?\s*\)|（\s*[,;.]?\s*）/g, '')
    // " , , " style punctuation runs collapse to one mark.
    .replace(/([,;:.!?])(?:\s*\1)+/g, '$1')
    // No space before sentence punctuation ("rates ," -> "rates,").
    .replace(/[^\S\n]+([,.;:!?])/g, '$1')
    // Closing parenthesis cuddles back to the preceding word ("(see )" -> "(see)").
    .replace(/([^\s()[\]］【】])\s+\)/g, '$1)')
    // Collapse runs of spaces/tabs a removed marker leaves behind (newlines kept).
    .replace(/[^\S\n]{2,}/g, ' ')
    // More than one blank line between paragraphs is noise.
    .replace(/\n{3,}/g, '\n\n');
  if (trimRight !== 'preserve') {
    cleaned = cleaned.replace(/\s+$/, '');
    if (trimRight === 'sever') cleaned = cleaned.replace(/[,;]+$/, '');
  }
  if (trimLeft === 'trim') cleaned = cleaned.replace(/^\s+/, '');
  return cleaned;
}

function cleanText(text: string, trimLeft: TrimLeft = 'trim', trimRight: TrimRight = 'trim'): string {
  return tidyPunctuation(text, trimLeft, trimRight);
}

/**
 * Whether a line is the standalone title of a source section. Two shapes
 * count: a bare keyword-only heading ("## References"), and a keyword whose
 * trailing content is nothing but citation markers ("Sources: [1], [2]" -
 * recognized by stripping the markers and re-testing, which cannot match
 * ordinary prose because the extra words survive).
 */
function isSourceHeadingLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (SOURCE_HEADING_LINE.test(text)) return true;
  const bare = tidyPunctuation(stripCitationMarkers(text));
  return bare.length > 0 && bare !== text && SOURCE_HEADING_LINE.test(bare);
}

/**
 * Drop the trailing source list the model added despite the prompt.
 *
 * Returns the answer up to (not including) the LAST standalone source-section
 * heading line, or `null` when no such heading exists. A heading followed by
 * real content (never legitimate) loses that content too - there is no
 * meaningful case where paragraphs continue below a references heading.
 */
function stripTrailingSourceSection(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSourceHeadingLine(lines[i] ?? '')) {
      return lines.slice(0, i).join('\n');
    }
  }
  return null;
}

/**
 * Full-text form of the rule. Use for complete answers, e.g. the
 * non-streaming `/api/chat` response after citation alignment.
 */
export function applyCleanResponseFormatting(answer: string): string {
  const cut = stripTrailingSourceSection(answer);
  if (cut !== null) {
    const cleaned = cleanText(cut);
    if (cleaned) return cleaned;
    // Degenerate: the model produced nothing but a source list. Prefer
    // showing it without the markers over rendering an empty message.
  }
  return cleanText(answer);
}

/**
 * Incremental form of the rule for Server-Sent Events streaming.
 *
 * The model's tokens are observed as they arrive; `push()` returns exactly the
 * text that is safe to show already, and `flush()` returns whatever remains at
 * the end of the stream. Concatenating every output yields the same result as
 * running the full rule over the complete answer.
 */
export class CleanResponseFormatter {
  /** Unemitted tail of the answer, kept so cleanup can look behind. */
  #buffer = '';
  /**
   * Emission stays this far away from the buffer end: a citation marker (at
   * most ~12 visible chars) plus its trailing punctuation must be fully in
   * hand before the text in front of it is finalized and sent.
   */
  static readonly HOLD = 32;
  /** Maximum characters scanned backwards for an unclosed marker opener. */
  static readonly LOOKBACK = 30;
  /** Set once a trailing source-section heading has been recognized. */
  #suppressing = false;

  /** Feed one model delta; returns what may be shown now (possibly ''). */
  push(delta: string): string {
    if (!delta) return '';
    this.#buffer += delta;
    return this.#drain();
  }

  /** End of stream: emit and clean whatever is still held back. */
  flush(): string {
    if (this.#suppressing) {
      this.#buffer = '';
      return '';
    }
    const text = this.#buffer;
    this.#buffer = '';
    // A final line without its newline can itself be the bare heading
    // ("Sources:"), because nothing can follow it any more.
    const heading = findLastHeadingStart(text, /* allowIncompleteLine */ true);
    if (heading !== null) {
      this.#suppressing = true;
      return heading.finalText;
    }
    // The model stopped mid-marker ("...funding [1"): drop the orphan opener.
    // Leading whitespace is preserved: it is the separator between the text
    // already shown and what is being flushed.
    return tidyPunctuation(stripOrphanMarkerOpener(stripCitationMarkers(text)), 'preserve', 'sever');
  }

  /** Emit the safe prefix of the buffer; returns '' when nothing is safe yet. */
  #drain(): string {
    if (this.#suppressing) {
      this.#buffer = '';
      return '';
    }

    // A completed heading line cuts the answer short from that point on; text
    // before it (cleaned) is safe regardless of the hold zone.
    const heading = findLastHeadingStart(this.#buffer, /* allowIncompleteLine */ false);
    if (heading !== null) {
      this.#suppressing = true;
      this.#buffer = '';
      return heading.finalText;
    }

    // The in-progress line could still grow into a bare heading: hold it.
    const pending = this.#buffer.split('\n').pop() ?? '';
    if (
      pending.length > 0 &&
      SOURCE_HEADING_PENDING.test(pending) &&
      pending.trim().length <= MAX_HEADING_LENGTH
    ) {
      return '';
    }

    if (this.#buffer.length < CleanResponseFormatter.HOLD) return '';

    const cut = this.#retreatFromUnclosedMarker();
    let safe = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    // The tail is deliberately not trimmed: everything from the last real
    // character onward is held back. Whitespace, one trailing separator and
    // trailing newlines stay pending so the next segment can fuse onto them
    // ("x [1]," + " [2]" must emit "x," and " and" - never "x , ," or
    // "x,and") and paragraph breaks survive cut boundaries.
    safe = tidyPunctuation(stripCitationMarkers(safe), 'preserve', 'preserve');
    const hold = safe.match(/(?:[^\S\n]*[,;])?[^\S\n]*(?:\n{1,2})?$/)?.[0] ?? '';
    safe = safe.slice(0, safe.length - hold.length);
    this.#buffer = hold + this.#buffer;
    return safe;
  }

  /**
   * Move the cut point back so it never lands inside an open citation marker:
   * scanning backwards across the boundary region, an opener found before any
   * closer means a marker straddles the boundary and must be kept unemitted.
   */
  #retreatFromUnclosedMarker(): number {
    const cut = Math.max(0, this.#buffer.length - CleanResponseFormatter.HOLD);
    for (let i = cut - 1, lookahead = 0; i >= 0 && lookahead < CleanResponseFormatter.LOOKBACK; i--, lookahead++) {
      const ch = this.#buffer[i] ?? '';
      if (CLOSING_BRACKETS.has(ch)) break;
      if (OPENING_BRACKETS.has(ch)) return i;
    }
    return cut;
  }
}

/** Remove an orphaned, never-closed citation-marker opener at the very end. */
function stripOrphanMarkerOpener(text: string): string {
  return text.replace(/[［[][\d\s,;]*$/, '');
}

/**
 * Find the last standalone source-section heading in `text` and return the
 * cleaned text before it, or `null` when there is none. With
 * `allowIncompleteLine`, a final line without a trailing newline ("Sources:")
 * can also count as the heading; otherwise only complete lines are examined,
 * because an unfinished line may yet turn out to be ordinary prose.
 */
function findLastHeadingStart(
  text: string,
  allowIncompleteLine: boolean,
): { finalText: string } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i === lines.length - 1 && !allowIncompleteLine) break;
    if (isSourceHeadingLine(lines[i] ?? '')) {
      // Nothing meaningful can sit before a leading heading: an answer that
      // starts with its own source list is degenerate, so fall through to
      // ordinary marker cleanup instead of suppressing the whole answer.
      const finalText = tidyPunctuation(
        stripCitationMarkers(lines.slice(0, i).join('\n')),
        'trim',
        'sever',
      );
      if (!finalText) return null;
      return { finalText };
    }
  }
  return null;
}
