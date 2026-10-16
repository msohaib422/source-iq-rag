import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog for keyboard users.
    ref.current?.querySelector<HTMLElement>('button, input, textarea, select')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(0 0 0 / 0.6)',
        display: 'grid',
        placeItems: 'center',
        padding: '1rem',
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="card pad-lg"
        style={{ maxWidth: 460, width: '100%', boxShadow: 'var(--shadow-lg)' }}
      >
        <h2 style={{ marginBottom: '0.75rem' }}>{title}</h2>
        {children}
        {footer ? <div className="row mt" style={{ justifyContent: 'flex-end' }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              onConfirm();
            }}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : null}
            {armed ? `Click again to ${confirmLabel.toLowerCase()}` : confirmLabel}
          </button>
        </>
      }
    >
      <div className="muted">{message}</div>
    </Modal>
  );
}