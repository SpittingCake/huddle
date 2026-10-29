import { lazy, Suspense, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, setToken } from './api.js';
import Login from './Login.jsx';
// Voice pulls in livekit-client (~400 kB); only load it on the page that needs it.
const VoiceTest = lazy(() => import('./VoiceTest.jsx'));

// Batch 0 shell: sign in, load the server, show channels + members with live
// online state over the socket. The real rail / chat / voice UI is batch 2+.

function inviteFromUrl() {
  const m = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  const [data, setData] = useState(null);
  const [online, setOnline] = useState(new Set());
  const [invite] = useState(inviteFromUrl);

  // Restore the session on load.
  useEffect(() => {
    if (!getToken()) return setUser(null);
    api('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => { setToken(null); setUser(null); });
  }, []);

  // Once signed in: load the server and open the socket.
  useEffect(() => {
    if (!user) return;

    const socket = io({ auth: { token: getToken() } });
    const knownIds = new Set();
    const load = () => api('/api/server').then((d) => { d.members.forEach((m) => knownIds.add(m.id)); setData(d); }).catch(console.error);
    load();

    socket.on('presence:snapshot', ({ online }) => setOnline(new Set(online)));
    socket.on('presence:online', ({ user_id }) => {
      setOnline((s) => new Set(s).add(user_id));
      if (!knownIds.has(user_id)) load(); // someone new just signed up — refresh the member list
    });
    socket.on('presence:offline', ({ user_id }) => setOnline((s) => { const n = new Set(s); n.delete(user_id); return n; }));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { setToken(null); setUser(null); }
    });
    return () => socket.disconnect();
  }, [user]);

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    setUser(null);
    setData(null);
  }

  function onLogin(u) {
    if (invite) window.history.replaceState(null, '', '/');
    setUser(u);
  }

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <Login invite={invite} onLogin={onLogin} />;
  if (window.location.pathname === '/voice-test') return (
      <Suspense fallback={<div className="center muted">Loading…</div>}>
        <VoiceTest user={user} />
      </Suspense>
    );

  return (
    <div className="shell">
      <aside className="rail">
        <div className="server-name">{data?.server?.name ?? 'Huddle'}</div>
        <ul className="channels">
          {data?.channels.map((c) => (
            <li key={c.id} className={`channel ${c.type}`}>
              <span className="glyph">{c.type === 'voice' ? '🔊' : '#'}</span> {c.name}
            </li>
          ))}
        </ul>
        <div className="me">
          <div>
            <div className="name">{user.display_name}</div>
            <div className="muted small">@{user.username}{user.role === 'owner' ? ' · owner' : ''}</div>
          </div>
          <button className="ghost" onClick={signOut} title="Sign out of this device">Sign out</button>
        </div>
      </aside>

      <main className="main">
        <h2>Batch 0 — skeleton</h2>
        <p className="muted">
          Sign-in, sessions, the server row, and live presence are working. Channels, messages and voice come in the next batches.
        </p>
        <p><a href="/voice-test">Open the voice test →</a></p>
      </main>

      <aside className="members">
        <div className="section-title">Members — {online.size} online</div>
        <ul>
          {data?.members.map((m) => (
            <li key={m.id} className={online.has(m.id) ? 'online' : 'offline'}>
              <span className="dot" /> {m.display_name}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
