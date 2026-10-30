import { useEffect, useRef, useState } from 'react';
import * as voice from './voiceStore.js';

// Screen share in the middle pane (plan §3.5). ShareView sits above the text
// channel in a split; drag the divider to resize. More than one person can
// share — the tabs pick whose share you watch, and only that one is
// subscribed (voice.js). ShareBar is the slim strip shown when someone is
// sharing and you aren't watching yet.

const HEIGHT_KEY = 'huddle_share_height'; // viewer height as % of the middle pane

function nameFor(members, uid, me) {
  if (uid === me) return 'Your screen';
  const m = members.find((x) => x.id === uid);
  return `${m?.display_name || '…'}'s screen`;
}

export function ShareBar({ members, user }) {
  const v = voice.useVoice();
  const others = v.shares.filter((uid) => uid !== user.id);
  if (v.phase === 'idle' || (others.length === 0 && !v.sharing)) return null;
  const name = (uid) => members.find((m) => m.id === uid)?.display_name || '…';
  return (
    <div className="share-bar">
      <span className="glyph">🖥️</span>
      <span className="share-bar-text">
        {others.length > 0 ? (
          <>
            {others.map((uid, i) => (
              <span key={uid}>{i > 0 && (i === others.length - 1 ? ' and ' : ', ')}<strong>{name(uid)}</strong></span>
            ))}
            {others.length === 1 ? ' is' : ' are'} sharing a screen
            {v.sharing ? ' — and so are you' : ''}
          </>
        ) : (
          <>You're sharing your screen{v.shareHasAudio ? ' with audio' : ''}</>
        )}
      </span>
      {others.map((uid) => (
        <button key={uid} type="button" className="primary small-btn" onClick={() => voice.watch(uid)}>
          Watch{others.length > 1 ? ` ${name(uid)}` : ''}
        </button>
      ))}
      {v.sharing && (
        <>
          <button type="button" className="ghost small-btn" onClick={() => voice.watch(user.id)}>Preview</button>
          <button type="button" className="danger small-btn" onClick={() => voice.stopShare()}>Stop sharing</button>
        </>
      )}
    </div>
  );
}

export default function ShareView({ members, user }) {
  const v = voice.useVoice();
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const [height, setHeight] = useState(() => { const n = Number(localStorage.getItem(HEIGHT_KEY)); return n >= 20 && n <= 85 ? n : 55; });
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Hand the <video> to the engine; it attaches whichever share is being watched.
  useEffect(() => {
    voice.attachShare(videoRef.current);
    return () => voice.attachShare(null);
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Divider drag (resizes against the text channel below).
  function startDrag(e) {
    e.preventDefault();
    const pane = wrapRef.current?.parentElement; // .main
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    setDragging(true);
    const move = (ev) => {
      const pct = Math.round(((ev.clientY - rect.top) / rect.height) * 100);
      setHeight(Math.max(20, Math.min(85, pct)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setHeight((h) => { try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch {} return h; });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else wrapRef.current?.querySelector('.share-stage')?.requestFullscreen?.().catch(() => {});
  }

  const me = user.id;
  const mine = v.watching === me;
  const fps = v.settings.shareFps >= 60 ? 60 : 30;
  const st = v.stats.share;

  return (
    <div className={`share-view${dragging ? ' dragging' : ''}`} ref={wrapRef} style={{ height: `${height}%` }}>
      <div className="share-head">
        <div className="share-tabs">
          {v.shares.map((uid) => (
            <button key={uid} type="button" className={`share-tab${uid === v.watching ? ' active' : ''}`} onClick={() => voice.watch(uid)}>
              🖥️ {nameFor(members, uid, me)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {mine && v.sharing && (
          <>
            {st && <span className="muted small share-stats" title={st.limited ? `Quality limited by ${st.limited}` : 'What you are sending'}>
              {st.width && st.height ? `${st.width}×${st.height} · ` : ''}{st.fps != null ? `${Math.round(st.fps)} fps` : '…'}{st.kbps != null ? ` · ${(st.kbps / 1000).toFixed(1)} Mbps` : ''}{st.limited ? ' ⚠' : ''}
            </span>}
            <div className="fps-toggle" title="Frame rate (60 costs more CPU and bandwidth)">
              <button type="button" className={fps === 30 ? 'active' : ''} onClick={() => voice.updateSettings({ shareFps: 30 })}>30</button>
              <button type="button" className={fps === 60 ? 'active' : ''} onClick={() => voice.updateSettings({ shareFps: 60 })}>60</button>
            </div>
            <button type="button" className="danger small-btn" onClick={() => voice.stopShare()}>Stop sharing</button>
          </>
        )}
        <button type="button" className="icon" title={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>⛶</button>
        <button type="button" className="icon" title="Stop watching (keeps the share running)" onClick={() => voice.stopWatching()}>✕</button>
      </div>
      <div className="share-stage">
        <video ref={videoRef} autoPlay playsInline muted />
        {!mine && <ShareHint uid={v.watching} members={members} videoRef={videoRef} />}
        {fullscreen && <button type="button" className="ghost share-exit-fs" onClick={toggleFullscreen}>Exit full screen</button>}
      </div>
      <div className="share-divider" onMouseDown={startDrag} title="Drag to resize" />
    </div>
  );
}

// "Connecting…" until frames actually arrive; the engine attaches the track
// once LiveKit delivers it (we only subscribe when watching).
function ShareHint({ uid, members, videoRef }) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    setLive(el.readyState >= 2 && !el.paused);
    const on = () => setLive(true);
    const off = () => setLive(false);
    el.addEventListener('playing', on);
    el.addEventListener('loadeddata', on);
    el.addEventListener('emptied', off);
    return () => { el.removeEventListener('playing', on); el.removeEventListener('loadeddata', on); el.removeEventListener('emptied', off); };
  }, [uid, videoRef]);
  if (live) return null;
  const m = members.find((x) => x.id === uid);
  return <div className="share-hint muted">Connecting to {m?.display_name || '…'}'s share…</div>;
}
