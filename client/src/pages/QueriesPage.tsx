import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { QueryRecord } from '../api/types';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useAsync } from '../hooks';

/**
 * Queries Management.
 *
 * Questions the RAG pipeline could not answer (their answer carried no
 * citation) are collected here, split into Pending and Indexed. Marking a
 * query indexed only records that status - it never adds the query to the
 * knowledge base. The original text is immutable.
 */
export function QueriesPage() {
  const queries = useAsync(() => api.listQueries(), []);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const [indexingId, setIndexingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<QueryRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const list = queries.data?.queries ?? [];
  const pending = list.filter((q) => q.status === 'pending');
  const indexed = list.filter((q) => q.status === 'indexed');
  const counts = queries.data?.counts;

  async function markIndexed(query: QueryRecord) {
    if (indexingId) return;
    setIndexingId(query.id);
    try {
      await api.markQueryIndexed(query.id);
      setNotice({ tone: 'success', text: 'Query marked as indexed.' });
      // Reload both sections and their counts; the row leaves Pending only
      // once the server has confirmed the status change.
      await queries.refetch(true);
    } catch (err) {
      // The row stays in Pending; the failure is surfaced instead.
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not mark the query as indexed.' });
    } finally {
      setIndexingId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteQuery(pendingDelete.id);
      setNotice({ tone: 'success', text: 'Query deleted.' });
      setPendingDelete(null);
      await queries.refetch(true);
    } catch (err) {
      // The row stays in place; the failure is surfaced instead.
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Delete failed.' });
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Queries</h1>
          <p className="subtitle">
            Chat questions the assistant could not answer from the indexed documents. Mark them as
            indexed once handled, or discard them.
          </p>
        </div>
      </div>

      {notice ? (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      ) : null}

      {queries.loading ? (
        <div className="center-state">
          <Spinner size="lg" />
        </div>
      ) : queries.error ? (
        <Alert tone="error" title="Could not load queries">
          {queries.error}
        </Alert>
      ) : (
        <>
          <div className="card mb">
            <div className="section-head">
              <h2>Pending</h2>
              <span className="badge badge-pending" data-testid="pending-count">
                {counts?.pending ?? pending.length}
              </span>
            </div>
            {pending.length === 0 ? (
              <div className="center-state">
                <p>No pending queries. Answerable questions never appear here.</p>
              </div>
            ) : (
              <div className="doc-list" data-testid="query-list">
                {pending.map((query) => (
                  <QueryRow
                    key={query.id}
                    query={query}
                    busy={indexingId === query.id}
                    onIndexed={markIndexed}
                    onDelete={setPendingDelete}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-head">
              <h2>Indexed</h2>
              <span className="badge badge-indexed" data-testid="indexed-count">
                {counts?.indexed ?? indexed.length}
              </span>
            </div>
            {indexed.length === 0 ? (
              <div className="center-state">
                <p>No indexed queries yet.</p>
              </div>
            ) : (
              <div className="doc-list" data-testid="query-list">
                {indexed.map((query) => (
                  <QueryRow key={query.id} query={query} busy={false} onDelete={setPendingDelete} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this query?"
        message="This permanently removes the query record. The chat history and the knowledge base are untouched."
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function QueryRow({
  query,
  busy,
  onIndexed,
  onDelete,
}: {
  query: QueryRecord;
  busy: boolean;
  onIndexed?: (query: QueryRecord) => void;
  onDelete: (query: QueryRecord) => void;
}) {
  return (
    <div className="doc-row" data-testid="query-row">
      <span className="doc-icon" aria-hidden="true">
        Q
      </span>
      <span className="doc-info">
        <span className="doc-title" style={{ whiteSpace: 'normal' }} title={query.question}>
          {query.question}
        </span>
        <span className="doc-meta">
          <span>Submitted {new Date(query.createdAt).toLocaleString()}</span>
          {query.status === 'indexed' ? <span>Indexed {new Date(query.updatedAt).toLocaleString()}</span> : null}
        </span>
      </span>
      {/* The section heading already says "Pending", so only the Indexed state
          is flagged on the row itself. */}
      {query.status === 'indexed' ? <span className="badge badge-indexed">Indexed</span> : null}
      <span className="doc-actions">
        {query.status === 'pending' && onIndexed ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onIndexed(query)}
            disabled={busy}
            aria-label="Mark query as indexed"
            data-testid="query-indexed"
          >
            {busy ? <span className="spinner" /> : null}
            Indexed
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => onDelete(query)}
          aria-label="Delete query"
          data-testid="query-delete"
        >
          Delete
        </button>
      </span>
    </div>
  );
}