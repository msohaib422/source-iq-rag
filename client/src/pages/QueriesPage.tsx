import { useEffect, useState } from 'react';
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
  // Bulk selection shared by both sections. Same as Documents: there is no
  // bulk endpoint, so deletion reuses the existing per-query DELETE route and
  // the server keeps enforcing authorisation per record.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDelete, setBulkDelete] = useState<null | { mode: 'selected' | 'all' }>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const list = queries.data?.queries ?? [];
  const pending = list.filter((q) => q.status === 'pending');
  const indexed = list.filter((q) => q.status === 'indexed');
  const counts = queries.data?.counts;

  // Keep the selection in step with what is displayed: ids no longer present
  // (deleted elsewhere, gone from a quiet refetch) are pruned, so
  // "Delete selected" never targets a record that is no longer listed.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      const visible = new Set(list.map((q) => q.id));
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.data]);

  const selectedCount = selected.size;
  const allSelected = list.length > 0 && list.every((q) => selected.has(q.id));

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

  /** Toggle one query's checkbox. */
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select (or clear) every query currently displayed in both sections. */
  function toggleSelectAll() {
    setSelected((prev) => {
      if (list.length > 0 && list.every((q) => prev.has(q.id))) return new Set<string>();
      return new Set(list.map((q) => q.id));
    });
  }

  /**
   * Bulk delete either the selected queries or every query currently listed.
   * Each record is deleted through the existing DELETE route, and failures are
   * counted instead of aborting the remaining deletions.
   */
  async function confirmBulkDelete() {
    if (!bulkDelete || bulkDeleting) return;
    const ids =
      bulkDelete.mode === 'all'
        ? list.map((q) => q.id)
        : [...selected].filter((id) => list.some((q) => q.id === id));
    if (ids.length === 0) {
      setBulkDelete(null);
      return;
    }
    setBulkDeleting(true);
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteQuery(id);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setBulkDelete(null);
    if (failed === 0) {
      setSelected(new Set());
      setNotice({ tone: 'success', text: `${deleted} quer${deleted === 1 ? 'y' : 'ies'} deleted.` });
    } else if (deleted === 0) {
      setNotice({ tone: 'error', text: 'Could not delete the selected queries.' });
    } else {
      // Successfully removed ids drop out of the refreshed list and out of the
      // selection; the failed ones stay listed and selected.
      setNotice({
        tone: 'error',
        text: `Deleted ${deleted} of ${ids.length} queries — ${failed} could not be deleted.`,
      });
    }
    await queries.refetch(true);
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
          {list.length > 0 ? (
            <div className="row wrap mb" style={{ justifyContent: 'space-between' }}>
              <div className="row wrap">
                <label className="row" style={{ gap: '0.45rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      // Indeterminate while only part of the queries are selected.
                      if (el) el.indeterminate = selectedCount > 0 && selectedCount < list.length;
                    }}
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all queries"
                    data-testid="query-select-all"
                  />
                  Select all
                </label>
                {selectedCount > 0 ? <span className="small faint">{selectedCount} selected</span> : null}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={selectedCount === 0}
                  onClick={() => setBulkDelete({ mode: 'selected' })}
                  data-testid="query-delete-selected"
                >
                  Delete selected
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setBulkDelete({ mode: 'all' })}
                  data-testid="query-delete-all"
                >
                  Delete all
                </button>
              </div>
            </div>
          ) : null}

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
                    selected={selected.has(query.id)}
                    onToggle={toggleSelect}
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
                  <QueryRow
                    key={query.id}
                    query={query}
                    busy={false}
                    selected={selected.has(query.id)}
                    onToggle={toggleSelect}
                    onDelete={setPendingDelete}
                  />
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

      <ConfirmDialog
        open={bulkDelete !== null}
        title={bulkDelete?.mode === 'all' ? 'Delete all queries?' : 'Delete selected queries?'}
        message={
          bulkDelete === null
            ? null
            : bulkDelete.mode === 'all'
              ? `This permanently removes all ${list.length} quer${list.length === 1 ? 'y' : 'ies'} currently shown. The chat history and the knowledge base are untouched. It cannot be undone.`
              : `This permanently removes the selected ${selectedCount} quer${selectedCount === 1 ? 'y' : 'ies'}. The chat history and the knowledge base are untouched. It cannot be undone.`
        }
        busy={bulkDeleting}
        onConfirm={() => void confirmBulkDelete()}
        onCancel={() => setBulkDelete(null)}
      />
    </div>
  );
}

function QueryRow({
  query,
  busy,
  selected,
  onToggle,
  onIndexed,
  onDelete,
}: {
  query: QueryRecord;
  busy: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onIndexed?: (query: QueryRecord) => void;
  onDelete: (query: QueryRecord) => void;
}) {
  return (
    <div className="doc-row" data-testid="query-row">
      <input
        type="checkbox"
        style={{ accentColor: 'var(--brand)', flexShrink: 0, margin: 0, cursor: 'pointer' }}
        checked={selected}
        onChange={() => onToggle(query.id)}
        aria-label={`Select ${query.question}`}
        data-testid="query-select"
      />
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