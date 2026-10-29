import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, ConnectionQuality } from 'livekit-client';
import { api } from './api.js';

// Batch 1 throwaway: one shared LiveKit room ("voice-test") to prove voice
// works through huddle-livekit. Shows who's in, who's talking, and how the
// media is actually travelling (UDP vs TCP, round-trip, loss) so a 10-minute
// test with 3 people produces numbers, not just "sounded fine".
// Deleted when batch 4 lands real voice channels.

const GOAL_SECONDS = 10 * 60;

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function snapshot(room) {
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  return all.map((p) => {
    const mic = p.getTrackPublication(Track.Source.Microphone);
    return {
      identity: p.identity,
      name: p.name || p.identity,
      isLocal: p === room.localParticipant,
      speaking: p.isSpeaking,
      muted: !mic || mic.isMuted,
      quality: p.connectionQuality,
    };
  });
}

// Pulls the selected ICE candidate pair + quality numbers out of an RTCStatsReport.
function readStats(report) {
  if (!report) return {};
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  let pair;
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
  });
  if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  const out = {};
  if (pair) {
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    out.protocol = (remote?.protocol || local?.protocol || '').toUpperCase();
    out.relay = local?.candidateType === 'relay';
    out.server = remote ? `${remote.address || remote.ip}:${remote.port}` : undefined;
    if (pair.currentRoundTripTime != null) out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
  }
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
      out.lossPct = total ? (100 * (s.packetsLost || 0)) / total : 0;
      out.jitterMs = s.jitter != null ? Math.round(s.jitter * 1000) : undefined;
    }
    if (s.type === 'remote-inbound-rtp' && s.kind === 'audio' && s.roundTripTime != null && out.rttMs == null) {
      out.rttMs = Math.round(s.roundTripTime * 1000);
    }
  });
  return out;
}

const QUALITY_LABEL = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
};

export default function VoiceTest({ user }) {
  const roomRef = useRef(null);
  const audioBox = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | connecting | connected | reconnecting | error
  const [error, setError] = useState('');
  const [people, setPeople] = useState([]);
  const [muted, setMuted] = useState(false);
  const [joinedAt, setJoinedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [send, setSend] = useState({});
  const [recv, setRecv] = useState({});
  const [reconnects, setReconnects] = useState(0);
  const [needsAudioClick, setNeedsAudioClick] = useState(false);
  const [log, setLog] = useState([]);
  const [copied, setCopied] = useState(false);

  const addLog = (line) => setLog((l) => [...l.slice(-199), `${clock()}  ${line}`]);

  // Leave the room if the page goes away.
  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  // 1 s tick for the timer, 3 s stats poll.
  useEffect(() => {
    if (!joinedAt) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      const room = roomRef.current;
      if (!room) return;
      const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      setSend(readStats(await micPub?.track?.getRTCStatsReport().catch(() => undefined)));
      // Worst incoming stream = what the listener actually hears.
      let worst = {};
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.Microphone);
        const r = readStats(await pub?.track?.getRTCStatsReport().catch(() => undefined));
        if (worst.lossPct == null || (r.lossPct ?? 0) > worst.lossPct) worst = r;
      }
      setRecv(worst);
    }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [joinedAt]);

  async function join() {
    setError('');
    setPhase('connecting');
    setLog([]);
    setReconnects(0);
    try {
      const { url, token } = await api('/api/voice/test-token', { method: 'POST' });
      const room = new Room({
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        publishDefaults: { dtx: true, red: true },
      });
      roomRef.current = room;
      const refresh = () => setPeople(snapshot(room));

      room
        .on(RoomEvent.ParticipantConnected, (p) => { addLog(`${p.name || p.identity} joined`); refresh(); })
        .on(RoomEvent.ParticipantDisconnected, (p) => { addLog(`${p.name || p.identity} left`); refresh(); })
        .on(RoomEvent.ActiveSpeakersChanged, refresh)
        .on(RoomEvent.TrackMuted, refresh)
        .on(RoomEvent.TrackUnmuted, refresh)
        .on(RoomEvent.LocalTrackPublished, refresh)
        .on(RoomEvent.ConnectionQualityChanged, refresh)
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) audioBox.current?.appendChild(track.attach());
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); refresh(); })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioClick(!room.canPlaybackAudio))
        .on(RoomEvent.Reconnecting, () => { setPhase('reconnecting'); setReconnects((n) => n + 1); addLog('connection dropped — reconnecting'); })
        .on(RoomEvent.Reconnected, () => { setPhase('connected'); addLog('reconnected'); })
        .on(RoomEvent.MediaDevicesError, (e) => addLog(`microphone error: ${e.message}`))
        .on(RoomEvent.Disconnected, (reason) => {
          addLog(`disconnected (${reason ?? 'left'})`);
          setPhase('idle');
          setJoinedAt(null);
          setPeople([]);
          roomRef.current = null;
        });

      addLog(`connecting to ${url}`);
      await room.connect(url, token);
      addLog(`connected as ${room.localParticipant.name}`);
      await room.localParticipant.setMicrophoneEnabled(true);
      setMuted(false);
      setNeedsAudioClick(!room.canPlaybackAudio);
      setPhase('connected');
      setJoinedAt(Date.now());
      setNow(Date.now());
      refresh();
    } catch (e) {
      console.error(e);
      const msg = e?.body?.error === 'voice_not_configured'
        ? 'Voice isn’t configured on the server yet (LIVEKIT_URL / KEY / SECRET).'
        : e?.message || String(e);
      setError(msg);
      addLog(`failed: ${msg}`);
      setPhase('error');
      roomRef.current?.disconnect();
      roomRef.current = null;
    }
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
    setPeople(snapshot(room));
  }

  function leave() {
    roomRef.current?.disconnect();
  }

  const elapsed = joinedAt ? (now - joinedAt) / 1000 : 0;
  const inRoom = phase === 'connected' || phase === 'reconnecting';

  function diagnosticsText() {
    const n = (v, unit) => (v == null ? '—' : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${unit}`);
    return [
      `Huddle voice test — ${new Date().toISOString()}`,
      `me: ${user.display_name} (@${user.username}) · ${navigator.userAgent}`,
      `in room: ${fmt(elapsed)} · people: ${people.map((p) => p.name).join(', ') || '—'}`,
      `transport: ${send.protocol || '—'}${send.relay ? ' (relay)' : ''} → ${send.server || '—'}`,
      `send rtt: ${n(send.rttMs, ' ms')} · recv loss (worst): ${n(recv.lossPct, '%')} · recv jitter: ${n(recv.jitterMs, ' ms')}`,
      `reconnects: ${reconnects}`,
      '',
      ...log,
    ].join('\n');
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticsText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this:', diagnosticsText());
    }
  }

  return (
    <div className="voice-test">
      <header>
        <a href="/" className="muted small">← Back to Huddle</a>
        <h1>Voice test</h1>
        <p className="muted">
          Batch 1 check: get 3 people in here for 10 minutes. Everyone joins the same room. When you’re done,
          hit <b>Copy diagnostics</b> and paste it to Claude.
        </p>
      </header>

      <section className="vt-card">
        <div className="vt-row">
          {!inRoom && (
            <button className="primary" onClick={join} disabled={phase === 'connecting'}>
              {phase === 'connecting' ? 'Joining…' : 'Join voice test'}
            </button>
          )}
          {inRoom && (
            <>
              <button className={muted ? 'danger' : 'primary'} onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
              <button className="ghost" onClick={leave}>Leave</button>
              <span className={`vt-timer ${elapsed >= GOAL_SECONDS ? 'done' : ''}`}>
                {fmt(elapsed)} {elapsed >= GOAL_SECONDS ? '✓ 10 minutes' : '/ 10:00'}
              </span>
              {phase === 'reconnecting' && <span className="vt-warn">Reconnecting…</span>}
            </>
          )}
          {needsAudioClick && inRoom && (
            <button className="primary" onClick={() => roomRef.current?.startAudio()}>Click to hear others</button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      {inRoom && (
        <section className="vt-card">
          <div className="section-title">In the room — {people.length}</div>
          <ul className="vt-people">
            {people.map((p) => (
              <li key={p.identity} className={p.speaking ? 'speaking' : ''}>
                <span className="vt-ring" />
                <span className="vt-name">{p.name}{p.isLocal ? ' (you)' : ''}</span>
                {p.muted && <span className="vt-tag">muted</span>}
                <span className={`vt-q q-${QUALITY_LABEL[p.quality] || 'unknown'}`}>{QUALITY_LABEL[p.quality] || '…'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {inRoom && (
        <section className="vt-card">
          <div className="section-title">Connection</div>
          <dl className="vt-stats">
            <dt>Media path</dt>
            <dd>{send.protocol ? `${send.protocol}${send.relay ? ' via relay' : ''}` : '…'} <span className="muted small">{send.server}</span></dd>
            <dt>Round trip</dt><dd>{send.rttMs != null ? `${send.rttMs} ms` : '…'}</dd>
            <dt>Packet loss (incoming, worst)</dt><dd>{recv.lossPct != null ? `${recv.lossPct.toFixed(1)}%` : '—'}</dd>
            <dt>Jitter (incoming, worst)</dt><dd>{recv.jitterMs != null ? `${recv.jitterMs} ms` : '—'}</dd>
            <dt>Reconnects</dt><dd>{reconnects}</dd>
          </dl>
        </section>
      )}

      {log.length > 0 && (
        <section className="vt-card">
          <div className="vt-row">
            <div className="section-title" style={{ flex: 1, margin: 0 }}>Log</div>
            <button className="ghost" onClick={copyDiagnostics}>{copied ? 'Copied ✓' : 'Copy diagnostics'}</button>
          </div>
          <pre className="vt-log">{log.join('\n')}</pre>
        </section>
      )}

      <div ref={audioBox} hidden />
    </div>
  );
}
