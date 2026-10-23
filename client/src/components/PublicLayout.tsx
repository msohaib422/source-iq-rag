import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { MoonIcon, SunIcon } from './icons';

/**
 * Public shell.
 *
 * Anonymous visitors never see administrative chrome: no navigation, no
 * statistics, no health, no management. The header carries branding and the
 * theme toggle — the administrative sign-in link used to live here, but it is
 * not part of the visitor experience any more. A signed-in admin keeps the two
 * legitimate controls: a way back to the dashboard and a way to sign out. The
 * /login route and the server-side authentication it guards are untouched.
 */
export function PublicLayout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-text">
            <span className="brand-name">SourceIQ</span>
            <span className="brand-sub">Document knowledge assistant</span>
          </span>
        </NavLink>

        <div className="header-actions">
          {user ? (
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
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
