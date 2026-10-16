export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md' | 'lg'; label?: string }) {
  return (
    <span className="row" role="status" aria-live="polite">
      <span className={`spinner${size === 'lg' ? ' lg' : ''}`} aria-hidden="true" />
      {label ? <span className="small muted">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}