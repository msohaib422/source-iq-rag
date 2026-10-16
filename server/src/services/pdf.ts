/**
 * PDF text extraction.
 *
 * Built on `unpdf` (a maintained server-side wrapper around pdf.js) rather than
 * the older `pdf-parse`, which ships a module-load side effect that attempts to
 * read a bundled test fixture and is unreliable under ESM/bundled execution.
 */
import { extractText, getDocumentProxy } from 'unpdf';

export interface ExtractedPdf {
  text: string;
  pageCount: number;
  /** Cumulative character offsets marking the start of each page. */
  pageBoundaries: number[];
}

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractionError';
  }
}

function looksLikePdf(buffer: Buffer): boolean {
  // Every valid PDF starts with the %PDF- magic marker.
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdf> {
  if (!looksLikePdf(buffer)) {
    throw new PdfExtractionError('The uploaded file is not a valid PDF (missing %PDF- header).');
  }
  if (buffer.length === 0) {
    throw new PdfExtractionError('The uploaded file is empty.');
  }

  let document: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    document = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    throw new PdfExtractionError(`Failed to open the PDF: ${(err as Error)?.message ?? 'unknown error'}`, {
      cause: err,
    });
  }

  const totalPages = document.numPages;
  if (!totalPages || totalPages < 1) {
    throw new PdfExtractionError('The PDF contains no pages.');
  }

  // `mergePages: false` yields one string per page, which lets us track page
  // boundaries for citations. unpdf extracts the whole document in one pass;
  // we then re-join the pages ourselves so the offsets stay exact.
  let pageTexts: string[];
  try {
    const { text } = await extractText(document, { mergePages: false });
    pageTexts = text ?? [];
  } catch (err) {
    throw new PdfExtractionError(`Failed to extract text from the PDF: ${(err as Error)?.message}`, { cause: err });
  }

  if (pageTexts.length !== totalPages) {
    // Defensive: keep going with whatever we got, but do not silently mismatch.
    pageTexts = pageTexts.slice(0, totalPages);
    while (pageTexts.length < totalPages) pageTexts.push('');
  }

  const pageBoundaries: number[] = [];
  let cursor = 0;
  let combined = '';
  pageTexts.forEach((pageText, index) => {
    if (index > 0) combined += '\n\n';
    pageBoundaries.push(cursor);
    cursor += pageText.length + (index > 0 ? 2 : 0);
    combined += pageText;
  });

  if (combined.trim().length === 0) {
    throw new PdfExtractionError(
      'No selectable text found. The PDF is most likely a scanned image - SourceIQ reads text PDFs, not OCR output.',
    );
  }

  return { text: combined, pageCount: totalPages, pageBoundaries };
}