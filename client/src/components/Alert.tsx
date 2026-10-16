import type { ReactNode } from 'react';

type Tone = 'error' | 'success' | 'info' | 'warning';

const ICONS: Record<Tone, string> = { error: '⚠', success: '✓', info: 'ℹ', warning: '⚠' };

export function Alert({
  tone = 'info',
  title,
  children,
  onDismiss,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{ICONS[tone]}</span>
      <div className="alert-body">
        {title ? <div className="alert-title">{title}</div> : null}
        {children}
      </div>
      {onDismiss ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      ) : null}
    </div>
  );
}