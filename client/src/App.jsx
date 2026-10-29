import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, setToken } from './api.js';
import Login from './Login.jsx';
import Rail from './Rail.jsx';
import ChannelView from './ChannelView.jsx';
// Voice pulls in livekit-client (~400 kB); only load it on the page that needs it.
const VoiceTest = lazy(() => import('./VoiceTest.jsx'));
// Settings is owner-only and rarely open; keep it out of the main bundle too.
const Settings = lazy(() => import('./Settings.jsx'));

// Batch 2 shell: rail with categories + channel selection, owner settings
// (server name, channels, invites), live reload when the owner changes
// anything. Messages are batch 3, real voice channels batch 4.

function inviteFromUrl() {
  const m = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function channelFromUrl() {
  const m = window.location.pathname.match(/^\/c\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  const [data, setData] = useState(null);
  const [online, setOnline] = useState(new Set());
  const [invite] = useState(inviteFromUrl);
  const [channelId, setChannelId] = useState(channelFromUrl);
  const [settings, setSettings] = useState(null); // null | { tab, categoryId? }

  // Restore the session on load.
  useEffect(() => {
    if (!getToken()) return setUser(null);
    api('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => { setToken(null); setUser(null); });
  }, []);

  const load = useCallback(() => api('/api/server').then(setData).catch(console.error), []);

  // Once signed in: load the server and open the socket.
  useEffect(() => {
    if (!user) return;
    const socket = io({ auth: { token: getToken() } });
    load();

    socket.on('presence:snapshot', ({ online }) => setOnline(new Set(online)));
    socket.on('presence:online', ({ user_id }) => {
      setOnline((s) => new Set(s).add(user_id));
      setData((d) => { if (d && !d.members.some((m) => m.id === user_id)) load(); return d; }); // someone new signed up
    });
    socket.on('presence:offline', ({ user_id }) => setOnline((s) => { const n = new Set(s); n.delete(user_id); return n; }));
    socket.on('server:changed', load);
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { setToken(null); setUser(null); }
    });
    return () => socket.disconnect();
  }, [user, load]);

  // Keep the selected channel valid and mirrored in the URL.
  const channel = useMemo(() => data?.channels.find((c) => c.id === channelId) || null, [data, channelId]);
  useEffect(() => {
    if (!data) return;
    if (!channel) {
      const first = data.channels.find((c) => c.type === 'text') || data.channels[0];
      if (first) setChannelId(first.id);
      return;
    }
    const path = `/c/${channel.id}`;
    if (window.location.pathname !== path) window.history.replaceState(null, '', path);
  }, [data, channel]);

  // Back/forward buttons.
  useEffect(() => {
    const onPop = () => setChannelId(channelFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  function selectChannel(id) {
    setChannelId(id);
    window.history.pushState(null, '', `/c/${id}`);
  }

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <Login invite={invite} onLogin={onLogin} />;
  if (window.location.pathname === '/voice-test') return (
      <Suspense fallback={<div className="center muted">Loading…</div>}>
        <VoiceTest user={user} />
      </Suspense>
    );

  const isOwner = user.role === 'owner';

  return (
    <div className="shell">
      <Rail
        data={data}
        user={user}
        channelId={channel?.id ?? null}
        onSelect={selectChannel}
        onSignOut={signOut}
        onOpenSettings={isOwner ? (tab, extra) => setSettings({ tab: tab || 'overview', ...extra }) : null}
      />

      <main className="main">
        <ChannelView channel={channel} />
      </main>

      <aside className="members">
        <div className="section-title">Members — {online.size} online</div>
        <ul>
          {data?.members.map((m) => (
            <li key={m.id} className={online.has(m.id) ? 'online' : 'offline'}>
              <span className="dot" />
              <span className="member-name">{m.display_name}</span>
              {m.role === 'owner' && <span className="tag">owner</span>}
            </li>
          ))}
        </ul>
      </aside>

      {settings && isOwner && data && (
        <Suspense fallback={null}>
          <Settings data={data} initial={settings} onClose={() => setSettings(null)} reload={load} />
        </Suspense>
      )}
    </div>
  );
}
