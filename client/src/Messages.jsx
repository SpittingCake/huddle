import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import * as socket from './socket.js';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import { fmtDay, sameDay } from './time.js';

// A text channel: the message list (newest at the bottom, scroll up to page
// back 50 at a time), the "NEW" divider at your last read position, typing
// indicator, pins panel, and the composer. Live updates come over the shared
// socket; the server is the source of truth, so every event carries the
// full message and we just replace it.

const PAGE = 50;
const GROUP_MS = 5 * 60 * 1000;
const TYPING_TTL = 4500;
const KEEP_WHEN_FOLLOWING = 300; // trim old messages while pinned to the bottom (plan §4.4)

export default function Messages({ channel, user, members, isOwner, onRead }) {
  const me = user.id;
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastRead, setLastRead] = useState(0);       // where the NEW divider sits (fixed while the channel is open)
  const [pinCount, setPinCount] = useState(0);
  const [pins, setPins] = useState(null);            // null = panel closed
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [typing, setTyping] = useState({});          // userId -> expires
  const [newBelow, setNewBelow] = useState(0);
  const [highlight, setHighlight] = useState(null);
  const [error, setError] = useState(null);

  const list = useRef(null);
  const atBottom = useRef(true);
  const prepend = useRef(null);                       // { height, top } captured before paging up
  const sentRead = useRef(0);
  const readTimer = useRef(null);

  // ── load ──

  useEffect(() => {
    let cancelled = false;
    setMessages([]); setHasMore(false); setLoading(true); setReplyTo(null); setEditing(null);
    setPins(null); setNewBelow(0); setTyping({}); setError(null); setHighlight(null);
    atBottom.current = true;
    sentRead.current = 0;
    api(`/api/channels/${channel.id}/messages?limit=${PAGE}`)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setHasMore(r.has_more);
        setLastRead(r.last_read_message_id);
        setPinCount(r.pin_count);
        sentRead.current = r.last_read_message_id;
        setLoading(false);
        requestAnimationFrame(scrollToBottom);
      })
      .catch((err) => { if (!cancelled) { setError('Could not load messages.'); setLoading(false); console.error(err); } });
    return () => { cancelled = true; };
  }, [channel.id]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !messages.length) return;
    setLoading(true);
    const el = list.current;
    prepend.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      const r = await api(`/api/channels/${channel.id}/messages?limit=${PAGE}&before=${messages[0].id}`);
      setMessages((cur) => [...r.messages, ...cur]);
      setHasMore(r.has_more);
    } catch (err) {
      prepend.current = null;
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [channel.id, loading, hasMore, messages]);

  // Keep the viewport still after prepending a page.
  useLayoutEffect(() => {
    if (!prepend.current || !list.current) return;
    const el = list.current;
    el.scrollTop = prepend.current.top + (el.scrollHeight - prepend.current.height);
    prepend.current = null;
  }, [messages]);

  function scrollToBottom() {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewBelow(0);
  }

  function onScroll() {
    const el = list.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      if (bottom) { setNewBelow(0); scheduleRead(); }
    }
    if (el.scrollTop < 240 && hasMore && !loading) loadMore();
  }

  // ── read markers ──

  const scheduleRead = useCallback(() => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      const last = messages[messages.length - 1];
      if (!last || !atBottom.current || document.visibilityState !== 'visible') return;
      if (last.id <= sentRead.current) return;
      sentRead.current = last.id;
      api(`/api/channels/${channel.id}/read`, { method: 'POST', body: { last_read_message_id: last.id } }).catch(() => {});
      onRead?.(channel.id);
    }, 400);
  }, [messages, channel.id, onRead]);

  useEffect(() => { scheduleRead(); return () => clearTimeout(readTimer.current); }, [scheduleRead]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') scheduleRead(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, [scheduleRead]);

  // ── live events ──

  useEffect(() => {
    const s = socket.get();
    if (!s) return;
    const mine = (p) => p.channel_id === channel.id;

    const onNew = ({ message }) => {
      if (!mine(message)) return;
      setMessages((cur) => {
        const next = [...cur, message];
        // When following the bottom, keep memory bounded.
        if (atBottom.current && next.length > KEEP_WHEN_FOLLOWING) { setHasMore(true); return next.slice(-KEEP_WHEN_FOLLOWING); }
        return next;
      });
      setTyping((t) => { if (!t[message.author.id]) return t; const n = { ...t }; delete n[message.author.id]; return n; });
      if (message.author.id === me || atBottom.current) requestAnimationFrame(scrollToBottom);
      else setNewBelow((n) => n + 1);
    };
    const onUpdated = ({ message }) => { if (mine(message)) setMessages((cur) => cur.map((m) => (m.id === message.id ? message : m))); };
    const onDeleted = ({ channel_id, id }) => {
      if (channel_id !== channel.id) return;
      setMessages((cur) => cur
        .filter((m) => m.id !== id)
        .map((m) => (m.reply_to?.id === id ? { ...m, reply_to: { ...m.reply_to, deleted: true, author: null, excerpt: '' } } : m)));
      setReplyTo((r) => (r?.id === id ? null : r));
      setEditing((e) => (e?.id === id ? null : e));
      setPins((p) => (p ? p.filter((m) => m.id !== id) : p));
    };
    const onReactions = ({ channel_id, message_id, reactions }) => {
      if (channel_id !== channel.id) return;
      setMessages((cur) => cur.map((m) => (m.id === message_id ? { ...m, reactions } : m)));
    };
    const onPins = ({ channel_id, message_id, pinned, count }) => {
      if (channel_id !== channel.id) return;
      setPinCount(count);
      setMessages((cur) => cur.map((m) => (m.id === message_id ? { ...m, pinned } : m)));
      setPins((p) => (p ? (pinned ? null : p.filter((m) => m.id !== message_id)) : p)); // re-fetch on next open if something was pinned
    };
    const onTyping = ({ channel_id, user_id }) => {
      if (channel_id !== channel.id || user_id === me) return;
      setTyping((t) => ({ ...t, [user_id]: Date.now() + TYPING_TTL }));
    };

    s.on('message:new', onNew);
    s.on('message:updated', onUpdated);
    s.on('message:deleted', onDeleted);
    s.on('reactions:changed', onReactions);
    s.on('pins:changed', onPins);
    s.on('typing', onTyping);
    return () => {
      s.off('message:new', onNew); s.off('message:updated', onUpdated); s.off('message:deleted', onDeleted);
      s.off('reactions:changed', onReactions); s.off('pins:changed', onPins); s.off('typing', onTyping);
    };
  }, [channel.id, me]);

  // Expire typing entries.
  useEffect(() => {
    const ids = Object.keys(typing);
    if (!ids.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, exp]) => exp > now));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typing]);

  // ── actions ──

  const actions = useMemo(() => ({
    onReply: (m) => { setEditing(null); setReplyTo(m); },
    onEdit: (m) => { setReplyTo(null); setEditing(m); },
    onDelete: async (m) => {
      if (!window.confirm('Delete this message?')) return;
      try { await api(`/api/channels/${channel.id}/messages/${m.id}`, { method: 'DELETE' }); } catch (err) { setError('Could not delete that.'); }
    },
    onReact: async (m, emoji, add) => {
      try { await api(`/api/channels/${channel.id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, { method: add ? 'PUT' : 'DELETE' }); } catch {}
    },
    onPin: async (m, pin) => {
      try { await api(`/api/channels/${channel.id}/pins/${m.id}`, { method: pin ? 'PUT' : 'DELETE' }); } catch {}
    },
    onJump: (id) => {
      const el = document.getElementById(`msg-${id}`);
      if (!el) return; // not loaded; paging back to find it is a batch-8 nicety
      el.scrollIntoView({ block: 'center' });
      setHighlight(id);
      setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1800);
    },
  }), [channel.id]);

  function editLast() {
    const last = [...messages].reverse().find((m) => m.author.id === me);
    if (last) actions.onEdit(last);
  }

  async function togglePins() {
    if (pins) return setPins(null);
    try { setPins((await api(`/api/channels/${channel.id}/pins`)).messages); } catch { setError('Could not load pins.'); }
  }

  // ── render ──

  const rows = [];
  let prev = null;
  let dividerShown = false;
  for (const m of messages) {
    if (!prev || !sameDay(prev.created_at, m.created_at)) rows.push(<div key={`d${m.id}`} className="divider day"><span>{fmtDay(m.created_at)}</span></div>);
    if (!dividerShown && lastRead > 0 && m.id > lastRead && m.author.id !== me) {
      rows.push(<div key={`n${m.id}`} className="divider new"><span>NEW</span></div>);
      dividerShown = true;
    }
    const compact = Boolean(
      prev && prev.author.id === m.author.id && !m.reply_to &&
      sameDay(prev.created_at, m.created_at) &&
      new Date(m.created_at) - new Date(prev.created_at) < GROUP_MS
    );
    rows.push(<Message key={m.id} message={m} compact={compact} me={me} isOwner={isOwner} members={members} actions={actions} highlight={highlight === m.id} />);
    prev = m;
  }

  const typers = Object.keys(typing).map((id) => members.find((u) => u.id === Number(id))?.display_name).filter(Boolean);

  return (
    <div className="messages">
      <header className="channel-header">
        <span className="glyph">#</span>
        <h2>{channel.name}</h2>
        <span className="spacer" />
        <button type="button" className={`ghost pins-btn${pins ? ' active' : ''}`} onClick={togglePins} title="Pinned messages">
          📌 {pinCount}
        </button>
      </header>

      {pins && (
        <div className="pins-panel">
          <div className="pins-head"><strong>Pinned messages</strong><button type="button" className="icon" onClick={() => setPins(null)} title="Close">✕</button></div>
          {pins.length === 0 ? <div className="muted pins-empty">Nothing pinned yet. Hover a message and hit 📌.</div> : (
            <div className="pins-list">
              {pins.map((m) => <Message key={m.id} message={m} me={me} isOwner={isOwner} members={members} readOnly actions={{ onPin: actions.onPin, onJump: (id) => { setPins(null); actions.onJump(id); } }} />)}
            </div>
          )}
        </div>
      )}

      <div className="message-list" ref={list} onScroll={onScroll}>
        {hasMore && <div className="muted small center-text load-more">{loading ? 'Loading…' : <button type="button" className="link" onClick={loadMore}>Load earlier messages</button>}</div>}
        {!hasMore && !loading && (
          <div className="channel-start">
            <div className="channel-start-glyph">#</div>
            <h3>Welcome to #{channel.name}</h3>
            <p className="muted">This is the start of the channel.</p>
          </div>
        )}
        {rows}
        {error && <div className="error center-text">{error}</div>}
      </div>

      {newBelow > 0 && (
        <button type="button" className="new-below" onClick={scrollToBottom}>
          {newBelow} new message{newBelow > 1 ? 's' : ''} ↓
        </button>
      )}

      <div className="typing-line muted small">
        {typers.length > 0 && (
          <>
            <span className="typing-dots"><i /><i /><i /></span>
            {typers.length === 1 ? <><strong>{typers[0]}</strong> is typing…</>
              : typers.length === 2 ? <><strong>{typers[0]}</strong> and <strong>{typers[1]}</strong> are typing…</>
              : 'Several people are typing…'}
          </>
        )}
      </div>

      <Composer
        channel={channel}
        me={me}
        members={members}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onEditLast={editLast}
        onSent={scrollToBottom}
      />
    </div>
  );
}
