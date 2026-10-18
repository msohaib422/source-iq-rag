import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Chunk } from '../api/types';
import { Alert } from '../components/Alert';
import { ChunkEditor } from '../components/ChunkEditor';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks';

const PAGE_SIZE = 25;

export function DocumentDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  // Rename/re-embed/chunk edits mutate the knowledge base: admin only.
  const isAdmin = Boolean(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Deep link target: /documents/:id?chunk=<chunkId> highlights a cited chunk.
  const highlightChunkId = searchParams.get('chunk');

  const doc = useAsync(
    () => api.getDocument(id),
    [id],
  );

  const paged = useAsync(
    () => api.listChunks(id, { limit: PAGE_SIZE, skip: page * PAGE_SIZE }),
    [id, page],
  );

  // Scroll the highlighted chunk into view once its page has loaded.
  useEffect(() => {
    if (!highlightChunkId || paged.loading || !paged.data) return;
    const node = document.querySelector(`[data-chunk-id="${CSS.escape(highlightChunkId)}"]`);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightChunkId, paged.loading, paged.data]);

  if (doc.loading) {
    return (
      <div className="center-state" style={{ minHeight: '50vh' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (doc.error || !doc.data) {
    return (
      <div>
        <Alert tone="error" title="Could not open document">
          {doc.error ?? 'Document not found.'}
        </Alert>
        <Link to="/admin/documents" className="btn">
          ← Back to documents
        </Link>
      </div>
    );
  }

  const document_ = doc.data.document;
  const chunks = paged.data?.chunks ?? [];
  const total = document_.chunkCount;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function applyChunk(updated: Chunk) {
    if (!paged.data) return;
    paged.setData({
      ...paged.data,
      chunks: paged.data.chunks.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
    });
    setNotice('Chunk saved and re-embedded.');
  }

  function removeChunk(chunkId: string) {
    if (!paged.data) return;
    paged.setData({ ...paged.data, chunks: paged.data.chunks.filter((c) => c.id !== chunkId) });
    setNotice('Chunk deleted and removed from the vector index.');
  }

  async function saveTitle() {
    setError(null);
    try {
      await api.renameDocument(id, title.trim());
      setRenaming(false);
      await doc.refetch(true);
      setNotice('Title updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename.');
    }
  }

  async function reindex() {
    setReindexing(true);
    setError(null);
    try {
      const result = await api.reindexDocument(id);
      setNotice(`Re-embedded ${result.updated} chunks with BAAI/bge-small-en-v1.5.`);
      await Promise.all([doc.refetch(true), paged.refetch(true)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-index failed.');
    } finally {
      setReindexing(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to="/admin/documents" className="small faint">
            ← Documents
          </Link>
          {renaming ? (
            <div className="row" style={{ marginTop: '0.35rem' }}>
              <input
                className="input"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Document title"
                style={{ maxWidth: 380 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveTitle();
                  if (e.key === 'Escape') setRenaming(false);
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveTitle()}>
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <h1 style={{ marginTop: '0.25rem' }} data-testid="document-title">
              {document_.title}
            </h1>
          )}
          <p className="subtitle">
            {document_.originalName} · {document_.pageCount} pages · {total} chunks ·{' '}
            {(document_.sizeBytes / 1024).toFixed(0)} KB
          </p>
        </div>
        <div className="row wrap">
          <StatusBadge status={document_.status} />
          {isAdmin ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setTitle(document_.title);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void reindex()} disabled={reindexing}>
                {reindexing ? <Spinner /> : null} Re-embed all
              </button>
            </>
          ) : null}
          <Link to={`/chat?documents=${document_.id}`} className="btn btn-primary btn-sm">
            Ask about this
          </Link>
        </div>
      </div>

      {highlightChunkId ? (
        <Alert tone="info" title="Cited passage">
          Highlighting the chunk that backed an answer.{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('chunk');
              setSearchParams(next, { replace: true });
            }}
          >
            Clear
          </button>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}
      {document_.status === 'failed' ? (
        <Alert tone="error" title="This document failed to index">
          {document_.error ?? 'Unknown error.'} Delete it and re-upload a text-based PDF.
        </Alert>
      ) : null}

      <div className="card">
        <div className="section-head">
          <h2>Chunks</h2>
          {totalPages > 1 ? (
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                ← Prev
              </button>
              <span className="small faint nowrap">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next →
              </button>
            </div>
          ) : null}
        </div>

        <p className="small faint mb">
          Each chunk is embedded independently into a 384-dimensional vector by{' '}
          <code>BAAI/bge-small-en-v1.5</code> using CLS pooling and L2 normalisation. Editing a chunk re-embeds it
          immediately.
        </p>

        {paged.loading ? (
          <div className="center-state">
            <Spinner />
          </div>
        ) : chunks.length === 0 ? (
          <div className="center-state">
            <p>No chunks.</p>
          </div>
        ) : (
          <div className="chunk-list">
            {chunks.map((chunk) => (
              <div
                key={chunk.id}
                style={
                  highlightChunkId === chunk.id
                    ? { outline: '2px solid var(--accent)', borderRadius: 'var(--radius)' }
                    : undefined
                }
              >
                <ChunkEditor chunk={chunk} onChanged={applyChunk} onDeleted={removeChunk} readOnly={!isAdmin} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}