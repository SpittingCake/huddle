import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api.js';
import Avatar from './Avatar.jsx';

// Your own profile: display name + avatar. Opens from the bottom-left box.

const ERRORS = {
  bad_name: 'Display names are 1–32 characters.',
  not_image: 'Avatars must be a PNG, JPEG, GIF or WebP.',
  file_too_large: 'That image is too big (8 MB max).',
};
const msg = (err) => ERRORS[err?.message] || 'Something went wrong. Try again.';

export default function Profile({ user, onClose, onUpdated }) {
  const [name, setName] = useState(user.display_name);
  const [state, setState] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function saveName(e) {
    e.preventDefault();
    setState('saving');
    try {
      const r = await api('/api/me', { method: 'PATCH', body: { display_name: name } });
      onUpdated(r.user);
      setState('saved');
      setTimeout(() => setState(null), 1500);
    } catch (err) { setState(msg(err)); }
  }

  async function uploadAvatar(file) {
    if (!file) return;
    setState('saving');
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await fetch('/api/me/avatar', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'upload_failed');
      onUpdated({ ...user, avatar_url: json.avatar_url });
      setState(null);
    } catch (err) { setState(msg(err)); }
  }

  async function removeAvatar() {
    try { await api('/api/me/avatar', { method: 'DELETE' }); onUpdated({ ...user, avatar_url: null }); } catch (err) { setState(msg(err)); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-label="Your profile">
        <nav className="modal-tabs">
          <button className="active" type="button">Profile</button>
          <span className="spacer" />
          <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
        </nav>
        <div className="modal-body">
          <div className="profile-avatar-row">
            <Avatar user={user} size={72} />
            <div className="row">
              <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>Change picture</button>
              {user.avatar_url && <button type="button" className="ghost danger-text" onClick={removeAvatar}>Remove</button>}
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { uploadAvatar(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>
          <form className="settings-form" onSubmit={saveName}>
            <label>
              Display name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
            </label>
            <label>
              Username
              <input value={`@${user.username}`} disabled />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={state === 'saving' || name.trim() === user.display_name}>Save</button>
              {state === 'saved' && <span className="ok small">Saved</span>}
              {state && state !== 'saving' && state !== 'saved' && <span className="error">{state}</span>}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
