import { useState } from 'react';
import Avatar from './Avatar.jsx';

// Left rail: server name, channels grouped under collapsible categories,
// and the signed-in user at the bottom. Owner sees a gear and "+" buttons
// that open Settings. Collapsed state is a per-browser convenience only.

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

export default function Rail({ data, user, unread, channelId, onSelect, onSignOut, onOpenProfile, onOpenSettings }) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const { loose, groups } = groupChannels(data);

  function toggle(catId) {
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(catId) ? n.delete(catId) : n.add(catId);
      saveCollapsed(n);
      return n;
    });
  }

  const item = (c) => {
    const u = (unread && unread[c.id]) || null;
    const hasUnread = c.type === 'text' && c.id !== channelId && u?.unread > 0;
    return (
      <li
        key={c.id}
        className={`channel ${c.type}${c.id === channelId ? ' selected' : ''}${hasUnread ? ' unread' : ''}`}
        onClick={() => onSelect(c.id)}
        title={c.type === 'voice' ? 'Voice channel' : 'Text channel'}
      >
        <span className="glyph">{c.type === 'voice' ? '🔊' : '#'}</span>
        <span className="channel-name">{c.name}</span>
        {hasUnread && u.mentions > 0 && <span className="badge" title={`${u.mentions} mention${u.mentions > 1 ? 's' : ''}`}>{u.mentions > 99 ? '99+' : u.mentions}</span>}
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
              {/* When collapsed, still show the channel you're in so you don't lose your place. */}
              {!isCollapsed ? <ul>{channels.map(item)}</ul> : <ul>{channels.filter((c) => c.id === channelId).map(item)}</ul>}
            </div>
          );
        })}

        {onOpenSettings && (
          <button className="ghost rail-add" onClick={() => onOpenSettings('channels')}>+ Add channel</button>
        )}
      </div>

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
    </aside>
  );
}
