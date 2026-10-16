import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Chunk } from '../api/types';
import { Spinner } from './Spinner';

/**
 * Chunk viewer/editor.
 *
 * Saving re-embeds the text server-side with the same BGE model, so the vector
 * index stays consistent with what the user sees. Deleting removes the chunk and
 * decrements the document's cached chunk count.
 */
export function ChunkEditor({
  chunk,
  onChanged,
  onDeleted,
  readOnly = false,
}: {
  chunk: Chunk;
  onChanged: (chunk: Chunk) => void;
  onDeleted: (chunkId: string) => void;
  /** Anonymous visitors may read chunks but never edit or delete them. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chunk.text);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const { chunk: updated } = await api.updateChunk(chunk.id, draft);
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the chunk.');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    setError(null);
    try {
      await api.deleteChunk(chunk.id);
      onDeleted(chunk.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the chunk.');
      setBusy(null);
    }
  }

  return (
    <div className="chunk" data-testid="chunk" data-chunk-id={chunk.id}>
      <div className="chunk-head">
        <span className="chunk-num">#{chunk.ordinal + 1}</span>
        {chunk.page ? <span className="badge">page {chunk.page}</span> : null}
        {chunk.edited ? (
          <span className="badge badge-edited" data-testid="chunk-edited-badge">
            edited
          </span>
        ) : null}
        <span className="spacer" />
        <span className="faint small nowrap">
          {chunk.text.length} chars
          {chunk.charStart !== null ? ` · [${chunk.charStart}–${chunk.charEnd ?? ''}]` : ''}
        </span>
      </div>

      {error ? (
        <div style={{ padding: '0.6rem 0.8rem 0' }}>
          <div className="alert alert-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <div className="alert-body">{error}</div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <>
          <div className="chunk-body editing" style={{ paddingBottom: 0.4 }}>
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`Edit chunk ${chunk.ordinal + 1}`}
              data-testid="chunk-textarea"
              rows={8}
            />
            <p className="field-hint mt">
              Saving re-embeds this text with {`BAAI/bge-small-en-v1.5`} (384 dims) so vector search stays accurate.
            </p>
          </div>
          <div className="chunk-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void save()}
              disabled={busy !== null || draft.trim().length === 0}
              data-testid="chunk-save"
            >
              {busy === 'save' ? <Spinner /> : null} Save & re-embed
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(chunk.text);
                setEditing(false);
                setError(null);
              }}
              disabled={busy !== null}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="chunk-body">{chunk.text}</div>
          {readOnly ? null : (
            <div className="chunk-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setEditing(true)}
                data-testid="chunk-edit"
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void remove()}
                disabled={busy !== null}
                data-testid="chunk-delete"
              >
                {busy === 'delete' ? <Spinner /> : null} Delete chunk
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}