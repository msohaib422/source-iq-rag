import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../api/client';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { useAsync } from '../hooks';

function num(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}

export function EvaluationPage() {
  const [mode, setMode] = useState<'all' | 'online' | 'offline'>('all');
  const stats = useAsync(() => api.evaluationStats(), []);
  const list = useAsync(
    () => api.listEvaluations({ limit: 50, mode: mode === 'all' ? undefined : mode }),
    [mode],
  );

  return (
    <div>
      <div className="card page-hero page-head">
        <div>
          <h1>RAG Evaluation</h1>
          <p className="subtitle">Retrieval quality, faithfulness, and Self-RAG / CRAG activity.</p>
        </div>
        <Link to="/admin" className="btn btn-sm">
          Back to dashboard
        </Link>
      </div>

      {stats.error ? <Alert tone="error" title="Could not load stats">{stats.error}</Alert> : null}

      {stats.loading ? (
        <div className="center-state"><Spinner size="lg" /></div>
      ) : stats.data ? (
        <div className="stat-grid mb">
          <div className="card stat-card">
            <span className="stat-label">Evaluated queries</span>
            <span className="stat-value">{stats.data.stats.total}</span>
            <span className="stat-hint">Total recorded</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Avg faithfulness</span>
            <span className="stat-value">{num(stats.data.stats.avgFaithfulness)}</span>
            <span className="stat-hint">Answer support</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Avg answer relevancy</span>
            <span className="stat-value">{num(stats.data.stats.avgAnswerRelevancy)}</span>
            <span className="stat-hint">Question coverage</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Avg context precision</span>
            <span className="stat-value">{num(stats.data.stats.avgContextPrecision)}</span>
            <span className="stat-hint">Retrieved relevance</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Retrieval success</span>
            <span className="stat-value">{num(stats.data.stats.retrievalSuccessRate)}</span>
            <span className="stat-hint">CORRECT rate</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Hallucination rate</span>
            <span className="stat-value">{num(stats.data.stats.hallucinationRate)}</span>
            <span className="stat-hint">Unsupported claims</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Avg latency</span>
            <span className="stat-value">{stats.data.stats.avgLatencyMs ? Math.round(stats.data.stats.avgLatencyMs) + ' ms' : '—'}</span>
            <span className="stat-hint">Processing time</span>
          </div>
          <div className="card stat-card">
            <span className="stat-label">Avg retries</span>
            <span className="stat-value">{stats.data.stats.avgRetryCount !== null ? stats.data.stats.avgRetryCount.toFixed(2) : '—'}</span>
            <span className="stat-hint">Self-RAG retries</span>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Evaluation history</h2>
            <p className="section-sub">Recent evaluated queries.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['all', 'online', 'offline'] as const).map((m) => (
              <button
                key={m}
                className={`btn btn-sm${mode === m ? ' btn-primary' : ''}`}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {list.loading ? (
          <div className="center-state"><Spinner /></div>
        ) : list.error ? (
          <Alert tone="error" title="Could not load history">{list.error}</Alert>
        ) : (list.data?.items?.length ?? 0) === 0 ? (
          <div className="center-state"><p>No evaluations yet.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Question</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Faithfulness</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Relevancy</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Quality</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Mode</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {list.data!.items.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                    <td style={{ padding: 8, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link to={`/admin/evaluations/${e.id}`}>{e.question}</Link>
                    </td>
                    <td style={{ padding: 8 }}>{e.faithfulnessScore !== null ? (e.faithfulnessScore * 100).toFixed(0) + '%' : '—'}</td>
                    <td style={{ padding: 8 }}>{e.answerRelevancyScore !== null ? (e.answerRelevancyScore * 100).toFixed(0) + '%' : '—'}</td>
                    <td style={{ padding: 8 }}>{e.retrievalQuality ?? '—'}</td>
                    <td style={{ padding: 8 }}>{e.mode}</td>
                    <td style={{ padding: 8 }}>{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}