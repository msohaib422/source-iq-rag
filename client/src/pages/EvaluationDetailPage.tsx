import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { useAsync } from '../hooks';

export function EvaluationDetailPage() {
  const { id } = useParams();
  const detail = useAsync(() => api.getEvaluation(id!), [id]);

  if (detail.loading) return <div className="center-state"><Spinner size="lg" /></div>;
  if (detail.error) return <Alert tone="error" title="Could not load evaluation">{detail.error}</Alert>;
  const e = detail.data?.evaluation;
  if (!e) return <Alert tone="error" title="Not found">Evaluation not found.</Alert>;

  return (
    <div>
      <div className="card page-hero page-head">
        <div>
          <h1>Evaluation detail</h1>
          <p className="subtitle">{e.question}</p>
        </div>
        <Link to="/admin/evaluations" className="btn btn-sm">Back</Link>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Question</h2>
        <p>{e.question}</p>
        <h2>Answer</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{e.answer}</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Metrics</h2>
        <ul>
          <li>Faithfulness: {e.faithfulnessScore !== null ? (e.faithfulnessScore * 100).toFixed(1) + '%' : '—'}</li>
          <li>Answer relevancy: {e.answerRelevancyScore !== null ? (e.answerRelevancyScore * 100).toFixed(1) + '%' : '—'}</li>
          <li>Context precision: {e.contextPrecision !== null ? (e.contextPrecision * 100).toFixed(1) + '%' : '—'}</li>
          <li>Context recall: {e.contextRecall !== null ? (e.contextRecall * 100).toFixed(1) + '%' : '—'}</li>
          <li>Answer correctness: {e.answerCorrectness !== null ? (e.answerCorrectness * 100).toFixed(1) + '%' : '—'}</li>
          <li>Retrieval quality: {e.retrievalQuality ?? '—'}</li>
          <li>Retry count: {e.retryCount}</li>
          <li>Latency: {e.processingTimeMs !== null ? e.processingTimeMs + ' ms' : '—'}</li>
          <li>Token usage: {e.tokenUsage ?? '—'}</li>
        </ul>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Retrieved chunks</h2>
        <p>Scores: {e.retrievalScores.map((s) => s.toFixed(3)).join(', ') || '—'}</p>
        <p>Chunk IDs: {e.retrievedChunkIds.join(', ') || '—'}</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Hallucination findings</h2>
        {e.hallucinationFindings.length ? (
          <ul>{e.hallucinationFindings.map((c, i) => <li key={i}>{c}</li>)}</ul>
        ) : <p>None.</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Self-RAG decisions</h2>
        <ul>{e.selfRagDecisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </div>

      <div className="card">
        <h2>CRAG actions</h2>
        <ul>{e.cragActions.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </div>
    </div>
  );
}