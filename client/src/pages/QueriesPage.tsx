import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { QueryRecord } from '../api/types';
import { Alert } from '../components/Alert';
import { ConfirmDialog, Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useAsync } from '../hooks';

/**
 * Queries Management.
 *
 * Questions the RAG pipeline could not answer (their answer carried no
 * citation) are collected here, split into Pending and Edited. Editing only
 * renames the stored record - it never adds the query to the knowledge base.
 */
export function QueriesPage() {
  const queries = useAsync(() => api.listQueries(), []);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const [editing, setEditing] = useState<QueryRecord | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<QueryRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const list = queries.data?.queries ?? [];
  const pending = list.filter((q) => q.status === 'pending');
  const edited = list.filter((q) => q.status === 'edited');
  const counts = queries.data?.counts;

  function openEditor(query: QueryRecord) {
    setEditing(query);
    setDraft(query.editedQuestion ?? query.question);
    setDraftError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const text = draft.trim();
    if (!text) {
      setDraftError('Query cannot be empty.');
      return;
    }
    setSaving(true);
    setDraftError(null);
    try {
      await api.updateQuery(editing.id, text);
      setEditing(null);
      setNotice({ tone: 'success', text: 'Query updated and moved to Edited.' });
      await queries.refetch(true);
    } catch (err) {
      setDraftError(err instanceof ApiError ? err.message : 'Could not save the query.');
    } finally {
      setSaving(false);
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
            Chat questions the assistant could not answer from the indexed documents. Edit them into
            better phrasings or discard them.
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
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.85rem' }}>
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
                    onEdit={openEditor}
                    onDelete={setPendingDelete}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.85rem' }}>
              <h2>Edited</h2>
              <span className="badge badge-edited" data-testid="edited-count">
                {counts?.edited ?? edited.length}
              </span>
            </div>
            {edited.length === 0 ? (
              <div className="center-state">
                <p>No edited queries yet.</p>
              </div>
            ) : (
              <div className="doc-list" data-testid="query-list">
                {edited.map((query) => (
                  <QueryRow
                    key={query.id}
                    query={query}
                    onEdit={openEditor}
                    onDelete={setPendingDelete}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Modal
        open={editing !== null}
        title="Edit query"
        onClose={() => (saving ? undefined : setEditing(null))}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveEdit()}
              disabled={saving}
              data-testid="query-save"
            >
              {saving ? <span className="spinner" /> : null}
              Save
            </button>
          </>
        }
      >
        {editing ? (
          <>
            <div className="field">
              <label htmlFor="query-editor">Query</label>
              <textarea
                id="query-editor"
                className="textarea"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (draftError) setDraftError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void saveEdit();
                  }
                }}
                rows={3}
                disabled={saving}
                data-testid="query-editor"
              />
              {draftError ? (
                <p className="field-error" role="alert">
                  {draftError}
                </p>
              ) : (
                <p className="field-hint">
                  Only this record is updated — the knowledge base is not changed.
                </p>
              )}
            </div>
            {editing.editedQuestion === null || editing.editedQuestion !== editing.question ? (
              <p className="small faint">Originally asked: “{editing.question}”</p>
            ) : null}
          </>
        ) : null}
      </Modal>

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
  onEdit,
  onDelete,
}: {
  query: QueryRecord;
  onEdit: (query: QueryRecord) => void;
  onDelete: (query: QueryRecord) => void;
}) {
  const current = query.editedQuestion ?? query.question;
  const showOriginal = query.editedQuestion !== null && query.editedQuestion !== query.question;
  return (
    <div className="doc-row" data-testid="query-row">
      <span className="doc-icon" aria-hidden="true">
        Q
      </span>
      <span className="doc-info">
        <span className="doc-title" style={{ whiteSpace: 'normal' }} title={current}>
          {current}
        </span>
        {showOriginal ? <span className="doc-meta">Originally asked: “{query.question}”</span> : null}
        <span className="doc-meta">
          <span>Submitted {new Date(query.createdAt).toLocaleString()}</span>
          {query.status === 'edited' ? <span>Edited {new Date(query.updatedAt).toLocaleString()}</span> : null}
        </span>
      </span>
      <span className={`badge badge-${query.status}`}>
        {query.status === 'edited' ? 'Edited' : 'Pending'}
      </span>
      <span className="doc-actions">
        <button type="button" className="btn btn-sm" onClick={() => onEdit(query)} data-testid="query-edit">
          Edit
        </button>
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
