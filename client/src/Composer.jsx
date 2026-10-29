import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api.js';
import * as socket from './socket.js';
import Avatar from './Avatar.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { fmtSize } from './time.js';

// The message box. Enter sends, Shift+Enter is a newline. Files come in by
// the 📎 button, paste, or drag-and-drop and upload right away so Send is
// instant. Up-arrow on an empty box edits your last message. "@" opens a
// member picker. Typing pings go out at most every 3 s.

const MAX_FILES = 5;
const ERRORS = {
  file_too_large: 'That file is over the size limit (25 MB).',
  too_many_files: `Up to ${MAX_FILES} files per message.`,
  blocked_type: "That file type isn't allowed.",
  body_too_long: 'Messages are limited to 2000 characters.',
  bad_reply: 'The message you were replying to is gone.',
  not_found: 'That message is gone.',
};
const msgFor = (err) => ERRORS[err?.message] || 'Something went wrong. Try again.';

export default function Composer({ channel, me, members, replyTo, onCancelReply, editing, onCancelEdit, onEditLast, onSent }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]); // { key, name, size, image, previewUrl, id?, error? }
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [picker, setPicker] = useState(false);
  const [mention, setMention] = useState(null); // { start, query, index }
  const [dragging, setDragging] = useState(false);
  const box = useRef(null);
  const fileInput = useRef(null);
  const lastTyping = useRef(0);

  // Switching into edit mode loads the old text; leaving it clears.
  useEffect(() => {
    if (editing) { setText(editing.body); setFiles([]); setError(null); }
    else setText('');
    setTimeout(() => box.current?.focus(), 0);
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (replyTo) box.current?.focus(); }, [replyTo?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setText(''); setFiles([]); setError(null); setMention(null); box.current?.focus(); }, [channel.id]);

  // Auto-grow up to ~8 lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  function onChange(e) {
    const v = e.target.value;
    setText(v);
    setError(null);
    if (!editing && v.trim() && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      socket.emit('typing', { channel_id: channel.id });
    }
    updateMention(v, e.target.selectionStart);
  }

  function updateMention(v, caret) {
    const before = v.slice(0, caret);
    const m = /(^|[^a-z0-9_.-])@([a-z0-9_.-]*)$/i.exec(before);
    if (!m) return setMention(null);
    setMention({ start: caret - m[2].length - 1, query: m[2].toLowerCase(), index: 0 });
  }

  const candidates = mention
    ? [
        ...members.filter((u) => u.username.toLowerCase().startsWith(mention.query) || u.display_name.toLowerCase().startsWith(mention.query)),
        ...('everyone'.startsWith(mention.query) ? [{ id: 'everyone', username: 'everyone', display_name: 'everyone' }] : []),
      ].slice(0, 8)
    : [];

  function insertMention(u) {
    const after = text.slice(box.current.selectionStart);
    const next = text.slice(0, mention.start) + '@' + u.username + ' ' + after;
    setText(next);
    setMention(null);
    const pos = mention.start + u.username.length + 2;
    setTimeout(() => { box.current?.focus(); box.current?.setSelectionRange(pos, pos); }, 0);
  }

  function onKeyDown(e) {
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return setMention({ ...mention, index: (mention.index + 1) % candidates.length }); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setMention({ ...mention, index: (mention.index - 1 + candidates.length) % candidates.length }); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return insertMention(candidates[mention.index]); }
      if (e.key === 'Escape') { e.preventDefault(); return setMention(null); }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return send(); }
    if (e.key === 'Escape') {
      if (editing) return onCancelEdit();
      if (replyTo) return onCancelReply();
    }
    if (e.key === 'ArrowUp' && !editing && text === '' && files.length === 0) { e.preventDefault(); return onEditLast(); }
  }

  // ── files ──

  function addFiles(list) {
    const incoming = [...list].filter(Boolean);
    if (!incoming.length) return;
    if (files.length + incoming.length > MAX_FILES) return setError(ERRORS.too_many_files);
    const entries = incoming.map((f) => ({
      key: Math.random().toString(36).slice(2),
      name: f.name || 'pasted image',
      size: f.size,
      image: /^image\//.test(f.type),
      previewUrl: /^image\//.test(f.type) ? URL.createObjectURL(f) : null,
      id: null,
      error: null,
    }));
    setFiles((cur) => [...cur, ...entries]);
    upload(incoming, entries);
  }

  async function upload(blobs, entries) {
    const form = new FormData();
    blobs.forEach((b, i) => form.append('files', b, entries[i].name));
    try {
      const res = await fetch('/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(json.error || 'upload_failed'), { body: json });
      setFiles((cur) => cur.map((f) => {
        const i = entries.findIndex((e) => e.key === f.key);
        return i === -1 ? f : { ...f, id: json.attachments[i].id };
      }));
    } catch (err) {
      setError(msgFor(err));
      setFiles((cur) => cur.filter((f) => !entries.some((e) => e.key === f.key)));
    }
  }

  function removeFile(key) {
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key);
      if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
      return cur.filter((x) => x.key !== key);
    });
  }

  // Paste anywhere in the window (not just with the box focused), like
  // Discord. Handles a screenshot in the clipboard (items) and a file copied
  // from Finder/Explorer (files).
  useEffect(() => {
    if (editing) return;
    const onPaste = (e) => {
      if (document.querySelector('.modal-backdrop')) return; // settings/profile open
      const fromItems = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
      const fromFiles = [...(e.clipboardData?.files || [])];
      const picked = fromItems.length ? fromItems : fromFiles;
      if (!picked.length) return;
      e.preventDefault();
      addFiles(picked.map((f) => (f.name ? f : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
      box.current?.focus();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }); // no deps on purpose: addFiles closes over the latest `files`
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer?.files || []);
  }

  // ── send ──

  const uploading = files.some((f) => !f.id);
  const canSend = !sending && !uploading && (text.trim().length > 0 || files.length > 0);

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/channels/${channel.id}/messages/${editing.id}`, { method: 'PATCH', body: { body: text } });
        onCancelEdit();
      } else {
        await api(`/api/channels/${channel.id}/messages`, {
          method: 'POST',
          body: { body: text, reply_to_id: replyTo?.id ?? null, attachment_ids: files.map((f) => f.id) },
        });
        files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
        setText('');
        setFiles([]);
        if (replyTo) onCancelReply();
        onSent?.();
      }
      setMention(null);
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSending(false);
      box.current?.focus();
    }
  }

  function insertEmoji(e) {
    const el = box.current;
    const start = el?.selectionStart ?? text.length;
    const next = text.slice(0, start) + e + text.slice(start);
    setText(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(start + e.length, start + e.length); }, 0);
  }

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {editing && (
        <div className="composer-bar">
          <span>Editing your message — <kbd>Esc</kbd> to cancel, <kbd>Enter</kbd> to save</span>
          <button type="button" className="icon" onClick={onCancelEdit} title="Cancel">✕</button>
        </div>
      )}
      {replyTo && !editing && (
        <div className="composer-bar">
          <span>Replying to <strong>{replyTo.author.display_name}</strong></span>
          <button type="button" className="icon" onClick={onCancelReply} title="Cancel reply">✕</button>
        </div>
      )}

      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <div key={f.key} className={`composer-file${f.id ? '' : ' uploading'}`} title={`${f.name} · ${fmtSize(f.size)}`}>
              {f.previewUrl ? <img src={f.previewUrl} alt="" /> : <span className="file-glyph big">📎</span>}
              <span className="file-name">{f.name}</span>
              <button type="button" className="icon" onClick={() => removeFile(f.key)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-row">
        {!editing && (
          <>
            <button type="button" className="icon" title="Attach a file" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_FILES}>📎</button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </>
        )}
        <div className="composer-input">
          <textarea
            ref={box}
            rows={1}
            value={text}
            placeholder={editing ? '' : `Message #${channel.name}`}
            maxLength={2000}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={(e) => updateMention(text, e.target.selectionStart)}
            onBlur={() => setTimeout(() => setMention(null), 150)}
          />
          {mention && candidates.length > 0 && (
            <ul className="mention-list" role="listbox">
              {candidates.map((u, i) => (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={i === mention.index}
                  className={i === mention.index ? 'active' : ''}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
                  onMouseEnter={() => setMention({ ...mention, index: i })}
                >
                  {u.id === 'everyone' ? <span className="mention-everyone">@everyone</span> : <Avatar user={u} size={20} />}
                  {u.id !== 'everyone' && <span>{u.display_name} <span className="muted small">@{u.username}</span></span>}
                  {u.id === 'everyone' && <span className="muted small">notify everyone</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="composer-emoji">
          <button type="button" className="icon" title="Emoji" onClick={() => setPicker((p) => !p)}>☺</button>
          {picker && <EmojiPicker onPick={insertEmoji} onClose={() => setPicker(false)} align="right-up" />}
        </div>
        <button type="button" className="primary send" onClick={send} disabled={!canSend} title="Send (Enter)">
          {editing ? 'Save' : 'Send'}
        </button>
      </div>
      {error && <div className="error composer-error">{error}</div>}
      {dragging && <div className="drop-hint">Drop to attach</div>}
    </div>
  );
}
