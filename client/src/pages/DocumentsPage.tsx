import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { DocumentStatus } from '../api/types';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/Modal';
import { DocumentIcon } from '../components/icons';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { UploadZone } from '../components/UploadZone';
import { useAuth } from '../context/AuthContext';
import { useAsync, useDebounced } from '../hooks';

const FILTERS: Array<{ label: string; value: DocumentStatus | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Indexed', value: 'ready' },
  { label: 'Indexing', value: 'processing' },
  { label: 'Failed', value: 'failed' },
];

export function DocumentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Only the admin manages the knowledge base; visitors get a read-only view.
  const isAdmin = Boolean(user);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<DocumentStatus | 'all'>('all');
  const debouncedSearch = useDebounced(search, 300);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Bulk selection: document ids picked with the row checkboxes. There is no
  // bulk endpoint - deletion reuses the existing per-document DELETE route, so
  // the server's own authorisation and cleanup (chunks, vectors, upload file)
  // apply to every record.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDelete, setBulkDelete] = useState<null | { mode: 'selected' | 'all' }>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const documents = useAsync(
    () =>
      api.listDocuments({
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(status !== 'all' ? { status } : {}),
      }),
    [debouncedSearch, status],
  );

  const onUploaded = useCallback(
    (result: { documentId: string; title: string; ok: boolean; error?: string }) => {
      if (result.ok) {
        setNotice({ tone: 'success', text: `“${result.title}” is indexed and ready to search.` });
        void documents.refetch(true);
      } else {
        setNotice({ tone: 'error', text: result.error ?? 'Indexing failed.' });
      }
    },
    [documents],
  );

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteDocument(pendingDelete);
      setNotice({ tone: 'success', text: 'Document deleted.' });
      setPendingDelete(null);
      await documents.refetch(true);
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Delete failed.' });
    } finally {
      setDeleting(false);
    }
  }

  /** Toggle one document's checkbox. */
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select (or clear) every document currently displayed in the list. */
  function toggleSelectAll() {
    setSelected((prev) => {
      if (list.length > 0 && list.every((d) => prev.has(d.id))) return new Set<string>();
      return new Set(list.map((d) => d.id));
    });
  }

  /**
   * Bulk delete either the selected documents or every document currently
   * listed. Each record goes through the existing DELETE route so the server
   * keeps enforcing authorisation and cleans up chunks, vectors and the stored
   * file. Failures are counted instead of aborting the remaining deletions.
   */
  async function confirmBulkDelete() {
    if (!bulkDelete || bulkDeleting) return;
    const ids =
      bulkDelete.mode === 'all'
        ? list.map((d) => d.id)
        : [...selected].filter((id) => list.some((d) => d.id === id));
    if (ids.length === 0) {
      setBulkDelete(null);
      return;
    }
    setBulkDeleting(true);
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteDocument(id);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setBulkDelete(null);
    if (failed === 0) {
      setSelected(new Set());
      setNotice({
        tone: 'success',
        text: `${deleted} document${deleted === 1 ? '' : 's'} deleted.`,
      });
    } else if (deleted === 0) {
      setNotice({ tone: 'error', text: `Could not delete the selected documents.` });
    } else {
      // Successfully removed ids drop out of the refreshed list and out of the
      // selection; the failed ones stay listed and selected.
      setNotice({
        tone: 'error',
        text: `Deleted ${deleted} of ${ids.length} documents — ${failed} could not be deleted.`,
      });
    }
    await documents.refetch(true);
  }

  const list = documents.data?.documents ?? [];
  const totalChunks = list.reduce((sum, d) => sum + d.chunkCount, 0);

  // Keep the selection in step with what is displayed: ids no longer present
  // (refiltered, deleted elsewhere, gone from a quiet refetch) are pruned,
  // so "Delete selected" never targets an invisible record.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      const visible = new Set(list.map((d) => d.id));
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents.data]);

  const selectedCount = selected.size;
  const allSelected = list.length > 0 && list.every((d) => selected.has(d.id));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="subtitle">
            {documents.loading
              ? 'Loading your library…'
              : `${list.length} document${list.length === 1 ? '' : 's'} · ${totalChunks} indexed chunks`}
          </p>
        </div>
      </div>

      {notice ? (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      ) : null}

      {isAdmin ? (
        <div className="card mb">
          <UploadZone onUploaded={onUploaded} />
        </div>
      ) : null}

      <div className="card">
        <div className="row wrap mb" style={{ justifyContent: 'space-between' }}>
          <div className="row wrap">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`btn btn-sm${status === filter.value ? ' btn-primary' : ''}`}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            type="search"
            placeholder="Search titles…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search documents"
          />
        </div>

        {isAdmin && list.length > 0 ? (
          <div className="row wrap mb" style={{ justifyContent: 'space-between' }}>
            <div className="row wrap">
              <label className="row" style={{ gap: '0.45rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  ref={(el) => {
                    // Indeterminate while only part of the list is selected.
                    if (el) el.indeterminate = selectedCount > 0 && selectedCount < list.length;
                  }}
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all documents"
                  data-testid="document-select-all"
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
                data-testid="document-delete-selected"
              >
                Delete selected
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setBulkDelete({ mode: 'all' })}
                data-testid="document-delete-all"
              >
                Delete all
              </button>
            </div>
          </div>
        ) : null}

        {documents.loading ? (
          <div className="center-state">
            <Spinner size="lg" />
          </div>
        ) : documents.error ? (
          <Alert tone="error" title="Could not load documents">
            {documents.error}
          </Alert>
        ) : list.length === 0 ? (
          <div className="center-state">
            <div className="empty-ico" aria-hidden="true">
              <DocumentIcon />
            </div>
            <p>
              {search || status !== 'all'
                ? 'No documents match this filter.'
                : isAdmin
                  ? 'Upload a PDF to get started.'
                  : 'The knowledge base is empty. Sign in as the admin to add documents.'}
            </p>
          </div>
        ) : (
          <div className="doc-list" data-testid="document-list">
            {list.map((doc) => (
              <div className="doc-row" key={doc.id} data-testid="document-row">
                {isAdmin ? (
                  <input
                    type="checkbox"
                    style={{ accentColor: 'var(--brand)', flexShrink: 0, margin: 0, cursor: 'pointer' }}
                    checked={selected.has(doc.id)}
                    onChange={() => toggleSelect(doc.id)}
                    aria-label={`Select ${doc.title}`}
                    data-testid="document-select"
                  />
                ) : null}
                <span className="doc-icon">PDF</span>
                <span className="doc-info">
                  <Link to={`/admin/documents/${doc.id}`} className="doc-title">
                    {doc.title}
                  </Link>
                  <span className="doc-meta">
                    <span title={new Date(doc.createdAt).toLocaleString()}>
                      {new Date(doc.createdAt).toLocaleDateString()}
                    </span>
                    <span>{doc.pageCount} pages</span>
                    <span>{doc.chunkCount} chunks</span>
                    <span>{(doc.sizeBytes / 1024).toFixed(0)} KB</span>
                  </span>
                  {doc.status === 'failed' && doc.error ? (
                    <span className="small" style={{ color: 'var(--danger)', display: 'block', marginTop: '0.2rem' }}>
                      {doc.error}
                    </span>
                  ) : null}
                </span>
                <StatusBadge status={doc.status} />
                <span className="doc-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate(`/admin/documents/${doc.id}`)}
                  >
                    Open
                  </button>
                  {isAdmin ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => setPendingDelete(doc.id)}
                      aria-label={`Delete ${doc.title}`}
                      data-testid="document-delete"
                    >
                      Delete
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this document?"
        message="This permanently removes the document, all of its chunks and their vectors from the index. It cannot be undone."
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={bulkDelete !== null}
        title={bulkDelete?.mode === 'all' ? 'Delete all documents?' : 'Delete selected documents?'}
        message={
          bulkDelete === null
            ? null
            : bulkDelete.mode === 'all'
              ? `This permanently removes all ${list.length} document${list.length === 1 ? '' : 's'} currently listed, together with all of their chunks and vectors from the index. It cannot be undone.`
              : `This permanently removes the selected ${selectedCount} document${selectedCount === 1 ? '' : 's'}, together with all of their chunks and vectors from the index. It cannot be undone.`
        }
        busy={bulkDeleting}
        onConfirm={() => void confirmBulkDelete()}
        onCancel={() => setBulkDelete(null)}
      />
    </div>
  );
}