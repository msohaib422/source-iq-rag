import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks';
import { useAuth } from '../context/AuthContext';

/**
 * Informational statistic: an eyebrow label, the value, and an optional
 * supporting note. These cards are deliberately not interactive — the numbers
 * are explained and managed on their own pages (Documents, Queries), which is
 * where the navigation links live. The note line keeps its height even when
 * empty so all four values sit on the same baseline.
 */
function Stat({ value, label, hint }: { value: string | number; label: string; hint?: string }) {
  // Counts of five digits or more shrink so they stay comfortable in the card.
  const tight = String(value).length >= 5;
  return (
    <div className="card stat-card">
      <span className="stat-label">
        <span className="stat-dot" aria-hidden="true" />
        {label}
      </span>
      <span className={`stat-value${tight ? ' stat-value-tight' : ''}`}>{value}</span>
      <span className="stat-hint">{hint ?? ''}</span>
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const stats = useAsync(() => api.stats(), []);
  const docs = useAsync(() => api.listDocuments(), []);
  // The health call stays for connectivity feedback only: the embedding/LLM
  // metrics panel was removed from the dashboard, but the admin still wants to
  // know immediately when the API is unreachable.
  const health = useAsync(() => api.health(), []);

  const recent = (docs.data?.documents ?? []).slice(0, 5);

  return (
    <div>
      <div className="card page-hero page-head">
        <div>
          <h1>Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
          <p className="subtitle">
            Your knowledge base, indexing activity, and query insights — all in one place.
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

      {stats.loading ? (
        <div className="center-state">
          <Spinner size="lg" />
        </div>
      ) : stats.error ? (
        <Alert tone="error" title="Could not load workspace statistics">
          {stats.error}
        </Alert>
      ) : (
        <div className="stat-grid mb">
          <Stat value={stats.data?.documents ?? 0} label="Documents" />
          <Stat value={stats.data?.chunks ?? 0} label="Indexed chunks" hint="384-dim vectors" />
          <Stat value={stats.data?.pages ?? 0} label="Pages" />
          <Stat value={stats.data?.queries ?? 0} label="Queries" hint="Unanswered, pending review" />
        </div>
      )}

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Recent documents</h2>
            <p className="section-sub">The latest files added to your knowledge base.</p>
          </div>
          <Link to="/admin/documents" className="btn btn-sm section-action">
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
              // The detail route lives under /admin — a bare /documents/:id
              // hits the catch-all and bounces to the public chat.
              <Link key={doc.id} to={`/admin/documents/${doc.id}`} className="doc-row">
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
                <span className="doc-row-go" aria-hidden="true">
                  →
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}