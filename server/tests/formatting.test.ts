/**
 * Clean response formatting rule.
 *
 * The user-visible answer must be clean prose: no bracketed citation markers,
 * no trailing source sections, no glue artifacts. Citation alignment still
 * runs on the raw model answer, so the visible text and the citation list can
 * be validated independently here.
 */
import { describe, expect, it } from 'vitest';
import { CleanResponseFormatter, applyCleanResponseFormatting } from '../src/services/formatting.js';

describe('applyCleanResponseFormatting - citation markers', () => {
  it('strips plain ASCII markers without leaving double spaces', () => {
    expect(applyCleanResponseFormatting('Revenue grew by 5% [1] in 2024.')).toBe('Revenue grew by 5% in 2024.');
    expect(applyCleanResponseFormatting('The policy [1][2] is in force.')).toBe('The policy is in force.');
  });

  it('strips comma, semicolon and range groups some models emit', () => {
    expect(applyCleanResponseFormatting('Costs fell [1, 2] across the board.')).toBe('Costs fell across the board.');
    expect(applyCleanResponseFormatting('Costs fell [1; 3] again.')).toBe('Costs fell again.');
    expect(applyCleanResponseFormatting('Costs fell [1-3] overall.')).toBe('Costs fell overall.');
  });

  it('recognises the full-width brackets 【】 and ［］', () => {
    expect(applyCleanResponseFormatting('Growth continued 【1】 after the merger.')).toBe(
      'Growth continued after the merger.',
    );
    expect(applyCleanResponseFormatting('Growth continued ［2］ after the merger.')).toBe(
      'Growth continued after the merger.',
    );
  });

  it('keeps punctuation tidy where markers touched it', () => {
    expect(applyCleanResponseFormatting('The rate is 5% [1], while funding continued.')).toBe(
      'The rate is 5%, while funding continued.',
    );
    expect(applyCleanResponseFormatting('Supported by passage [1]. Unrelated.')).toBe('Supported by passage. Unrelated.');
  });

  it('repairs parentheses whose citation was removed', () => {
    expect(applyCleanResponseFormatting('(see [3]) applies here.')).toBe('applies here.');
    expect(applyCleanResponseFormatting('The clause (see [3]) applies.')).toBe('The clause applies.');
    expect(applyCleanResponseFormatting('The clause ([3]) applies.')).toBe('The clause applies.');
    // Parentheses with real content keep it.
    expect(applyCleanResponseFormatting('The clause (see [3] and the annex) applies.')).toBe(
      'The clause (see and the annex) applies.',
    );
  });

  it('never touches numbers that are not citation markers', () => {
    expect(applyCleanResponseFormatting('Section 3 lists 2 targets and 10 deadlines.')).toBe(
      'Section 3 lists 2 targets and 10 deadlines.',
    );
    expect(applyCleanResponseFormatting('Revenue from 2019 to 2024 was 2500 million.')).toBe(
      'Revenue from 2019 to 2024 was 2500 million.',
    );
  });
});

describe('applyCleanResponseFormatting - trailing source sections', () => {
  it('removes a bare "Sources:" section and everything below it', () => {
    expect(applyCleanResponseFormatting('The fee is 2500.\n\nSources:\n[1] Fees 2026\n[2] Handbook')).toBe(
      'The fee is 2500.',
    );
  });

  it('removes markdown, bold and list-style headings', () => {
    expect(applyCleanResponseFormatting('Answer body.\n\n## References\n\n[1] Report')).toBe('Answer body.');
    expect(applyCleanResponseFormatting('Answer body.\n\n**Works Cited**\n[1] Report')).toBe('Answer body.');
    expect(applyCleanResponseFormatting('Answer body.\n\n- Further reading\n[1] Report')).toBe('Answer body.');
  });

  it('removes a one-line labeled citation list', () => {
    expect(applyCleanResponseFormatting('The fee is 2500.\n\nSources: [1], [2]')).toBe('The fee is 2500.');
  });

  it('never treats ordinary prose that mentions sources as a heading', () => {
    expect(
      applyCleanResponseFormatting('See the references below the table. The fee is 2500.'),
    ).toBe('See the references below the table. The fee is 2500.');
    expect(
      applyCleanResponseFormatting('The fee is 2500. Sources for this claim are listed in the appendix.'),
    ).toBe('The fee is 2500. Sources for this claim are listed in the appendix.');
  });

  it('preserves content that lies before a mid-answer heading', () => {
    expect(applyCleanResponseFormatting('First the fees.\n\nBibliography\n[1] Fees\nSecond, staffing.')).toBe(
      'First the fees.',
    );
  });

  it('keeps a message usable when the answer is nothing but a source list', () => {
    const cleaned = applyCleanResponseFormatting('## Sources\n[1] Annual report\n[2] Handbook');
    expect(cleaned).not.toBe('');
    expect(cleaned).not.toMatch(/\[\d\]/);
  });
});

describe('CleanResponseFormatter', () => {
  /** The concatenated output must equal streaming the fully cleaned answer. */
  function stream(chunks: string[]): string {
    const formatter = new CleanResponseFormatter();
    let out = '';
    for (const chunk of chunks) out += formatter.push(chunk);
    return out + formatter.flush();
  }

  it('matches the full-text rule for an answer streamed in arbitrary pieces', () => {
    const raw = 'Revenue grew by 5% [1] in 2024, according to [2]. Auditors agreed [1][2].';
    // Split mid-marker, mid-group, at spaces and inside words.
    const pieces = raw.match(/\S+\s*/g) ?? [raw];
    expect(stream(pieces)).toBe(applyCleanResponseFormatting(raw));
    // A 1-char split is the worst case for lookahead.
    expect(stream([...raw]).replace(/\n{3,}/g, '\n\n')).toBe(applyCleanResponseFormatting(raw));
  });

  it('never lets a marker appear in the visible stream, split across deltas', () => {
    const visible = stream(['The rate is 5% [', '1], while funding ', 'continued.']);
    expect(visible).toBe('The rate is 5%, while funding continued.');
  });

  it('holds back a line that may still become a Sources heading', () => {
    // The heading line is resolved only when its newline confirms a section;
    // up to that point nothing that arrives after it may have been emitted.
    const visible = stream(['Facts are stated.\n\nSources', ':\n[1] Internal memo']);
    expect(visible).toBe('Facts are stated.');
    expect(visible).not.toContain('Sources');
  });

  it('releases a non-heading line that merely started like one', () => {
    const visible = stream([
      'Facts are stated.\n\nReference material says the fee is 2500 and deadlines apply from [1].',
    ]);
    expect(visible).toContain('Reference material says the fee is 2500');
    expect(visible).not.toMatch(/\[\d\]/);
  });

  it('handles a comma list of citations spanning many deltas', () => {
    const visible = stream(['Costs fell [1', ', 2', ', 3], while demand held.']);
    expect(visible).toBe('Costs fell, while demand held.');
  });

  it('clothes a citation cluster placed between markers', () => {
    const visible = stream(['Rates [1], [2], and [3] rose.']);
    expect(visible).toBe('Rates, and rose.');
  });

  it('cleans an answer that ends mid-marker', () => {
    // The stream died with the marker unclosed: drop the orphan opener.
    expect(stream(['Funding continued [1'])).toBe('Funding continued');
    expect(stream(['Funding continued [1, 2'])).toBe('Funding continued');
  });

  it('leaves legitimate bracket prose alone', () => {
    expect(stream(['The committee [chair and members] met again.'])).toBe(
      'The committee [chair and members] met again.',
    );
    expect(applyCleanResponseFormatting('Values outside [110, 120] were excluded.')).toBe(
      'Values outside [110, 120] were excluded.',
    );
  });
});
