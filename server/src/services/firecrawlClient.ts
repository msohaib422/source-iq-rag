/**
 * Thin, defensive wrapper around the official Firecrawl SDK (Crawl API only).
 *
 * Everything the website-ingestion feature needs from Firecrawl is funnelled
 * through this module so the rest of the server never touches the SDK or the
 * API key directly:
 *
 *  - lazy client construction; the key is backend-only (env, never the client);
 *  - crawl start options: markdown + main-content extraction, bounded page
 *    limit, same-domain crawling only;
 *  - status polling with auto-pagination OFF, so every poll returns exactly one
 *    results page no matter how large the crawl grows;
 *  - manual, origin-validated fetching of the `next` cursor, so resumption
 *    across process restarts stays bounded and cannot be redirected elsewhere;
 *  - error classification: fatal (bad request/auth - never resolves itself)
 *    vs transient (rate limits, timeouts, 5xx, network - the next poll retries);
 *  - a best-effort summary of failed pages via Get Crawl Errors.
 */
import { env } from '../config/env.js';
import { serviceUnavailable } from '../utils/errors.js';
import {
  FirecrawlClient,
  SdkError,
  type CrawlJob,
  type CrawlOptions,
  type CrawlResponse,
  type Document as FirecrawlPage,
} from 'firecrawl';

/** One page of crawl results plus the cursor for the page after it. */
export interface CrawlResultsPage {
  data: FirecrawlPage[];
  next: string | null;
}

/**
 * Errors that can never resolve themselves (a security check, a broken
 * persisted cursor). Distinct from `SdkError` so `isFatalFirecrawlError` can
 * fail a crawl immediately instead of retrying forever.
 */
export class PermanentFirecrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFirecrawlError';
  }
}

let cachedClient: FirecrawlClient | null = null;
let cachedKey: string | null = null;

/** Backend-only API key: env is the boot-time source of truth, process.env the live fallback. */
export function firecrawlApiKey(): string | null {
  const key = env.FIRECRAWL_API_KEY?.trim() || process.env.FIRECRAWL_API_KEY?.trim() || '';
  return key || null;
}

export function isFirecrawlConfigured(): boolean {
  return firecrawlApiKey() !== null;
}

function getClient(): FirecrawlClient {
  const apiKey = firecrawlApiKey();
  if (!apiKey) {
    throw serviceUnavailable(
      'Website ingestion is not configured: set FIRECRAWL_API_KEY in the server environment.',
    );
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new FirecrawlClient({ apiKey });
    cachedKey = apiKey;
  }
  return cachedClient;
}

/**
 * Origins a persisted `next` cursor may point at: the configured Firecrawl API
 * base (or the public cloud default). A tampered/corrupt cursor must never
 * cause the server to send its API key to another host.
 */
function allowedCrawlOrigins(): Set<string> {
  const origins = new Set<string>(['https://api.firecrawl.dev']);
  const custom = process.env.FIRECRAWL_API_URL?.trim();
  if (custom) {
    try {
      origins.add(new URL(custom).origin);
    } catch {
      // A malformed base URL simply contributes no extra allowed origin.
    }
  }
  return origins;
}

/** Start an async crawl. Returns the Firecrawl job id used by every later poll. */
export async function startWebsiteCrawl(url: string, limit: number): Promise<string> {
  const options: CrawlOptions = {
    limit,
    // Stay on the submitted domain: no subdomains, no external links.
    sitemap: 'include',
    crawlEntireDomain: true,
    allowExternalLinks: false,
    allowSubdomains: false,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  };
  const res: CrawlResponse = await getClient().startCrawl(url, options);
  return res.id;
}

/**
 * Status + at most one page of results. Pagination is deliberately manual:
 * with auto-pagination a 10k-page crawl would aggregate every document in one
 * process invocation, defeating the bounded, resumable design.
 */
export async function getCrawlStatus(jobId: string): Promise<CrawlJob> {
  return getClient().getCrawlStatus(jobId, { autoPaginate: false });
}

/** Fetch the page a persisted `next` cursor points at (origin-validated). */
export async function fetchCrawlPage(nextUrl: string): Promise<CrawlResultsPage> {
  let url: URL;
  try {
    url = new URL(nextUrl);
  } catch {
    throw new PermanentFirecrawlError('The persisted crawl cursor is not a valid URL.');
  }
  if (url.protocol !== 'https:' || !allowedCrawlOrigins().has(url.origin)) {
    throw new PermanentFirecrawlError(`Refusing to fetch crawl results from unexpected origin: ${url.origin}`);
  }
  const apiKey = firecrawlApiKey();
  if (!apiKey) throw serviceUnavailable('Website ingestion is not configured: set FIRECRAWL_API_KEY.');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (err) {
    // Transport failure (offline, DNS, timeout): transient, the next poll retries.
    throw new SdkError(`Could not reach Firecrawl for the next crawl page: ${(err as Error).message}`);
  }

  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    message?: string;
    data?: FirecrawlPage[] | { pages?: FirecrawlPage[]; next?: string | null };
    next?: string | null;
  } | null;

  if (!res.ok || !body?.success) {
    const message =
      body?.error ??
      body?.message ??
      (body ? `Fetching the next crawl page failed (${res.status}).` : 'Fetching the next crawl page returned an unreadable response.');
    throw new SdkError(message, res.status);
  }

  const data = Array.isArray(body.data) ? body.data : (body.data?.pages ?? []);
  const next = body.next ?? (Array.isArray(body.data) ? null : body.data?.next) ?? null;
  return { data, next };
}

/**
 * Best-effort, human-readable summary of failed pages. Never throws: an error
 * summary must not be able to fail an otherwise healthy crawl.
 *
 * `EXTERNAL_LINK` entries are intentional skips (we disallow leaving the
 * domain), not failures, so they are filtered out.
 */
export async function getCrawlErrorSummary(jobId: string): Promise<string | null> {
  try {
    const res = await getClient().getCrawlErrors(jobId);
    const failures = (res.errors ?? []).filter((e) => e.code !== 'EXTERNAL_LINK');
    const robots = res.robotsBlocked ?? [];
    if (!failures.length && !robots.length) return null;

    const parts: string[] = [];
    if (failures.length) {
      const first = failures[0]!;
      const detail = first.error ? `: ${first.error}` : '';
      parts.push(`${failures.length} page${failures.length === 1 ? '' : 's'} failed (e.g. ${first.url}${detail})`);
    }
    if (robots.length) parts.push(`${robots.length} URL${robots.length === 1 ? '' : 's'} blocked by robots.txt`);
    return parts.join('; ');
  } catch {
    return null;
  }
}

/**
 * True when retrying can never succeed: request/auth problems (4xx other than
 * rate limits/timeouts) or a broken cursor. Rate limits (429), timeouts (408),
 * 5xx and transport errors are transient - the client keeps polling and the
 * next advance retries. Errors outside the SDK's `SdkError` are *not*
 * classified here; the ingestion state machine decides what to do with them.
 */
export function isFatalFirecrawlError(err: unknown): boolean {
  if (err instanceof PermanentFirecrawlError) return true;
  if (err instanceof SdkError) {
    const status = err.status;
    if (status === undefined) return false;
    if (status === 429 || status === 408) return false;
    return status >= 400 && status < 500;
  }
  // Not an SDK error: left for the caller to classify.
  return false;
}

/** User-facing message for a Firecrawl failure (rate limits are called out explicitly). */
export function describeFirecrawlError(err: unknown): string {
  if (err instanceof SdkError) {
    if (err.status === 429) return `Firecrawl rate-limited the request: ${err.message}`;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
