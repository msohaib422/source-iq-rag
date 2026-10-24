import { useState } from 'react';
import { Alert } from '../components/Alert';
import { EyeIcon, EyeOffIcon, MoonIcon, SunIcon } from '../components/icons';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export function SettingsPage() {
  const { user, updateProfile, changePassword } = useAuth();
  const { theme, setTheme } = useTheme();

  // Profile state
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileNotice(null);
    if (!name.trim()) {
      setProfileNotice({ tone: 'error', text: 'Name is required.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setProfileNotice({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setProfileBusy(true);
    try {
      await updateProfile({ name: name.trim(), email: email.trim() });
      setProfileNotice({ tone: 'success', text: 'Profile updated.' });
    } catch (err) {
      setProfileNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Update failed.' });
    } finally {
      setProfileBusy(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordNotice(null);
    if (!currentPassword) {
      setPasswordNotice({ tone: 'error', text: 'Current password is required.' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordNotice({ tone: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordNotice({ tone: 'error', text: 'New passwords do not match.' });
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordNotice({ tone: 'success', text: 'Password changed successfully.' });
    } catch (err) {
      setPasswordNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Password change failed.' });
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Manage your profile, password, and appearance.</p>
        </div>
      </div>

      <div className="card mb">
        <h2>Appearance</h2>
        <p className="small faint" style={{ marginBottom: '0.75rem' }}>Choose the interface theme.</p>
        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            type="button"
            className={`btn btn-sm${theme === 'light' ? ' btn-primary' : ''}`}
            onClick={() => setTheme('light')}
          >
            <span className="btn-ico">
              <SunIcon />
            </span>
            Light
          </button>
          <button
            type="button"
            className={`btn btn-sm${theme === 'dark' ? ' btn-primary' : ''}`}
            onClick={() => setTheme('dark')}
          >
            <span className="btn-ico">
              <MoonIcon />
            </span>
            Dark
          </button>
        </div>
      </div>

      <div className="card mb">
        <h2>Admin Profile</h2>
        {profileNotice ? (
          <Alert tone={profileNotice.tone} onDismiss={() => setProfileNotice(null)}>
            {profileNotice.text}
          </Alert>
        ) : null}
        <form onSubmit={handleProfileSubmit}>
          <div className="field">
            <label htmlFor="settings-name">Name</label>
            <input
              id="settings-name"
              className="input"
              type="text"
              placeholder="Enter admin name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={profileBusy}
            />
          </div>
          <div className="field">
            <label htmlFor="settings-email">Email address</label>
            <input
              id="settings-email"
              className="input"
              type="email"
              placeholder="Enter email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={profileBusy}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={profileBusy}>
            {profileBusy ? <Spinner size="sm" /> : null} Save profile
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Change Password</h2>
        {passwordNotice ? (
          <Alert tone={passwordNotice.tone} onDismiss={() => setPasswordNotice(null)}>
            {passwordNotice.text}
          </Alert>
        ) : null}
        <form onSubmit={handlePasswordSubmit}>
          <div className="field">
            <label htmlFor="settings-current">Current password</label>
            <div className="row" style={{ gap: '0.5rem' }}>
              <input
                id="settings-current"
                className="input"
                type={showCurrent ? 'text' : 'password'}
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={passwordBusy}
              />
              <button type="button" className="btn btn-sm" onClick={() => setShowCurrent((v) => !v)} aria-label={showCurrent ? 'Hide current password' : 'Show current password'}>
                <span className="btn-ico">{showCurrent ? <EyeOffIcon /> : <EyeIcon />}</span>
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="settings-new">New password</label>
            <div className="row" style={{ gap: '0.5rem' }}>
              <input
                id="settings-new"
                className="input"
                type={showNew ? 'text' : 'password'}
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={passwordBusy}
              />
              <button type="button" className="btn btn-sm" onClick={() => setShowNew((v) => !v)} aria-label={showNew ? 'Hide new password' : 'Show new password'}>
                <span className="btn-ico">{showNew ? <EyeOffIcon /> : <EyeIcon />}</span>
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="settings-confirm">Confirm new password</label>
            <div className="row" style={{ gap: '0.5rem' }}>
              <input
                id="settings-confirm"
                className="input"
                type={showConfirm ? 'text' : 'password'}
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={passwordBusy}
              />
              <button type="button" className="btn btn-sm" onClick={() => setShowConfirm((v) => !v)} aria-label={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'}>
                <span className="btn-ico">{showConfirm ? <EyeOffIcon /> : <EyeIcon />}</span>
              </button>
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={passwordBusy}>
            {passwordBusy ? <Spinner size="sm" /> : null} Change password
          </button>
        </form>
      </div>
    </div>
  );
}