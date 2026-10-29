import { useEffect, useState } from 'react';
import { api } from './api.js';
import { groupChannels } from './Rail.jsx';

// Owner-only settings modal: Overview (server name), Channels (CRUD +
// categories + reorder), Invites (create / copy / revoke).
// Every write goes to the server, which broadcasts server:changed; App
// reloads and the new props flow back in here. `reload` is a belt-and-braces
// refresh in case the socket is briefly down.

const ERRORS = {
  bad_name: 'Names are 1–32 characters.',
  bad_category: 'That category no longer exists.',
  last_text_channel: 'You need at least one text channel.',
  not_found: 'That no longer exists — it may have just been deleted.',
};
const msg = (err) => ERRORS[err?.message] || 'Something went wrong. Try again.';

export default function Settings({ data, initial, onClose, reload }) {
  const [tab, setTab] = useState(initial.tab || 'overview');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Server settings">
        <nav className="modal-tabs">
          {['overview', 'channels', 'invites'].map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
          <span className="spacer" />
          <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
        </nav>
        <div className="modal-body">
          {tab === 'overview' && <Overview data={data} reload={reload} />}
          {tab === 'channels' && <Channels data={data} reload={reload} initialCategory={initial.categoryId ?? ''} />}
          {tab === 'invites' && <Invites />}
        </div>
      </div>
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

function Overview({ data, reload }) {
  const [name, setName] = useState(data.server?.name || '');
  const [state, setState] = useState(null); // null | 'saving' | 'saved' | error string

  useEffect(() => setName(data.server?.name || ''), [data.server?.name]);

  async function save(e) {
    e.preventDefault();
    setState('saving');
    try {
      await api('/api/server', { method: 'PATCH', body: { name } });
      setState('saved');
      reload();
      setTimeout(() => setState(null), 1500);
    } catch (err) {
      setState(msg(err));
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <h3>Server</h3>
      <label>
        Server name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={state === 'saving' || name.trim() === data.server?.name}>Save</button>
        {state === 'saved' && <span className="ok small">Saved</span>}
        {state && state !== 'saving' && state !== 'saved' && <span className="error">{state}</span>}
      </div>
      <p className="muted small">Server icon and avatars arrive with uploads in batch 3.</p>
    </form>
  );
}

// ── Channels ───────────────────────────────────────────────────────────────

function Channels({ data, reload, initialCategory }) {
  const [error, setError] = useState(null);
  const { loose, groups } = groupChannels(data);

  async function run(fn) {
    setError(null);
    try { await fn(); reload(); } catch (err) { setError(msg(err)); }
  }

  const moveChannel = (siblings, idx, dir) => run(() => {
    const ids = siblings.map((c) => c.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return Promise.resolve();
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    return api('/api/server/channels/order', { method: 'PUT', body: { ids } });
  });
  const moveCategory = (idx, dir) => run(() => {
    const ids = data.categories.map((c) => c.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return Promise.resolve();
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    return api('/api/server/categories/order', { method: 'PUT', body: { ids } });
  });
  const renameChannel = (ch, name) => run(() => api(`/api/server/channels/${ch.id}`, { method: 'PATCH', body: { name } }));
  const recategorize = (ch, category_id) => run(() => api(`/api/server/channels/${ch.id}`, { method: 'PATCH', body: { category_id: category_id === '' ? null : Number(category_id) } }));
  const deleteChannel = (ch) => {
    if (!window.confirm(`Delete ${ch.type === 'text' ? '#' : ''}${ch.name}? This can't be undone.`)) return;
    run(() => api(`/api/server/channels/${ch.id}`, { method: 'DELETE' }));
  };
  const renameCategory = (cat, name) => run(() => api(`/api/server/categories/${cat.id}`, { method: 'PATCH', body: { name } }));
  const deleteCategory = (cat) => {
    if (!window.confirm(`Delete the "${cat.name}" category? Its channels stay and move to the top.`)) return;
    run(() => api(`/api/server/categories/${cat.id}`, { method: 'DELETE' }));
  };

  const channelRow = (siblings) => (ch, idx) => (
    <li key={ch.id} className="settings-row">
      <span className="glyph">{ch.type === 'voice' ? '🔊' : '#'}</span>
      <InlineName value={ch.name} onSave={(v) => renameChannel(ch, v)} />
      <select value={ch.category_id ?? ''} onChange={(e) => recategorize(ch, e.target.value)} title="Category">
        <option value="">No category</option>
        {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="icon" title="Move up" disabled={idx === 0} onClick={() => moveChannel(siblings, idx, -1)}>↑</button>
      <button className="icon" title="Move down" disabled={idx === siblings.length - 1} onClick={() => moveChannel(siblings, idx, 1)}>↓</button>
      <button className="icon danger-text" title="Delete channel" onClick={() => deleteChannel(ch)}>🗑</button>
    </li>
  );

  return (
    <div className="settings-section">
      <h3>Channels</h3>
      {error && <div className="error">{error}</div>}

      {loose.length > 0 && <ul className="settings-list">{loose.map(channelRow(loose))}</ul>}

      {groups.map(({ category, channels }, idx) => (
        <div key={category.id} className="settings-group">
          <div className="settings-row category-row">
            <InlineName value={category.name} onSave={(v) => renameCategory(category, v)} strong />
            <button className="icon" title="Move category up" disabled={idx === 0} onClick={() => moveCategory(idx, -1)}>↑</button>
            <button className="icon" title="Move category down" disabled={idx === groups.length - 1} onClick={() => moveCategory(idx, 1)}>↓</button>
            <button className="icon danger-text" title="Delete category (keeps its channels)" onClick={() => deleteCategory(category)}>🗑</button>
          </div>
          {channels.length === 0 ? <div className="muted small indent">Empty</div> : <ul className="settings-list indent">{channels.map(channelRow(channels))}</ul>}
        </div>
      ))}

      <NewChannel categories={data.categories} initialCategory={initialCategory} run={run} />
      <NewCategory run={run} />
    </div>
  );
}

function InlineName({ value, onSave, strong }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (!editing) {
    return (
      <button className={`inline-name${strong ? ' strong' : ''}`} onClick={() => setEditing(true)} title="Rename">
        {value} <span className="muted small">✎</span>
      </button>
    );
  }
  const commit = () => { setEditing(false); if (draft.trim() && draft.trim() !== value) onSave(draft.trim()); else setDraft(value); };
  return (
    <input
      className="inline-input"
      autoFocus
      value={draft}
      maxLength={32}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
    />
  );
}

function NewChannel({ categories, initialCategory, run }) {
  const [type, setType] = useState('text');
  const [name, setName] = useState('');
  const [category, setCategory] = useState(String(initialCategory ?? ''));

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await run(() => api('/api/server/channels', { method: 'POST', body: { type, name, category_id: category === '' ? null : Number(category) } }));
    setName('');
  }

  return (
    <form className="settings-form new-form" onSubmit={submit}>
      <h4>New channel</h4>
      <div className="row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="text"># Text</option>
          <option value="voice">🔊 Voice</option>
        </select>
        <input placeholder={type === 'text' ? 'channel-name' : 'Channel name'} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">No category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="submit" className="primary">Add</button>
      </div>
      {type === 'text' && <p className="muted small">Text channel names become lowercase-with-dashes.</p>}
    </form>
  );
}

function NewCategory({ run }) {
  const [name, setName] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await run(() => api('/api/server/categories', { method: 'POST', body: { name } }));
    setName('');
  }
  return (
    <form className="settings-form new-form" onSubmit={submit}>
      <h4>New category</h4>
      <div className="row">
        <input placeholder="Category name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
        <button type="submit" className="primary">Add</button>
      </div>
    </form>
  );
}

// ── Invites ────────────────────────────────────────────────────────────────

const EXPIRY = [
  ['', 'Never expires'],
  ['1', '1 hour'],
  ['24', '24 hours'],
  ['168', '7 days'],
];
const USES = [
  ['', 'Unlimited uses'],
  ['1', '1 use'],
  ['5', '5 uses'],
  ['10', '10 uses'],
];

function Invites() {
  const [invites, setInvites] = useState(null);
  const [expires, setExpires] = useState('');
  const [maxUses, setMaxUses] = useState('5');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = () => api('/api/server/invites').then((r) => setInvites(r.invites)).catch((err) => setError(msg(err)));
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api('/api/server/invites', {
        method: 'POST',
        body: { expires_in_hours: expires ? Number(expires) : undefined, max_uses: maxUses ? Number(maxUses) : undefined },
      });
      await load();
      copy(r.invite);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function copy(inv) {
    try { await navigator.clipboard.writeText(inv.url); setCopied(inv.code); setTimeout(() => setCopied(null), 1500); } catch { window.prompt('Copy this link:', inv.url); }
  }

  async function revoke(inv) {
    if (!window.confirm('Revoke this invite link? Anyone who already joined keeps their account.')) return;
    try { await api(`/api/server/invites/${inv.code}`, { method: 'DELETE' }); await load(); } catch (err) { setError(msg(err)); }
  }

  const status = (inv) => {
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired';
    if (inv.max_uses != null && inv.uses >= inv.max_uses) return 'used up';
    return 'active';
  };

  return (
    <div className="settings-section">
      <h3>Invites</h3>
      <p className="muted small">Invite links are the only way in. Send one to a friend; they pick a username and password and land in the server.</p>
      {error && <div className="error">{error}</div>}

      <form className="settings-form new-form" onSubmit={create}>
        <div className="row">
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>{EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>{USES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button type="submit" className="primary">Create &amp; copy link</button>
        </div>
      </form>

      {invites === null ? <div className="muted">Loading…</div> : invites.length === 0 ? <div className="muted">No invites yet.</div> : (
        <ul className="settings-list">
          {invites.map((inv) => {
            const s = status(inv);
            return (
              <li key={inv.code} className={`settings-row invite-row ${s === 'active' ? '' : 'dim'}`}>
                <code className="invite-url">{inv.url}</code>
                <span className="muted small invite-meta">
                  {inv.uses}{inv.max_uses != null ? `/${inv.max_uses}` : ''} used
                  {inv.expires_at ? ` · ${s === 'expired' ? 'expired' : 'expires'} ${new Date(inv.expires_at).toLocaleString()}` : ' · never expires'}
                  {s === 'used up' ? ' · used up' : ''}
                </span>
                <button className="ghost" onClick={() => copy(inv)} disabled={s !== 'active'}>{copied === inv.code ? 'Copied' : 'Copy'}</button>
                <button className="ghost danger-text" onClick={() => revoke(inv)}>Revoke</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
