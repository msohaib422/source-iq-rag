import { useCallback, useRef, useState } from 'react';
import { api } from '../api/client';
import { Alert } from './Alert';
import { DocumentIcon } from './icons';
import { Spinner } from './Spinner';

export interface UploadResult {
  documentId: string;
  title: string;
  ok: boolean;
  error?: string;
}

/**
 * Drag-and-drop / click-to-browse PDF upload with real progress and explicit
 * indexing state. The server extracts, chunks and embeds before responding, so
 * the two phases (transfer, then indexing) are surfaced separately.
 */
export function UploadZone({ onUploaded }: { onUploaded: (result: UploadResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'indexing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setFilename(file.name);
      setPhase('uploading');
      setProgress(0);

      try {
        const result = await api.uploadDocument(
          file,
          (fraction) => setProgress(Math.round(fraction * 100)),
        );
        // Transfer done — the server is now extracting, chunking and embedding.
        setPhase('indexing');
        setProgress(null);

        const document = result.document;
        const ingestion = result.ingestion;

        if (ingestion.status === 'failed') {
          const message = ingestion.error ?? 'Indexing failed for an unknown reason.';
          setError(message);
          onUploaded({ documentId: document.id, title: document.title, ok: false, error: message });
          return;
        }

        onUploaded({
          documentId: document.id,
          title: document.title,
          ok: true,
        });
      } catch (err) {
        setError((err as Error)?.message ?? 'Upload failed.');
      } finally {
        setPhase('idle');
        setProgress(null);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [onUploaded],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setError('Only PDF files are supported.');
        return;
      }
      await upload(file);
    },
    [upload],
  );

  const busy = phase !== 'idle';

  return (
    <div>
      {error ? (
        <Alert tone="error" title="Upload problem" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Upload a PDF"
        data-testid="upload-zone"
      >
        <div className="dz-icon" aria-hidden="true">
          {busy ? <Spinner size="lg" /> : <DocumentIcon />}
        </div>
        <div className="dz-title">
          {busy ? (phase === 'uploading' ? 'Uploading…' : 'Extracting, chunking & embedding…') : 'Drop a PDF here'}
        </div>
        <div className="dz-hint">
          {busy ? (
            filename ? (
              <span className="mono">{filename}</span>
            ) : null
          ) : (
            <>
              or <span style={{ textDecoration: 'underline' }}>browse files</span> · PDF only · max 25 MB
            </>
          )}
        </div>

        {busy ? (
          <div className="progress">
            <div
              className={`progress-bar${phase === 'indexing' ? ' indeterminate' : ''}`}
              style={{ width: `${progress ?? 100}%` }}
            />
          </div>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-testid="file-input"
        onChange={(e) => void handleFiles(e.target.files)}
      />
    </div>
  );
}