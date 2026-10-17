import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks';
import { useAuth } from '../context/AuthContext';

function Stat({ value, label, hint, to }: { value: string | number; label: string; hint?: string; to?: string }) {
  const content = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </>
  );
  // Cards bound to a page open it; the link keeps the exact stat-card look.
  if (to) {
    return (
      <Link to={to} className="card stat-card" style={{ textDecoration: 'none', color: 'inherit' }}>
        {content}
      </Link>
    );
  }
  return <div className="card stat-card">{content}</div>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const stats = useAsync(() => api.stats(), []);
  const docs = useAsync(() => api.listDocuments(), []);
  const health = useAsync(() => api.health(), []);

  const recent = (docs.data?.documents ?? []).slice(0, 5);
  const modelOk = health.data?.embedding.loaded;
  const expected = health.data?.embedding.expectedModel ?? 'BAAI/bge-small-en-v1.5';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
          <p className="subtitle">
            SourceIQ indexes your PDFs with a local embedding model and answers with citations.
          </p>
        </div>
        {user ? (
          <Link to="/admin/documents" className="btn btn-primary">
            Manage documents
          </Link>
        ) : null}
      </div>

      {health.error ? (
        <Alert tone="error" title="API unreachable">
          {health.error}
        </Alert>
      ) : null}

      {health.data ? (
        <div className="card mb">
          <div className="row wrap" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="row" style={{ marginBottom: '0.15rem' }}>
                <strong>{health.data.embedding.expectedModel}</strong>
                <span className={`badge badge-${modelOk ? 'ready' : 'pending'}`}>
                  {modelOk ? 'Loaded' : 'Not loaded'}
                </span>
                <span className="badge">{health.data.embedding.dimensions} dims</span>
                <span className="badge">{health.data.embedding.pooling} pooling</span>
              </div>
              <p className="small faint">
                Running locally on your machine — document text never leaves this server for embedding.
              </p>
            </div>
            <dl className="kv" style={{ minWidth: 220 }}>
              <dt>LLM</dt>
              <dd>
                {health.data.llm.provider} / {health.data.llm.model}
              </dd>
              <dt>Datastore</dt>
              <dd>{health.data.store.driver}</dd>
              <dt>API</dt>
              <dd>{health.data.environment}</dd>
            </dl>
          </div>
          {expected !== 'BAAI/bge-small-en-v1.5' ? (
            <Alert tone="warning" title="Unexpected embedding model">
              The server is configured with <code>{expected}</code>. The project specification requires{' '}
              <code>BAAI/bge-small-en-v1.5</code>.
            </Alert>
          ) : null}
        </div>
      ) : null}

      {stats.loading ? (
        <div className="center-state">
          <Spinner size="lg" />
        </div>
      ) : stats.error ? (
        <Alert tone="error" title="Could not load workspace statistics">
          {stats.error}
        </Alert>
      ) : (
        <div className="card-grid mb">
          <Stat value={stats.data?.documents ?? 0} label="Documents" />
          <Stat value={stats.data?.chunks ?? 0} label="Indexed chunks" hint="384-dim vectors" />
          <Stat value={stats.data?.pages ?? 0} label="Pages" />
          <Stat
            value={stats.data?.queries ?? 0}
            label="Queries"
            hint="Unanswered, pending review"
            to="/admin/queries"
          />
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.85rem' }}>
          <h2>Recent documents</h2>
          <Link to="/admin/documents" className="small">
            View all →
          </Link>
        </div>

        {docs.loading ? (
          <div className="center-state">
            <Spinner />
          </div>
        ) : recent.length === 0 ? (
          <div className="center-state">
            <p>No documents yet.</p>
            {user ? (
              <Link to="/admin/documents" className="btn btn-primary">
                Upload your first PDF
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="doc-list">
            {recent.map((doc) => (
              <Link
                key={doc.id}
                to={`/documents/${doc.id}`}
                className="doc-row"
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <span className="doc-icon">PDF</span>
                <span className="doc-info">
                  <span className="doc-title">{doc.title}</span>
                  <span className="doc-meta">
                    <span>{doc.chunkCount} chunks</span>
                    <span>{doc.pageCount} pages</span>
                    <span>{(doc.sizeBytes / 1024).toFixed(0)} KB</span>
                  </span>
                </span>
                <StatusBadge status={doc.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}