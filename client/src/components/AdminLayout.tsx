import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { PersonIcon } from './MessageAvatar';
import { ChatIcon, DashboardIcon, DocumentIcon, InboxIcon, MoonIcon, SettingsIcon, SunIcon } from './icons';

const NAV = [
  { to: '/admin', label: 'Dashboard', end: true, Icon: DashboardIcon },
  { to: '/admin/documents', label: 'Documents', end: false, Icon: DocumentIcon },
  { to: '/admin/queries', label: 'Queries', end: false, Icon: InboxIcon },
  { to: '/admin/settings', label: 'Settings', end: false, Icon: SettingsIcon },
  { to: '/chat', label: 'Chat', end: false, Icon: ChatIcon },
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
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/admin" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-text">
            <span className="brand-name">SourceIQ</span>
            <span className="brand-sub">Document knowledge assistant</span>
          </span>
        </NavLink>

        <nav className="app-nav" aria-label="Primary">
          {NAV.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="header-actions">
          {user ? (
            <>
              <span className="user-chip" title={user.email}>
                <span className="user-chip-avatar" aria-hidden="true">
                  <PersonIcon />
                </span>
                <span className="user-chip-name nowrap">{user.name}</span>
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={toggleTheme}
                aria-label="Toggle theme"
                title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              >
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </button>
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
