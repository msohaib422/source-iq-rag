import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { SourceDocument, WebsiteCrawlState } from '../api/types';
import { Alert } from './Alert';
import { Spinner } from './Spinner';

export interface CrawlResult {
  documentId: string;
  title: string;
  ok: boolean;
  error?: string;
}

const POLL_MS = 2000;

function progressPercent(crawl: WebsiteCrawlState): number | null {
  if (crawl.phase === 'completed') return 100;
  if (crawl.phase === 'indexing') {
    return crawl.crawled > 0 ? Math.min(100, Math.round((crawl.indexed / crawl.crawled) * 100)) : null;
  }
  if (crawl.discovered && crawl.discovered > 0) {
    return Math.min(100, Math.round((crawl.crawled / crawl.discovered) * 100));
  }
  return null;
}

function phaseBadge(crawl: WebsiteCrawlState): { label: string; className: string } {
  switch (crawl.phase) {
    case 'scraping':
      return { label: 'Crawling', className: 'badge badge-processing' };
    case 'indexing':
      return { label: 'Indexing', className: 'badge badge-processing' };
    case 'completed':
      return { label: 'Indexed', className: 'badge badge-ready' };
    case 'failed':
      return { label: 'Failed', className: 'badge badge-failed' };
  }
}

/**
 * Admin panel for submitting a website URL to the Firecrawl crawl pipeline.
 *
 * Progress is client-driven: the server never holds a request open, so this
 * component polls `POST /api/websites/:id/advance` every couple of seconds and
 * renders the persisted job state (discovered / crawled / indexed counts,
 * failed-page detail, transient errors, completion).
 */
export function WebsiteIngest({
  onSettled,
  onStarted,
  resumeFrom,
}: {
  onSettled: (result: CrawlResult) => void;
  /** Fires once when a crawl job has been created server-side. */
  onStarted?: () => void;
  /** An in-flight crawl from a previous session/tab to resume. */
  resumeFrom?: SourceDocument | null;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  const settledRef = useRef(false);
  const stoppedRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const settle = useCallback((document: SourceDocument) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettledRef.current({
      documentId: document.id,
      title: document.title,
      ok: document.status === 'ready',
      ...(document.status === 'failed' && document.error ? { error: document.error } : {}),
    });
  }, []);

  const isActive =
    doc !== null && !stopped && (doc.status === 'pending' || doc.status === 'processing');

  // Poll one bounded slice of work at a time while the job is in flight.
  useEffect(() => {
    if (!doc || (doc.status !== 'pending' && doc.status !== 'processing')) return;
    if (stopped) return;
    let cancelled = false;
    let inFlight = false;
    const documentId = doc.id;

    const tick = async () => {
      if (cancelled || inFlight || stoppedRef.current) return;
      inFlight = true;
      try {
        const { document } = await api.advanceWebsiteCrawl(documentId);
        if (cancelled) return;
        setPollError(null);
        setDoc(document);
        if (document.status === 'ready' || document.status === 'failed') {
          settle(document);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) {
          stoppedRef.current = true;
          setStopped(true);
          setPollError(err.message);
        } else {
          setPollError(err instanceof ApiError ? err.message : 'Lost contact with the server. Retrying…');
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [doc?.id, doc?.status, stopped, settle]);

  // Resume an in-flight crawl from a previous session/tab.
  useEffect(() => {
    if (!resumeFrom || doc !== null || busy) return;
    if (resumeFrom.sourceType !== 'website') return;
    if (resumeFrom.status !== 'pending' && resumeFrom.status !== 'processing') return;
    settledRef.current = false;
    stoppedRef.current = false;
    setStopped(false);
    setDoc(resumeFrom);
  }, [resumeFrom, doc, busy]);

  const start = async () => {
    const target = url.trim();
    if (!target || busy || isActive) return;
    setBusy(true);
    setError(null);
    setPollError(null);
    setStopped(false);
    stoppedRef.current = false;
    settledRef.current = false;
    setDoc(null);
    try {
      const document = await api.startWebsiteCrawl(target);
      onStartedRef.current?.();
      setDoc(document);
      if (document.status === 'ready' || document.status === 'failed') {
        settle(document);
        stoppedRef.current = true;
        setStopped(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the crawl.');
    } finally {
      setBusy(false);
    }
  };

  const crawl: WebsiteCrawlState | null = doc?.crawl ?? null;
  const badge = crawl ? phaseBadge(crawl) : null;
  const pct = crawl ? progressPercent(crawl) : null;

  return (
    <div data-testid="website-ingest">
      {error ? (
        <Alert tone="error" title="Could not start the crawl" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <form onSubmit={(e) => { e.preventDefault(); void start(); }} className="row wrap" style={{ gap: '0.6rem' }}>
        <input
          className="input"
          type="url"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy || isActive}
          aria-label="Website URL"
          style={{ flex: '1 1 260px', minWidth: 0 }}
          data-testid="website-url-input"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || isActive || url.trim().length === 0}
          data-testid="website-crawl-button"
        >
          {busy ? <Spinner /> : null} Crawl Website
        </button>
      </form>
      <p className="field-hint mt">
        Firecrawl extracts each page as markdown; content is chunked and embedded alongside your PDFs.
      </p>

      {doc && crawl ? (
        <div className="mt" data-testid="crawl-progress">
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
            <div className="row wrap" style={{ gap: '0.4rem' }}>
              <span className={badge?.className}>{badge?.label}</span>
              <span className="mono small faint" title={doc.websiteUrl ?? undefined}>
                {doc.websiteUrl}
              </span>
            </div>
            <span className="small faint">
              {crawl.indexed} / {crawl.crawled || crawl.discovered || '—'} pages indexed
            </span>
          </div>
          <div className="progress">
            <div
              className={`progress-bar${pct === null ? ' indeterminate' : ''}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <div className="row wrap" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
            <span className="badge">{crawl.discovered ?? '—'} discovered</span>
            <span className="badge">{crawl.crawled} crawled</span>
            <span className="badge badge-indexed">{crawl.indexed} indexed</span>
          </div>
          {crawl.failedDetail ? (
            <p className="small" style={{ color: 'var(--warning)', marginTop: '0.4rem' }}>
              {crawl.failedDetail}
            </p>
          ) : null}
          {crawl.lastError && doc.status !== 'failed' ? (
            <p className="small faint mt">Transient issue (will retry): {crawl.lastError}</p>
          ) : null}
          {pollError ? <p className="small faint mt">Connection problem — retrying… ({pollError})</p> : null}
          {doc.status === 'ready' || doc.status === 'failed' ? (
            <div className="row wrap mt" style={{ gap: '0.5rem' }}>
              <p className="small" style={{ color: doc.status === 'ready' ? 'var(--success)' : 'var(--danger)', margin: 0 }}>
                {doc.status === 'ready'
                  ? `Crawl complete — ${doc.chunkCount} chunks from ${crawl.indexed} pages are searchable.`
                  : `Crawl failed — ${doc.error ?? crawl.failedDetail ?? 'Unknown error.'}`}
              </p>
              {doc.status === 'ready' ? (
                <Link to={`/admin/documents/${doc.id}`} className="btn btn-sm">
                  Open document
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}