import type { Citation } from '../api/types';
import { useCopyToClipboard } from '../hooks';

/** Compact a URL for a badge label: host + path, JS-truncated. */
function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname === '/' ? '' : u.pathname;
    const s = `${u.hostname.replace(/^www\./, '')}${path}`;
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
  }
}

export function CitationList({
  citations,
  onOpenDocument,
  showDiagnostics = true,
}: {
  citations: Citation[];
  onOpenDocument?: (documentId: string, chunkId: string) => void;
  /** Retrieval diagnostics (similarity score) - admin only. */
  showDiagnostics?: boolean;
}) {
  const { copied, copy } = useCopyToClipboard();

  if (!citations.length) return null;

  return (
    <div className="citations" data-testid="citations">
      {citations.map((citation, index) => (
        <div className="citation" key={citation.chunkId} data-testid="citation">
          <div className="citation-head">
            <span className="citation-index">{index + 1}</span>
            <span className="citation-title">{citation.documentTitle}</span>
            {citation.page ? <span className="badge">p. {citation.page}</span> : null}
            {citation.pageUrl ? (
              <a className="badge" href={citation.pageUrl} target="_blank" rel="noopener noreferrer" title={citation.pageUrl}>
                {shortUrl(citation.pageUrl)}
              </a>
            ) : null}
            <span className="badge">chunk {citation.ordinal + 1}</span>
            {showDiagnostics ? (
              <span className="citation-score" title="Cosine similarity against the query">
                {citation.score.toFixed(3)}
              </span>
            ) : null}
          </div>
          <div className="citation-snippet">{citation.snippet}</div>
          <div className="citation-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void copy(citation.snippet, citation.chunkId)}
            >
              {copied === citation.chunkId ? '✓ Copied' : 'Copy'}
            </button>
            {onOpenDocument ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onOpenDocument(citation.documentId, citation.chunkId)}
              >
                Open in document
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}