import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import * as socket from './socket.js';
import Login from './Login.jsx';
import Rail from './Rail.jsx';
import ChannelView from './ChannelView.jsx';
import Avatar from './Avatar.jsx';
// Voice pulls in livekit-client (~400 kB); only load it on the page that needs it.
const VoiceTest = lazy(() => import('./VoiceTest.jsx'));
// Settings is owner-only and rarely open; keep it out of the main bundle too.
const Settings = lazy(() => import('./Settings.jsx'));
const Profile = lazy(() => import('./Profile.jsx'));

// Batch 3 shell: text channels are live (messages, unread + mention badges
// in the rail, typing), profile (avatar + display name), server icon.
// Real voice channels are batch 4.

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
  const [unread, setUnread] = useState({}); // channelId -> { unread, mentions }
  const [invite] = useState(inviteFromUrl);
  const [channelId, setChannelId] = useState(channelFromUrl);
  const [settings, setSettings] = useState(null); // null | { tab, categoryId? }
  const [profile, setProfile] = useState(false);
  const currentChannel = useRef(channelId);
  currentChannel.current = channelId;

  // Restore the session on load.
  useEffect(() => {
    if (!getToken()) return setUser(null);
    api('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => { setToken(null); setUser(null); });
  }, []);

  const load = useCallback(() => api('/api/server').then(setData).catch(console.error), []);
  const loadUnread = useCallback(() => api('/api/channels/unread').then((r) => setUnread(r.channels)).catch(console.error), []);

  // Once signed in: load the server and open the socket.
  useEffect(() => {
    if (!user) return;
    const s = socket.connect(getToken());
    load();
    loadUnread();

    s.on('presence:snapshot', ({ online }) => setOnline(new Set(online)));
    s.on('presence:online', ({ user_id }) => {
      setOnline((o) => new Set(o).add(user_id));
      setData((d) => { if (d && !d.members.some((m) => m.id === user_id)) load(); return d; }); // someone new signed up
    });
    s.on('presence:offline', ({ user_id }) => setOnline((o) => { const n = new Set(o); n.delete(user_id); return n; }));
    s.on('server:changed', () => { load(); loadUnread(); });
    s.on('message:new', ({ message }) => {
      if (message.author.id === user.id || message.channel_id === currentChannel.current) return;
      setUnread((u) => {
        const cur = u[message.channel_id] || { unread: 0, mentions: 0 };
        return { ...u, [message.channel_id]: { unread: cur.unread + 1, mentions: cur.mentions + (message.mentions.includes(user.id) ? 1 : 0) } };
      });
    });
    s.on('read:updated', ({ channel_id }) => setUnread((u) => ({ ...u, [channel_id]: { unread: 0, mentions: 0 } })));
    let firstConnect = true;
    s.on('connect', () => { if (firstConnect) firstConnect = false; else loadUnread(); }); // after a reconnect, counts may have drifted
    s.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { setToken(null); setUser(null); }
    });
    return () => socket.disconnect();
  }, [user?.id, load, loadUnread]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Tab title shows the mention count.
  const mentionTotal = useMemo(() => Object.values(unread).reduce((n, u) => n + (u.mentions || 0), 0), [unread]);
  useEffect(() => {
    const name = data?.server?.name || 'Huddle';
    document.title = mentionTotal > 0 ? `(${mentionTotal}) ${name}` : name;
  }, [mentionTotal, data?.server?.name]);

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

  const onRead = useCallback((id) => setUnread((u) => (u[id]?.unread ? { ...u, [id]: { unread: 0, mentions: 0 } } : u)), []);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <Login invite={invite} onLogin={onLogin} />;
  if (window.location.pathname === '/voice-test') return (
      <Suspense fallback={<div className="center muted">Loading…</div>}>
        <VoiceTest user={user} />
      </Suspense>
    );

  const isOwner = user.role === 'owner';
  const members = data?.members || [];

  return (
    <div className="shell">
      <Rail
        data={data}
        user={user}
        unread={unread}
        channelId={channel?.id ?? null}
        onSelect={selectChannel}
        onSignOut={signOut}
        onOpenProfile={() => setProfile(true)}
        onOpenSettings={isOwner ? (tab, extra) => setSettings({ tab: tab || 'overview', ...extra }) : null}
      />

      <main className="main">
        <ChannelView channel={channel} user={user} members={members} onRead={onRead} />
      </main>

      <aside className="members">
        <div className="section-title">Members — {online.size} online</div>
        <ul>
          {members.map((m) => (
            <li key={m.id} className={online.has(m.id) ? 'online' : 'offline'}>
              <span className="avatar-wrap"><Avatar user={m} size={28} /><span className="dot" /></span>
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
      {profile && (
        <Suspense fallback={null}>
          <Profile user={user} onClose={() => setProfile(false)} onUpdated={(u) => { setUser(u); load(); }} />
        </Suspense>
      )}
    </div>
  );
}
