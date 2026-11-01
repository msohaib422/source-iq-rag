import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AdminLayout } from './components/AdminLayout';
import { PublicLayout } from './components/PublicLayout';
import { Spinner } from './components/Spinner';
import { useAuth } from './context/AuthContext';
import { ChatPage } from './pages/ChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { EvaluationDetailPage } from './pages/EvaluationDetailPage';
import { EvaluationPage } from './pages/EvaluationPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { LoginPage } from './pages/LoginPage';
import { QueriesPage } from './pages/QueriesPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * Two clearly separated front doors:
 *
 *  - `/` and `/chat` are the public RAG chat. No account, no admin chrome.
 *  - `/admin…` is the administrative dashboard: statistics, health/diagnostics
 *    and document/chunk management.
 *
 * While a stored admin session is being restored we briefly hold rendering so
 * the first requests carry the right credentials (or none, for anonymous
 * visitors) and the guard below never flashes admin chrome at a visitor.
 */
function SessionGate() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="center-state" style={{ minHeight: '60vh' }}>
        <Spinner size="lg" />
        <p>Restoring your session…</p>
      </div>
    );
  }
  return <Outlet />;
}

/**
 * Shell for the public chat route.
 *
 * Anonymous visitors get the minimal public chrome. A signed-in admin gets the
 * full administrative shell instead, so the primary navigation
 * (Dashboard / Documents / Chat / Queries) stays visible and highlights Chat
 * while using the same chat page - without touching the chat layout itself.
 */
function ChatLayout() {
  const { user } = useAuth();
  return user ? <AdminLayout /> : <PublicLayout />;
}

/**
 * Route-level gate for every administrative page.
 *
 * This is presentation only: it keeps the dashboard out of anonymous sessions
 * and turns direct URL visits away from it. Authorization is enforced
 * independently and server-side (every mutating API rejects anonymous callers
 * with 401) - this guard is not a substitute for it.
 *
 * Where it sends a visitor without a valid session depends on the reason: an
 * admin session that was rejected is offered re-authentication, while a plain
 * anonymous visitor (or someone who just signed out) belongs on the public chat.
 */
function RequireAdmin() {
  const { user, sessionExpired } = useAuth();
  const location = useLocation();

  if (!user) {
    return sessionExpired ? (
      <Navigate to="/login" state={{ from: `${location.pathname}${location.search}` }} replace />
    ) : (
      <Navigate to="/" replace />
    );
  }
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<SessionGate />}>
        <Route element={<ChatLayout />}>
          <Route path="/" element={<ChatPage />} />
          <Route path="/chat" element={<ChatPage />} />
        </Route>

        <Route element={<RequireAdmin />}>
          <Route element={<AdminLayout />}>
            <Route path="/admin" element={<DashboardPage />} />
            <Route path="/admin/documents" element={<DocumentsPage />} />
            <Route path="/admin/documents/:id" element={<DocumentDetailPage />} />
            <Route path="/admin/queries" element={<QueriesPage />} />
            <Route path="/admin/evaluations" element={<EvaluationPage />} />
            <Route path="/admin/evaluations/:id" element={<EvaluationDetailPage />} />
            <Route path="/admin/settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
