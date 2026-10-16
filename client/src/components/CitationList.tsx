import type { Citation } from '../api/types';
import { useCopyToClipboard } from '../hooks';

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
            <span className="badge">chunk {citation.ordinal + 1}</span>
            {showDiagnostics ? (
              <span className="citation-score" title="Cosine similarity against the query">
                {citation.score.toFixed(3)}
              </span>
            ) : null}
          </div>
          <div className="citation-snippet">{citation.snippet}</div>
          <div className="row wrap mt" style={{ marginTop: '0.4rem', gap: '0.35rem' }}>
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