import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const { user, login, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (user) return <Navigate to="/admin" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldErrors({});
    try {
      await login(email, password);
      // Signing in means "show me the dashboard": default there, or back to the
      // admin page the visitor was originally sent away from.
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/admin', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card pad-lg auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span style={{ fontWeight: 700, fontSize: '1.15rem', letterSpacing: '-0.03em' }}>SourceIQ</span>
        </div>
        <p className="auth-sub">Admin sign in — manage documents, chunks and system diagnostics.</p>

        {error ? (
          <Alert tone="error" onDismiss={clearError}>
            {error}
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            {fieldErrors.password ? <span className="field-error">{fieldErrors.password}</span> : null}
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <Spinner /> : null} Sign in
          </button>
        </form>
      </div>
    </div>
  );
}