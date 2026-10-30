import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import VoicePanel from './VoicePanel.jsx';
import * as voice from './voiceStore.js';

// Left rail: server name, channels grouped under collapsible categories,
// the voice panel while you're in a call, and you at the bottom. Text
// channels select; voice channels JOIN on click (the middle pane stays on
// your text channel, like Discord). People in a voice channel stack under
// it with a speaking ring; click one for volume / local mute. Someone sharing
// their screen gets a 🖥️ (batch 5); the popover offers Watch when you're in
// the same channel.

const COLLAPSE_KEY = 'huddle_collapsed_categories';
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
}

export function groupChannels(data) {
  const channels = data?.channels || [];
  const categories = data?.categories || [];
  const byCat = new Map(categories.map((c) => [c.id, []]));
  const loose = [];
  for (const ch of channels) {
    if (ch.category_id != null && byCat.has(ch.category_id)) byCat.get(ch.category_id).push(ch);
    else loose.push(ch);
  }
  return { loose, groups: categories.map((cat) => ({ category: cat, channels: byCat.get(cat.id) })) };
}

export default function Rail({ data, user, unread, voiceState, channelId, onSelect, onSignOut, onOpenProfile, onOpenSettings }) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [person, setPerson] = useState(null); // { userId, channelId } popover
  const v = voice.useVoice();
  const { loose, groups } = groupChannels(data);
  const members = data?.members || [];
  const cap = 10;

  function toggle(catId) {
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(catId) ? n.delete(catId) : n.add(catId);
      saveCollapsed(n);
      return n;
    });
  }

  function clickChannel(c) {
    if (c.type === 'voice') {
      if (v.channelId === c.id) return;
      voice.join(c);
    } else {
      onSelect(c.id);
    }
  }

  const item = (c) => {
    const u = (unread && unread[c.id]) || null;
    const hasUnread = c.type === 'text' && c.id !== channelId && u?.unread > 0;
    const inVoice = c.type === 'voice' ? (voiceState?.[c.id] || []) : [];
    const mine = c.type === 'voice' && v.channelId === c.id;
    return (
      <li key={c.id} className={`channel-wrap${mine ? ' in-voice' : ''}`}>
        <div
          className={`channel ${c.type}${c.id === channelId ? ' selected' : ''}${hasUnread ? ' unread' : ''}${mine ? ' mine' : ''}`}
          onClick={() => clickChannel(c)}
          title={c.type === 'voice' ? (mine ? 'You are in this channel' : 'Click to join') : 'Text channel'}
        >
          <span className="glyph">{c.type === 'voice' ? '🔊' : '#'}</span>
          <span className="channel-name">{c.name}</span>
          {hasUnread && u.mentions > 0 && <span className="badge" title={`${u.mentions} mention${u.mentions > 1 ? 's' : ''}`}>{u.mentions > 99 ? '99+' : u.mentions}</span>}
          {c.type === 'voice' && inVoice.length > 0 && <span className={`voice-count${inVoice.length >= cap ? ' full' : ''}`}>{inVoice.length}/{cap}</span>}
        </div>
        {inVoice.length > 0 && (
          <ul className="voice-people">
            {inVoice.map((m) => {
              const member = members.find((x) => x.id === m.user_id) || { id: m.user_id, display_name: '…' };
              const isMe = m.user_id === user.id;
              const speaking = mine && v.speaking.includes(m.user_id);
              const localMuted = !isMe && voice.personFor(m.user_id).muted;
              return (
                <li
                  key={m.user_id}
                  className={`voice-person${speaking ? ' speaking' : ''}${isMe ? ' me' : ''}`}
                  onClick={(e) => { e.stopPropagation(); if (!isMe) setPerson({ userId: m.user_id, anchor: e.currentTarget, sharing: m.sharing, sameChannel: mine }); }}
                  title={isMe ? 'You' : m.sharing && mine ? 'Watch their screen / volume' : 'Volume / mute for me'}
                >
                  <span className="voice-ring"><Avatar user={member} size={20} /></span>
                  <span className="voice-person-name">{member.display_name}</span>
                  {m.sharing && <span className="voice-icon share" title="Sharing their screen">🖥️</span>}
                  {localMuted && <span className="voice-icon" title="Muted for you">🔇</span>}
                  {m.deafened ? <span className="voice-icon" title="Deafened">🎧</span> : m.muted ? <span className="voice-icon" title="Muted">🎤</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside className="rail">
      <div className="server-name">
        {data?.server?.icon_url && <img className="server-icon" src={data.server.icon_url} alt="" />}
        <span className="server-name-text">{data?.server?.name ?? 'Huddle'}</span>
        {onOpenSettings && (
          <button className="icon" title="Server settings" onClick={() => onOpenSettings('overview')}>⚙</button>
        )}
      </div>

      <div className="channels">
        {loose.length > 0 && <ul>{loose.map(item)}</ul>}
        {onOpenSettings && loose.length === 0 && groups.length === 0 && (
          <div className="muted small rail-hint">No channels yet.</div>
        )}

        {groups.map(({ category, channels }) => {
          const isCollapsed = collapsed.has(category.id);
          return (
            <div key={category.id} className="category">
              <div className="category-header">
                <button className="category-toggle" onClick={() => toggle(category.id)} title={isCollapsed ? 'Expand' : 'Collapse'}>
                  <span className={`caret${isCollapsed ? ' closed' : ''}`}>▾</span>
                  {category.name}
                </button>
                {onOpenSettings && (
                  <button className="icon" title={`Add channel to ${category.name}`} onClick={() => onOpenSettings('channels', { categoryId: category.id })}>+</button>
                )}
              </div>
              {/* When collapsed, still show the channel you're in (text or voice) so you don't lose your place. */}
              {!isCollapsed ? <ul>{channels.map(item)}</ul> : <ul>{channels.filter((c) => c.id === channelId || c.id === v.channelId).map(item)}</ul>}
            </div>
          );
        })}

        {onOpenSettings && (
          <button className="ghost rail-add" onClick={() => onOpenSettings('channels')}>+ Add channel</button>
        )}
        {v.error && v.phase === 'idle' && (
          <div className="error rail-voice-error">
            {v.error} <button type="button" className="link" onClick={() => voice.set({ error: null })}>✕</button>
          </div>
        )}
      </div>

      <VoicePanel channel={data?.channels.find((c) => c.id === v.channelId)} />

      <div className="me">
        <button type="button" className="me-button" onClick={onOpenProfile} title="Edit your profile">
          <Avatar user={user} size={32} />
          <div className="me-info">
            <div className="name">{user.display_name}</div>
            <div className="muted small">@{user.username}{user.role === 'owner' ? ' · owner' : ''}</div>
          </div>
        </button>
        <button className="ghost" onClick={onSignOut} title="Sign out of this device">Sign out</button>
      </div>

      {person && <PersonPopover userId={person.userId} anchor={person.anchor} members={members} sharing={person.sharing} sameChannel={person.sameChannel} onClose={() => setPerson(null)} />}
    </aside>
  );
}

// Volume + "mute for me" for one person in voice. Per-browser setting.
function PersonPopover({ userId, anchor, members, sharing, sameChannel, onClose }) {
  const v = voice.useVoice();
  const p = voice.personFor(userId);
  const ref = useRef(null);
  const member = members.find((m) => m.id === userId);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="person-popover" ref={ref} style={{ top: Math.min(rect.bottom + 4, window.innerHeight - 140), left: rect.left + 8 }}>
      <div className="row person-head">
        <Avatar user={member} size={24} />
        <strong>{member?.display_name || '…'}</strong>
      </div>
      {sharing && sameChannel && (
        v.watching === userId
          ? <button type="button" className="ghost" onClick={() => { voice.stopWatching(); onClose(); }}>Stop watching</button>
          : <button type="button" className="primary" onClick={() => { voice.watch(userId); onClose(); }}>🖥️ Watch their screen</button>
      )}
      {sharing && !sameChannel && <div className="muted small">Sharing their screen — join the channel to watch.</div>}
      <label>
        Volume — {Math.round(p.volume * 100)}%
        <input type="range" min={0} max={200} value={Math.round(p.volume * 100)} onChange={(e) => voice.updatePerson(userId, { volume: Number(e.target.value) / 100 })} disabled={p.muted} />
      </label>
      <label className="check"><input type="checkbox" checked={p.muted} onChange={(e) => voice.updatePerson(userId, { muted: e.target.checked })} /> Mute for me</label>
      {v.channelId == null && <div className="muted small">Applies when you're in a voice channel with them.</div>}
    </div>
  );
}
