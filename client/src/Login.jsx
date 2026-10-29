import { useEffect, useState } from 'react';
import { api, setToken, deviceLabel } from './api.js';

const ERRORS = {
  invalid_login: 'Wrong username or password.',
  too_many_attempts: 'Too many attempts — wait 15 minutes and try again.',
  invalid_invite: 'That invite link is invalid, expired, or used up.',
  username_taken: 'That username is taken.',
  bad_username: 'Usernames are 2–32 letters, numbers, dots, dashes or underscores.',
  password_too_short: 'Passwords need at least 10 characters.',
};

export default function Login({ invite, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { valid, server_name } once the invite is checked
  const [mode, setMode] = useState(invite ? 'register' : 'login');
  const registering = mode === 'register' && Boolean(invite);

  // With an invite in the URL, ask the server whose invite it is before showing the form.
  useEffect(() => {
    if (!invite) return;
    api(`/auth/invite/${invite}`).then(setPreview).catch(() => setPreview({ valid: false, server_name: 'Huddle' }));
  }, [invite]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { username: username.trim(), password, device_label: deviceLabel() };
      if (registering) Object.assign(body, { invite, display_name: displayName.trim() || undefined });
      const { token, user } = await api(registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
      setToken(token);
      onLogin(user);
    } catch (err) {
      setError(ERRORS[err.message] || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const serverName = preview?.server_name || 'Huddle';
  const inviteDead = invite && preview && !preview.valid;

  let blurb;
  if (registering) blurb = inviteDead ? ERRORS.invalid_invite : preview ? `You've been invited to ${serverName}. Pick a username.` : 'Checking your invite…';
  else blurb = 'Sign in to your server.';

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>{registering && preview?.valid ? serverName : 'Huddle'}</h1>
        <p className={inviteDead && registering ? 'error' : 'muted'}>{blurb}</p>

        {registering && inviteDead ? (
          <p className="muted small">Ask whoever sent it for a new link. Already have an account? <button type="button" className="link" onClick={() => setMode('login')}>Sign in</button></p>
        ) : (
          <>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
            </label>
            {registering && (
              <label>
                Display name <span className="muted">(optional)</span>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
              </label>
            )}
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={registering ? 'new-password' : 'current-password'}
                minLength={registering ? 10 : undefined}
                required
              />
            </label>

            {error && <div className="error">{error}</div>}

            <button type="submit" disabled={busy || (registering && !preview)}>
              {busy ? '…' : registering ? 'Create account' : 'Sign in'}
            </button>

            {invite && (
              <p className="muted small center-text">
                {registering
                  ? <>Already have an account? <button type="button" className="link" onClick={() => setMode('login')}>Sign in instead</button></>
                  : <>Have the invite? <button type="button" className="link" onClick={() => setMode('register')}>Create an account</button></>}
              </p>
            )}
          </>
        )}
      </form>
    </div>
  );
}
