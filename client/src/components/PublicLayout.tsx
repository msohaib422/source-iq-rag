import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Public shell.
 *
 * Anonymous visitors never see administrative chrome: no navigation, no
 * statistics, no health, no management. The header carries branding and a single
 * quiet entry point to the admin sign-in; a signed-in admin additionally gets a
 * way back to the dashboard and to sign out.
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

        <div className="header-actions">
          {user ? (
            <>
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
            </>
          ) : (
            // Regular visitors need no account; this is the admin-only entry point.
            <Link to="/login" className="btn btn-sm">
              Admin sign in
            </Link>
          )}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
