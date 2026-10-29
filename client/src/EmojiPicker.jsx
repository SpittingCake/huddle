import { useEffect, useRef, useState } from 'react';

// Tiny emoji picker: the usual suspects in a grid, plus a box to paste or
// type any other standard emoji. Custom emoji is v2.

const COMMON = [
  '👍', '👎', '❤️', '😂', '😭', '😮', '😡', '🔥', '🎉', '💀', '👀', '🙏',
  '😅', '🤔', '😏', '🥲', '🫡', '🤝', '👏', '💯', '✅', '❌', '🎮', '🕹️',
  '🏆', '💩', '🫠', '😴', '🍕', '🍻', '☕', '🚀', '⚡', '🧠', '🤡', '🐐',
];

// Loose client-side check; the server has the strict one.
const LOOKS_LIKE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

export default function EmojiPicker({ onPick, onClose, align = 'right' }) {
  const [custom, setCustom] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  const pick = (e) => { onPick(e); onClose(); };
  const submit = (e) => {
    e.preventDefault();
    const v = custom.trim();
    if (LOOKS_LIKE_EMOJI.test(v) && v.length <= 16) pick(v);
  };

  return (
    <div className={`emoji-picker ${align}`} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <div className="emoji-grid">
        {COMMON.map((e) => (
          <button key={e} type="button" className="emoji-btn" onClick={() => pick(e)} title={e}>{e}</button>
        ))}
      </div>
      <form className="emoji-custom" onSubmit={submit}>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Any emoji…" maxLength={16} autoFocus />
        <button type="submit" className="ghost" disabled={!LOOKS_LIKE_EMOJI.test(custom.trim())}>Add</button>
      </form>
    </div>
  );
}
