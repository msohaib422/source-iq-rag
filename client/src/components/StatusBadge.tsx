import type { DocumentStatus } from '../api/types';

const LABELS: Record<DocumentStatus, string> = {
  pending: 'Pending',
  processing: 'Indexing',
  ready: 'Indexed',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      {status === 'processing' ? <span className="spinner" style={{ width: 9, height: 9 }} /> : null}
      {LABELS[status]}
    </span>
  );
}