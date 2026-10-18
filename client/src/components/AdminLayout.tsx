import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/documents', label: 'Documents', end: false },
  { to: '/admin/queries', label: 'Queries', end: false },
  { to: '/chat', label: 'Chat', end: false },
];

/**
 * Administrative shell.
 *
 * Rendered only behind the admin route guard, so it is never mounted for an
 * anonymous visitor. It carries the management navigation, the signed-in admin
 * and sign-out. The chat route stays reachable from here, which is how the admin
 * tests the RAG system without losing administrative access.
 *
 * The nav has no wrapper of its own: `.app-nav` is a plain flex row and each
 * link paints its own state, so only the selected item carries a background.
 */
export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/admin" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>SourceIQ</span>
        </NavLink>

        <nav className="app-nav" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="header-actions">
          {user ? (
            <>
              <span className="small muted nowrap user-name" title={user.email}>
                {user.name}
              </span>
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
          ) : null}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
