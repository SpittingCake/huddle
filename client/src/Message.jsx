import { memo, useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { render, mentionsMe } from './markdown.jsx';
import { fmtTime, fmtFull, fmtSize } from './time.js';

// One message row. `compact` = same author as the previous message within a
// few minutes, so the avatar/name header is hidden (Discord-style grouping).
// Actions appear on hover; the owner can delete anything, authors can edit.

function Message({ message: m, compact, me, isOwner, members, actions, readOnly, highlight }) {
  const [picker, setPicker] = useState(false);
  const author = members.find((u) => u.id === m.author.id) || m.author;
  const mine = m.author.id === me;
  const mentioned = mentionsMe(m, me);
  const memberName = (id) => members.find((u) => u.id === id)?.display_name || 'someone';

  return (
    <div
      id={`msg-${m.id}`}
      className={`msg${compact ? ' compact' : ''}${mentioned ? ' mentioned' : ''}${highlight ? ' highlight' : ''}${m.pinned ? ' is-pinned' : ''}`}
    >
      {m.reply_to && (
        <div className="reply-ref" onClick={() => actions?.onJump?.(m.reply_to.id)} title={m.reply_to.deleted ? '' : 'Jump to the original'}>
          <span className="reply-curve" />
          {m.reply_to.deleted ? (
            <span className="muted"><em>Original message was deleted</em></span>
          ) : (
            <>
              <Avatar user={members.find((u) => u.id === m.reply_to.author.id) || m.reply_to.author} size={16} />
              <span className="reply-author">{m.reply_to.author.display_name}</span>
              <span className="reply-excerpt">{m.reply_to.excerpt || (m.reply_to.files ? '📎 attachment' : '')}</span>
            </>
          )}
        </div>
      )}

      <div className="msg-row">
        {compact ? (
          <span className="msg-gutter-time muted">{fmtTime(m.created_at)}</span>
        ) : (
          <Avatar user={author} size={38} className="msg-avatar" />
        )}

        <div className="msg-main">
          {!compact && (
            <div className="msg-head">
              <span className="msg-author">{author.display_name}</span>
              <span className="msg-time muted" title={fmtFull(m.created_at)}>{fmtTime(m.created_at)}</span>
              {m.pinned && <span className="msg-flag" title="Pinned">📌</span>}
            </div>
          )}
          {m.body && (
            <div className="msg-body">
              {render(m.body, { members, me })}
              {m.edited_at && <span className="edited muted" title={`Edited ${fmtFull(m.edited_at)}`}> (edited)</span>}
            </div>
          )}
          {m.attachments.length > 0 && (
            <div className="attachments">
              {m.attachments.map((a) => (a.image ? <ImageAttachment key={a.id} a={a} /> : <FileAttachment key={a.id} a={a} />))}
            </div>
          )}
          {m.reactions.length > 0 && (
            <div className="reactions">
              {m.reactions.map((r) => {
                const meToo = r.user_ids.includes(me);
                return (
                  <button
                    key={r.emoji}
                    type="button"
                    className={`reaction${meToo ? ' mine' : ''}`}
                    disabled={readOnly}
                    onClick={() => actions?.onReact(m, r.emoji, !meToo)}
                    title={r.user_ids.map(memberName).join(', ')}
                  >
                    <span className="reaction-emoji">{r.emoji}</span>
                    <span className="reaction-count">{r.user_ids.length}</span>
                  </button>
                );
              })}
              {!readOnly && <button type="button" className="reaction add" onClick={() => setPicker(true)} title="Add reaction">+</button>}
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="msg-actions">
            <button type="button" className="icon" title="Add reaction" onClick={() => setPicker(true)}>☺</button>
            <button type="button" className="icon" title="Reply" onClick={() => actions.onReply(m)}>↩</button>
            <button type="button" className="icon" title={m.pinned ? 'Unpin' : 'Pin'} onClick={() => actions.onPin(m, !m.pinned)}>📌</button>
            {mine && <button type="button" className="icon" title="Edit" onClick={() => actions.onEdit(m)}>✎</button>}
            {(mine || isOwner) && <button type="button" className="icon danger-text" title="Delete" onClick={() => actions.onDelete(m)}>🗑</button>}
          </div>
        )}
        {readOnly && actions?.onPin && (
          <div className="msg-actions static">
            <button type="button" className="ghost" onClick={() => actions.onPin(m, false)}>Unpin</button>
          </div>
        )}
        {picker && <EmojiPicker onPick={(e) => actions.onReact(m, e, true)} onClose={() => setPicker(false)} />}
      </div>
    </div>
  );
}

export default memo(Message);

// Images are lazy, capped in size, and open full-size in a new tab. GIFs
// show a frozen first frame until you hover — plan §4.4.
function ImageAttachment({ a }) {
  const isGif = a.mime === 'image/gif';
  return (
    <a className="attachment-image" href={a.url} target="_blank" rel="noopener noreferrer" title={`${a.filename} · ${fmtSize(a.size)}`}>
      {isGif ? <GifStill src={a.url} alt={a.filename} /> : <img src={a.url} alt={a.filename} loading="lazy" decoding="async" />}
    </a>
  );
}

function GifStill({ src, alt }) {
  const canvas = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [dims, setDims] = useState(null);

  useEffect(() => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const c = canvas.current;
      if (!c) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = src;
    return () => { img.onload = null; };
  }, [src]);

  return (
    <span className="gif" onMouseEnter={() => setPlaying(true)} onMouseLeave={() => setPlaying(false)}>
      {playing
        ? <img src={src} alt={alt} style={dims ? { width: dims.w, aspectRatio: `${dims.w} / ${dims.h}` } : undefined} />
        : <canvas ref={canvas} aria-label={alt} style={dims ? { width: dims.w, aspectRatio: `${dims.w} / ${dims.h}` } : { width: 48, height: 48 }} />}
      {!playing && dims && <span className="gif-tag">GIF</span>}
    </span>
  );
}

function FileAttachment({ a }) {
  return (
    <a className="attachment-file" href={a.url} download={a.filename} title="Download">
      <span className="file-glyph">📎</span>
      <span className="file-name">{a.filename}</span>
      <span className="muted small">{fmtSize(a.size)}</span>
    </a>
  );
}
