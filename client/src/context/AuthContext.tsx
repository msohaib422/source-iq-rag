import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  /**
   * True when a stored admin token was rejected (expired or tampered with).
   * Distinguishes "you had a session that expired" — which should offer
   * re-authentication — from simply being an anonymous visitor, who belongs on
   * the public chat.
   */
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
  updateProfile: (body: { name?: string; email?: string }) => Promise<void>;
  changePassword: (body: { currentPassword: string; newPassword: string }) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setSessionExpired(false);
    setError(null);
  }, []);

  // A 401 from any endpoint clears the session exactly once.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Restore the session on first mount if a token exists.
  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(({ user: me }) => {
        if (!cancelled) {
          setUser(me);
          setSessionExpired(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // The stored token was not accepted: offer sign-in again rather than
          // treating the visitor as a plain anonymous chat user.
          setToken(null);
          setSessionExpired(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const { token, user: me } = await api.login({ email, password });
      setToken(token);
      setUser(me);
      setSessionExpired(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Sign in failed.';
      setError(message);
      throw err;
    }
  }, []);

  const updateProfile = useCallback(async (body: { name?: string; email?: string }) => {
    const { user: me } = await api.updateProfile(body);
    setUser(me);
  }, []);

  const changePassword = useCallback(async (body: { currentPassword: string; newPassword: string }) => {
    await api.changePassword(body);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user, loading, error, sessionExpired, login, logout, clearError: () => setError(null), updateProfile, changePassword }),
    [user, loading, error, sessionExpired, login, logout, updateProfile, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}