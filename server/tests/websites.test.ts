/**
 * Website ingestion (Firecrawl Crawl API) tests.
 *
 * Only the Firecrawl SDK is mocked (module boundary); everything else - the
 * routes, the crawl state machine, chunking, the real local embedding model
 * and vector retrieval - runs for real.
 */
import request from 'supertest';
import { SdkError } from 'firecrawl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { embedQuery } from '../src/services/embeddings.js';
import { buildCitations } from '../src/services/rag.js';
import { auth, createHarness, uploadPdf, type TestHarness } from './helpers.js';

const fc = vi.hoisted(() => ({
  startCrawl: vi.fn(),
  getCrawlStatus: vi.fn(),
  getCrawlErrors: vi.fn(),
}));

vi.mock('firecrawl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firecrawl')>();
  class MockFirecrawlClient {
    startCrawl(...args: unknown[]) {
      return fc.startCrawl(...args);
    }
    getCrawlStatus(...args: unknown[]) {
      return fc.getCrawlStatus(...args);
    }
    getCrawlErrors(...args: unknown[]) {
      return fc.getCrawlErrors(...args);
    }
  }
  return {
    ...actual,
    FirecrawlClient: MockFirecrawlClient as unknown as typeof actual.FirecrawlClient,
  };
});

const fetchMock = vi.fn();

/** Minimal Response-like object for the manual `next`-cursor fetch. */
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** One crawled page as Firecrawl returns it. */
function page(url: string, title: string, markdown: string) {
  return { markdown, metadata: { sourceURL: url, title } };
}

type JobStatus = 'scraping' | 'completed' | 'failed' | 'cancelled';

function job(over: Partial<{ status: JobStatus; total: number; completed: number; data: unknown[]; next: string | null }> = {}) {
  return {
    id: 'job-1',
    status: 'scraping' as JobStatus,
    total: 0,
    completed: 0,
    data: [],
    next: null as string | null,
    ...over,
  };
}

const SHORT_PAGE_TEXT = 'Welcome to the guide. This page explains the setup basics for new installations.';

const LONG_PAGE_TEXT =
  'The deployment guide covers every environment from local development to production clusters. ' +
  'Configuration lives in a single file that is read at boot time and validated strictly. ' +
  'Rolling upgrades keep the previous generation running until the new one reports healthy. ' +
  'Health checks probe the embedding model and the vector index before traffic is admitted. ' +
  'Backups are taken incrementally and retained across three geographic regions for durability. ' +
  'Rollbacks revert the configuration bundle together with the matching application image. ' +
  'Every release ships with a changelog that lists breaking changes at the very top. ' +
  'Operators can pause a rollout at any checkpoint without losing cluster-wide state. ' +
  'Capacity planning uses the observed token throughput of the embedding pipeline as input.';

let h: TestHarness;

beforeEach(() => {
  fc.startCrawl.mockReset();
  fc.getCrawlStatus.mockReset();
  fc.getCrawlErrors.mockReset().mockResolvedValue({ errors: [], robotsBlocked: [] });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // The key itself is never used by the mocked SDK; only its presence matters.
  process.env.FIRECRAWL_API_KEY ??= 'fc-test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startCrawl(url = 'https://site.example/guide'): Promise<string> {
  fc.startCrawl.mockResolvedValue({ id: 'job-1', url: 'https://api.firecrawl.dev/v2/crawl/job-1' });
  const res = await request(h.app).post('/api/websites').set(auth(h.token)).send({ url });
  expect(res.status).toBe(201);
  return res.body.document.id as string;
}

function advance(id: string) {
  return request(h.app).post(`/api/websites/${id}/advance`).set(auth(h.token));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe('POST /api/websites', () => {
  it('starts a crawl with markdown, main-content and bounded same-domain options', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl('https://www.example.com/guide');

    expect(fc.startCrawl).toHaveBeenCalledTimes(1);
    expect(fc.startCrawl).toHaveBeenCalledWith('https://www.example.com/guide', {
      limit: env.FIRECRAWL_MAX_PAGES,
      sitemap: 'include',
      crawlEntireDomain: true,
      allowExternalLinks: false,
      allowSubdomains: false,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });

    const res = await request(h.app).get(`/api/documents/${id}`).expect(200);
    const doc = res.body.document;
    expect(doc.status).toBe('processing');
    expect(doc.sourceType).toBe('website');
    expect(doc.websiteUrl).toBe('https://www.example.com/guide');
    expect(doc.title).toBe('example.com');
    expect(doc.storagePath).toBeNull();
    expect(doc.mimeType).toBe('text/html');
    expect(doc.crawl.jobId).toBe('job-1');
    expect(doc.crawl.phase).toBe('scraping');
    expect(doc.crawl.status).toBe('scraping');
  });

  it('requires the admin token', async () => {
    h = await createHarness();
    const res = await request(h.app).post('/api/websites').send({ url: 'https://site.example/' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await h.store.listDocuments(h.kbId)).toHaveLength(0);
  });

  it('rejects invalid URLs with 422 and never calls Firecrawl', async () => {
    h = await createHarness({ withUser: true });
    for (const url of ['not-a-url', 'example.com/guide', 'ftp://site.example/', 'https://user:pass@site.example/']) {
      const res = await request(h.app).post('/api/websites').set(auth(h.token)).send({ url });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(fc.startCrawl).not.toHaveBeenCalled();
    expect(await h.store.listDocuments(h.kbId)).toHaveLength(0);
  });

  it('returns 503 when the server has no FIRECRAWL_API_KEY', async () => {
    const prevProcess = process.env.FIRECRAWL_API_KEY;
    const prevEnv = env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    env.FIRECRAWL_API_KEY = undefined;
    try {
      h = await createHarness({ withUser: true });
      const res = await request(h.app)
        .post('/api/websites')
        .set(auth(h.token))
        .send({ url: 'https://site.example/' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(fc.startCrawl).not.toHaveBeenCalled();
      expect(await h.store.listDocuments(h.kbId)).toHaveLength(0);
    } finally {
      if (prevProcess !== undefined) process.env.FIRECRAWL_API_KEY = prevProcess;
      env.FIRECRAWL_API_KEY = prevEnv;
    }
  });

  it('keeps a failed crawl start as a visible failed document (422)', async () => {
    h = await createHarness({ withUser: true });
    fc.startCrawl.mockRejectedValue(new SdkError('Insufficient credits', 402));

    const res = await request(h.app)
      .post('/api/websites')
      .set(auth(h.token))
      .send({ url: 'https://site.example/' });
    expect(res.status).toBe(422);
    expect(res.body.document.status).toBe('failed');
    expect(res.body.document.error).toContain('Insufficient credits');
    expect(res.body.document.crawl.phase).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Advance: auth, validation, progress
// ---------------------------------------------------------------------------

describe('POST /api/websites/:id/advance', () => {
  it('requires the admin token', async () => {
    h = await createHarness();
    const res = await request(h.app).post('/api/websites/some-id/advance');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for an unknown document and 422 for a PDF document', async () => {
    h = await createHarness({ withUser: true });
    await advance('unknown-id').expect(404);

    const upload = await uploadPdf(h.app, h.token, ['A PDF, not a website.']);
    expect(upload.status).toBe(201);
    const res = await advance(upload.body.document.id);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('not a website crawl');
  });

  it('mirrors crawl progress while Firecrawl is still scraping', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();
    fc.getCrawlStatus.mockResolvedValue(job({ status: 'scraping', completed: 4, total: 15 }));

    const res = await advance(id).expect(200);
    const { document, crawl } = { document: res.body.document, crawl: res.body.document.crawl };
    expect(document.status).toBe('processing');
    expect(crawl.phase).toBe('scraping');
    expect(crawl.crawled).toBe(4);
    expect(crawl.discovered).toBe(15);
    expect(crawl.indexed).toBe(0);
    // No indexing happens before the crawl completes.
    expect(await h.store.listChunks(id, { limit: 100 })).toHaveLength(0);
  });

  it('records a rate limit as a retryable error instead of failing the job', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();

    fc.getCrawlStatus.mockRejectedValueOnce(new SdkError('Rate limit exceeded', 429));
    const first = await advance(id).expect(200);
    expect(first.body.document.status).toBe('processing');
    expect(first.body.document.crawl.phase).toBe('scraping');
    expect(first.body.document.crawl.lastError).toContain('rate-limited');

    // The next poll succeeds and clears the transient error.
    fc.getCrawlStatus.mockResolvedValue(job({ status: 'scraping', completed: 6, total: 15 }));
    const second = await advance(id).expect(200);
    expect(second.body.document.crawl.lastError).toBeNull();
    expect(second.body.document.crawl.crawled).toBe(6);
  });

  it('fails the document permanently on a fatal API error', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();

    fc.getCrawlStatus.mockRejectedValue(new SdkError('Invalid API key', 401));
    const res = await advance(id).expect(200);
    expect(res.body.document.status).toBe('failed');
    expect(res.body.document.error).toContain('Invalid API key');
    expect(res.body.document.crawl.phase).toBe('failed');

    // Terminal: later polls do no work.
    fc.getCrawlStatus.mockClear();
    const again = await advance(id).expect(200);
    expect(again.body.document.status).toBe('failed');
    expect(fc.getCrawlStatus).not.toHaveBeenCalled();
  });

  it('marks a Firecrawl-failed job as failed, summarising failed pages without EXTERNAL_LINK noise', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();
    fc.getCrawlStatus.mockResolvedValue(job({ status: 'failed' }));
    fc.getCrawlErrors.mockResolvedValue({
      errors: [
        { id: '1', url: 'https://site.example/ext', code: 'EXTERNAL_LINK', error: 'Skipped external link' },
        { id: '2', url: 'https://site.example/slow', code: 'SCRAPE_TIMEOUT', error: 'Timed out' },
      ],
      robotsBlocked: ['https://site.example/private'],
    });

    const res = await advance(id).expect(200);
    expect(res.body.document.status).toBe('failed');
    expect(res.body.document.crawl.phase).toBe('failed');
    // EXTERNAL_LINK is filtered (1 failure, not 2) and robots blocks are noted.
    expect(res.body.document.error).toContain('1 page failed');
    expect(res.body.document.error).toContain('Timed out');
    expect(res.body.document.error).toContain('1 URL blocked by robots.txt');
  });
});

// ---------------------------------------------------------------------------
// Completed crawl -> indexing
// ---------------------------------------------------------------------------

describe('indexing a completed crawl', () => {
  it('chunks and stores pages with website metadata, contiguous ordinals, and no duplicates', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl('https://site.example/');

    fc.getCrawlStatus.mockResolvedValue(
      job({
        status: 'completed',
        completed: 3,
        total: 3,
        data: [
          page('https://site.example/one', 'Page One', SHORT_PAGE_TEXT),
          page('https://site.example/two', 'Page Two', LONG_PAGE_TEXT),
          // Same URL twice in one results page: must index exactly once.
          page('https://site.example/one', 'Page One', SHORT_PAGE_TEXT),
        ],
        next: null,
      }),
    );

    const res = await advance(id).expect(200);
    const doc = res.body.document;
    expect(doc.status).toBe('ready');
    expect(doc.error).toBeNull();
    expect(doc.crawl.phase).toBe('completed');
    expect(doc.crawl.status).toBe('completed');
    expect(doc.crawl.indexed).toBe(2);
    expect(doc.crawl.completedAt).toBeTruthy();
    expect(doc.pageCount).toBe(3); // crawled pages
    expect(doc.charCount).toBeGreaterThan(0);
    expect(doc.sizeBytes).toBe(doc.charCount);
    expect(doc.chunkCount).toBeGreaterThan(0);

    const chunks = await h.store.listChunks(id, { limit: 100 });
    expect(chunks.length).toBe(doc.chunkCount);
    // Page "one" (short text) must appear exactly once: the duplicate row in
    // the results page did not double-index.
    expect(chunks.filter((c) => c.pageUrl === 'https://site.example/one')).toHaveLength(1);
    expect(chunks.filter((c) => c.pageUrl === 'https://site.example/two').length).toBeGreaterThan(0);
    // Ordinals are contiguous from zero in crawl order.
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));

    for (const c of chunks) {
      expect(c.sourceType).toBe('website');
      expect(c.websiteUrl).toBe('https://site.example/');
      expect(c.page).toBeNull();
      expect(c.charStart).toBeNull();
      expect(c.charEnd).toBeNull();
      expect(c.pageUrl).toBeTruthy();
      expect(c.pageTitle).toBeTruthy();
      expect(c.embedding ?? []).toHaveLength(0); // listChunks strips embeddings
    }

    // Terminal: further polls are idempotent no-ops.
    fc.getCrawlStatus.mockClear();
    const again = await advance(id).expect(200);
    expect(again.body.document.crawl.phase).toBe('completed');
    expect(fc.getCrawlStatus).not.toHaveBeenCalled();
    expect(await h.store.listChunks(id, { limit: 100 })).toHaveLength(chunks.length);
  });

  it('follows the results cursor, survives a transient network error and resumes exactly where it stopped', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();
    const cursor = 'https://api.firecrawl.dev/v2/crawl/job-1?cursor=abc';

    fc.getCrawlStatus.mockResolvedValue(
      job({
        status: 'completed',
        completed: 2,
        total: 2,
        data: [page('https://site.example/one', 'Page One', SHORT_PAGE_TEXT)],
        next: cursor,
      }),
    );

    // First advance: page 1 indexes, then the cursor fetch fails (network).
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const first = await advance(id).expect(200);
    expect(first.body.document.crawl.phase).toBe('indexing');
    expect(first.body.document.crawl.lastError).toContain('Could not reach Firecrawl');
    expect(first.body.document.crawl.nextCursor).toBe(cursor);
    expect(first.body.document.crawl.indexed).toBe(1);

    // Second advance: the persisted cursor is followed; page 1 is not re-indexed.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [page('https://site.example/two', 'Page Two', SHORT_PAGE_TEXT)], next: null }),
    );
    const second = await advance(id).expect(200);
    expect(second.body.document.crawl.phase).toBe('completed');
    expect(second.body.document.crawl.lastError).toBeNull();
    expect(second.body.document.status).toBe('ready');

    // The cursor was followed on both attempts (failed once, then succeeded).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(cursor);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(cursor);
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toMatch(/^Bearer /);

    const chunks = await h.store.listChunks(id, { limit: 100 });
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.pageUrl)).toEqual(
      expect.arrayContaining(['https://site.example/one', 'https://site.example/two']),
    );
  });

  it('fails permanently when a cursor points at an unexpected origin', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();

    fc.getCrawlStatus.mockResolvedValue(
      job({
        status: 'completed',
        completed: 2,
        total: 2,
        data: [page('https://site.example/one', 'Page One', SHORT_PAGE_TEXT)],
        next: 'https://evil.example/steal-cursor',
      }),
    );

    const res = await advance(id).expect(200);
    expect(res.body.document.status).toBe('failed');
    expect(res.body.document.error).toContain('unexpected origin');
    expect(res.body.document.crawl.phase).toBe('failed');
    // The API key never reached the hostile origin.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a crawl that produced nothing as failed with an actionable reason', async () => {
    h = await createHarness({ withUser: true });
    const id = await startCrawl();
    fc.getCrawlStatus.mockResolvedValue(job({ status: 'completed', completed: 1, total: 1, data: [], next: null }));

    const res = await advance(id).expect(200);
    expect(res.body.document.status).toBe('failed');
    expect(res.body.document.error).toContain('no pages produced indexable content');
    expect(res.body.document.crawl.phase).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Retrieval: website chunks answer alongside PDF chunks
// ---------------------------------------------------------------------------

describe('retrieval over PDFs and websites together', () => {
  it('returns chunks from both sources and cites the website page URL', async () => {
    h = await createHarness({ withUser: true });

    const upload = await uploadPdf(h.app, h.token, [
      'The Kelp Forest Restoration Programme replanted twenty hectares of underwater kelp beds.',
      'Restoration targets focused on juvenile kelp survival rates during the first winter season.',
    ], 'kelp-forest.pdf');
    expect(upload.status).toBe(201);
    const pdfId = upload.body.document.id as string;

    const websiteId = await startCrawl('https://site.example/');
    fc.getCrawlStatus.mockResolvedValue(
      job({
        status: 'completed',
        completed: 1,
        total: 1,
        data: [
          page(
            'https://site.example/geothermal',
            'Geothermal Energy',
            'Geothermal power plants draw superheated water from deep volcanic reservoirs. ' +
              'The steam drives turbines that generate electricity continuously, day and night. ' +
              'Iceland now heats most of its homes with geothermal district heating networks.',
          ),
        ],
        next: null,
      }),
    );
    await advance(websiteId).expect(200);

    // Real embedding model, real cosine retrieval across both documents.
    const results = await h.store.vectorSearch({
      userId: h.kbId,
      queryEmbedding: await embedQuery('geothermal power from volcanic reservoirs'),
      limit: 10,
      numCandidates: 100,
    });
    const docIds = new Set(results.map((r) => r.chunk.documentId));
    expect(docIds.has(pdfId)).toBe(true);
    expect(docIds.has(websiteId)).toBe(true);

    const citations = buildCitations(results);
    const webCitation = citations.find((c) => c.documentId === websiteId);
    expect(webCitation?.pageUrl).toBe('https://site.example/geothermal');
    const pdfCitation = citations.find((c) => c.documentId === pdfId);
    expect(pdfCitation).toBeTruthy();
    expect(pdfCitation?.pageUrl).toBeUndefined();
  });
});
