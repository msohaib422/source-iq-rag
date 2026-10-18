import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { DocumentStatus } from '../api/types';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/Modal';
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

  const list = documents.data?.documents ?? [];
  const totalChunks = list.reduce((sum, d) => sum + d.chunkCount, 0);

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
            <div style={{ fontSize: '2rem', opacity: 0.5 }} aria-hidden="true">
              📚
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
    </div>
  );
}