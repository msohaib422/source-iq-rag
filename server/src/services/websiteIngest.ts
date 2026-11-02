/**
 * Website ingestion via the official Firecrawl Crawl API.
 *
 * Serverless-friendly design (Vercel):
 *  - no request is ever held open while the crawl runs: the client calls
 *    `POST /api/websites/:id/advance` every couple of seconds;
 *  - each advance does one bounded slice of work (single-flight per document,
 *    ~6s budget), persists its cursor, and returns;
 *  - all job state lives on the Document (`crawl` field), so a process restart
 *    or a dropped poll resumes exactly where it stopped;
 *  - resume safety derives from the store's lightweight chunk refs (page URL +
 *    ordinal, never text): a crash between "insert chunks" and "persist state"
 *    can never duplicate chunks, and ordinals stay contiguous;
 *  - memory stays bounded: one status results page at a time, embeddings
 *    produced page by page, no full-document reads.
 *
 * Phase machine (document.crawl.phase):
 *   scraping  -> Firecrawl is crawling; advance only mirrors progress.
 *   indexing  -> crawl completed; pages are chunked/embedded incrementally.
 *   completed -> every results page consumed (document status: ready).
 *   failed    -> crawl failed/cancelled or a fatal API/pipeline error.
 */
import { SdkError, type CrawlJob, type Document as FirecrawlPage } from 'firecrawl';
import { env } from '../config/env.js';
import type { Store } from '../db/store.js';
import type { DocumentRecord, WebsiteCrawlState } from '../types/domain.js';
import { AppError, badRequest, notFound, serviceUnavailable, unprocessable } from '../utils/errors.js';
import { chunkText } from './chunker.js';
import { embedDocuments } from './embeddings.js';
import {
  describeFirecrawlError,
  fetchCrawlPage,
  getCrawlErrorSummary,
  getCrawlStatus,
  isFatalFirecrawlError,
  isFirecrawlConfigured,
  startWebsiteCrawl as startCrawlJob,
  type CrawlResultsPage,
} from './firecrawlClient.js';

/** Maximum wall-clock work per advance call; the rest happens on later polls. */
const ADVANCE_BUDGET_MS = 6_000;

/** Single-flight guard: one indexing loop per document at a time. */
const advancing = new Set<string>();

function initialCrawlState(): WebsiteCrawlState {
  const now = new Date();
  return {
    jobId: '',
    status: 'scraping',
    phase: 'scraping',
    crawled: 0,
    discovered: null,
    indexed: 0,
    nextCursor: null,
    page1Pending: false,
    failedDetail: null,
    lastError: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw badRequest('Enter a valid absolute http(s) URL.');
  }
}

/**
 * Create the website document and start the Firecrawl crawl.
 *
 * A start failure keeps the failed record (same contract as a failed PDF
 * upload) so the admin can see the reason and delete it; the caller maps
 * `status === 'failed'` to a 422 response.
 */
export async function createWebsiteCrawl(
  store: Store,
  params: { userId: string; url: string },
): Promise<DocumentRecord> {
  if (!isFirecrawlConfigured()) {
    throw serviceUnavailable('Website ingestion is not configured: set FIRECRAWL_API_KEY on the server.');
  }

  const hostname = hostnameOf(params.url);
  const title = hostname.replace(/^www\./, '') || hostname;
  const crawl = initialCrawlState();

  const document = await store.createDocument({
    userId: params.userId,
    title,
    originalName: hostname,
    storagePath: null,
    mimeType: 'text/html',
    sizeBytes: 0,
    sourceType: 'website',
    websiteUrl: params.url,
    crawl: { ...crawl },
  });

  try {
    crawl.jobId = await startCrawlJob(params.url, env.FIRECRAWL_MAX_PAGES);
    crawl.updatedAt = new Date();
    const updated = await store.updateDocument(document.id, params.userId, {
      status: 'processing',
      crawl: { ...crawl },
    });
    return updated ?? document;
  } catch (err) {
    const message = describeFirecrawlError(err);
    crawl.phase = 'failed';
    crawl.failedDetail = message;
    crawl.updatedAt = new Date();
    await store.updateDocument(document.id, params.userId, {
      status: 'failed',
      error: message,
      crawl: { ...crawl },
    });
    const failed = await store.getDocument(document.id, params.userId);
    return failed ?? document;
  }
}

/**
 * Run one bounded slice of crawl progress/indexing for a document and return
 * its updated record. Idempotent: terminal states and concurrent polls return
 * the current record without doing work.
 */
export async function advanceWebsiteCrawl(
  store: Store,
  params: { documentId: string; userId: string },
): Promise<DocumentRecord> {
  const { documentId, userId } = params;
  const document = await store.getDocument(documentId, userId);
  if (!document) throw notFound('Document not found.');
  const crawl = document.crawl;
  if (!crawl) throw unprocessable('This document is not a website crawl.');
  if (crawl.phase === 'completed' || crawl.phase === 'failed') return document;
  if (advancing.has(documentId)) return document;

  advancing.add(documentId);
  try {
    return await runAdvance(store, document, { ...crawl });
  } finally {
    advancing.delete(documentId);
  }
}

async function runAdvance(
  store: Store,
  document: DocumentRecord,
  crawl: WebsiteCrawlState,
): Promise<DocumentRecord> {
  const started = Date.now();
  const { id: documentId, userId } = document;
  let doc = document;

  try {
    if (!isFirecrawlConfigured()) {
      return await failPhase(store, doc, crawl, 'FIRECRAWL_API_KEY is no longer configured; the crawl cannot continue.');
    }

    // 1. One status poll per advance: drives progress, termination and page 1.
    const job = await getCrawlStatus(crawl.jobId);
    crawl.status = job.status;
    crawl.crawled = job.completed ?? crawl.crawled;
    if (job.total > 0) crawl.discovered = job.total;
    crawl.lastError = null;
    crawl.updatedAt = new Date();

    if (job.status === 'failed' || job.status === 'cancelled') {
      const summary = await getCrawlErrorSummary(crawl.jobId);
      return await failPhase(store, doc, crawl, summary ?? `Firecrawl reported the crawl as ${job.status}.`);
    }

    if (crawl.phase === 'scraping') {
      if (job.status !== 'completed') {
        // Still crawling: mirror progress and return. Indexing starts only
        // after completion so the result set stops growing under the dedupe.
        const updated = await store.updateDocument(documentId, userId, { crawl: { ...crawl } });
        return updated ?? doc;
      }
      crawl.phase = 'indexing';
      crawl.page1Pending = true;
      crawl.nextCursor = null;
      crawl.updatedAt = new Date();
      doc = (await store.updateDocument(documentId, userId, { crawl: { ...crawl } })) ?? doc;
    }

    // 2. Indexing: bounded slices until every results page is consumed.
    return await runIndexing(store, doc, crawl, job, started);
  } catch (err) {
    // Rate limits (429), timeouts (408), 5xx and network errors are
    // transient: record them and let the next poll retry. Permanent API
    // errors, broken cursors and unexpected pipeline errors fail the phase
    // honestly, exactly like a failed PDF ingestion.
    const transient = err instanceof AppError || (err instanceof SdkError && !isFatalFirecrawlError(err));
    if (transient) {
      crawl.lastError = describeFirecrawlError(err);
      crawl.updatedAt = new Date();
      const updated = await store.updateDocument(documentId, userId, { crawl: { ...crawl } });
      return updated ?? doc;
    }
    return await failPhase(store, doc, crawl, describeFirecrawlError(err));
  }
}

interface IndexingContext {
  /** Page URLs already carrying chunks (seeded from the store each advance). */
  seen: Set<string>;
  /** Next contiguous ordinal (highest used + 1). */
  nextOrdinal: number;
}

async function runIndexing(
  store: Store,
  document: DocumentRecord,
  crawl: WebsiteCrawlState,
  job: CrawlJob,
  started: number,
): Promise<DocumentRecord> {
  const { id: documentId, userId } = document;
  // Authoritative resume state: which pages already have chunks (dedupe) and
  // the highest ordinal used. Cheap projection - no text or embeddings load.
  const refs = await store.listChunkRefs(documentId);
  const ctx: IndexingContext = {
    seen: new Set(refs.map((r) => r.pageUrl).filter((u): u is string => Boolean(u))),
    nextOrdinal: refs.reduce((max, r) => Math.max(max, r.ordinal), -1) + 1,
  };
  crawl.indexed = ctx.seen.size;
  const baseCharCount = document.charCount;
  let charAccum = 0;
  let doc = document;

  while (true) {
    // Resolve the next results page to consume.
    let page: CrawlResultsPage;
    if (crawl.page1Pending) {
      // Page 1 always arrives with the status poll; consumed inline on the
      // advance that sees the job complete.
      page = { data: job.data ?? [], next: job.next ?? null };
    } else if (crawl.nextCursor) {
      page = await fetchCrawlPage(crawl.nextCursor);
    } else {
      return await finalize(store, doc, crawl, baseCharCount + charAccum);
    }

    let consumedAll = true;
    for (let i = 0; i < page.data.length; i += 1) {
      if (Date.now() - started >= ADVANCE_BUDGET_MS) {
        consumedAll = false; // resume this same results page on a later poll
        break;
      }
      charAccum += await indexOnePage(store, document, page.data[i]!, ctx);
      crawl.indexed = ctx.seen.size;
      crawl.updatedAt = new Date();
      // Persist after every page: a hard crash can lose at most one page of
      // progress, and the refs-based dedupe makes that resume duplication-safe.
      doc =
        (await store.updateDocument(documentId, userId, {
          crawl: { ...crawl },
          charCount: baseCharCount + charAccum,
        })) ?? doc;
    }

    if (consumedAll) {
      crawl.page1Pending = false;
      crawl.nextCursor = page.next ?? null;
      crawl.updatedAt = new Date();
      doc = (await store.updateDocument(documentId, userId, { crawl: { ...crawl } })) ?? doc;
      if (!crawl.nextCursor) {
        return await finalize(store, doc, crawl, baseCharCount + charAccum);
      }
    }

    if (Date.now() - started >= ADVANCE_BUDGET_MS) {
      return doc; // budget exhausted; the persisted cursor points at the rest
    }
  }
}

/**
 * Chunk, embed and store a single crawled page. Returns the characters
 * contributed (0 when the page was skipped as already indexed or empty).
 *
 * The page is the atomic unit: chunks are embedded first and inserted in one
 * call, and the URL joins `seen` only afterwards.
 */
async function indexOnePage(
  store: Store,
  document: DocumentRecord,
  pageDoc: FirecrawlPage,
  ctx: IndexingContext,
): Promise<number> {
  const pageUrl = pageDoc.metadata?.sourceURL ?? pageDoc.metadata?.url ?? null;
  if (pageUrl && ctx.seen.has(pageUrl)) return 0; // resume: never duplicate

  const text = (pageDoc.markdown ?? '').trim();
  if (!text) return 0; // page produced no usable main content

  const pieces = chunkText(text, { size: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP });
  if (!pieces.length) return 0;

  const embeddings = await embedDocuments(pieces.map((p) => p.text));
  const badIndex = embeddings.findIndex((e) => e.length !== env.EMBEDDING_DIMENSIONS);
  if (badIndex >= 0) {
    throw new Error(
      `Embedding ${badIndex} has ${embeddings[badIndex]?.length} dimensions, expected ${env.EMBEDDING_DIMENSIONS}.`,
    );
  }

  await store.insertChunks(
    pieces.map((piece, i) => ({
      documentId: document.id,
      userId: document.userId,
      ordinal: ctx.nextOrdinal++,
      text: piece.text,
      embedding: embeddings[i] as number[],
      page: null,
      charStart: null,
      charEnd: null,
      sourceType: 'website',
      pageUrl,
      pageTitle: pageDoc.metadata?.title ?? null,
      websiteUrl: document.websiteUrl ?? null,
    })),
  );
  if (pageUrl) ctx.seen.add(pageUrl);
  return text.length;
}

/**
 * Terminal success. Any pages indexed so far stay searchable; only a crawl
 * that produced nothing is marked failed, with the reason preserved.
 */
async function finalize(
  store: Store,
  document: DocumentRecord,
  crawl: WebsiteCrawlState,
  charCount: number,
): Promise<DocumentRecord> {
  crawl.phase = 'completed';
  crawl.status = 'completed';
  crawl.completedAt = new Date();
  crawl.updatedAt = new Date();
  // Best-effort summary of failed pages so partial failures stay visible.
  if (!crawl.failedDetail) crawl.failedDetail = await getCrawlErrorSummary(crawl.jobId);

  const chunkCount = await store.syncChunkCounts(document.id);
  const nothingIndexed = crawl.indexed === 0;
  const updated = await store.updateDocument(document.id, document.userId, {
    crawl: { ...crawl },
    status: nothingIndexed ? 'failed' : 'ready',
    error: nothingIndexed
      ? (crawl.failedDetail ?? 'The crawl finished but no pages produced indexable content.')
      : null,
    pageCount: crawl.crawled || crawl.indexed,
    charCount,
    sizeBytes: charCount,
    chunkCount,
  });
  return updated ?? document;
}

/** Terminal failure. Indexed pages are kept: partial website content remains usable. */
async function failPhase(
  store: Store,
  document: DocumentRecord,
  crawl: WebsiteCrawlState,
  message: string,
): Promise<DocumentRecord> {
  crawl.phase = 'failed';
  crawl.failedDetail = crawl.failedDetail ?? message;
  crawl.updatedAt = new Date();
  try {
    await store.syncChunkCounts(document.id);
    const updated = await store.updateDocument(document.id, document.userId, {
      crawl: { ...crawl },
      status: 'failed',
      error: message,
    });
    return updated ?? document;
  } catch {
    // Persisting the failure failed (store unavailable): return the current
    // record; the next poll re-detects the terminal condition and retries.
    return document;
  }
}
