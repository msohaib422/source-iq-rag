import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Public shell.
 *
 * Anonymous visitors never see administrative chrome: no navigation, no
 * statistics, no health, no management. The header carries branding only — the
 * administrative sign-in link used to live here, but it is not part of the
 * visitor experience any more. A signed-in admin keeps the two legitimate
 * controls: a way back to the dashboard and a way to sign out. The /login route
 * and the server-side authentication it guards are untouched.
 */
export function PublicLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>SourceIQ</span>
        </NavLink>

        {user ? (
          <div className="header-actions">
            <NavLink to="/admin" className="btn btn-sm">
              Admin dashboard
            </NavLink>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                logout();
                navigate('/', { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
