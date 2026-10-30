// The voice engine: one LiveKit room at a time, a gated microphone chain
// (voice activity or push-to-talk), deafen, per-person volume, join/leave
// sounds, and connection stats. Loaded lazily by voiceStore.js.
//
// Mic chain:  getUserMedia → AudioContext source → GainNode (the gate)
//             → MediaStreamDestination → published to LiveKit.
// The gate flips instantly (no track re-publishing), so push-to-talk has
// no lag and voice activity doesn't clip the first syllable much.

import { Room, RoomEvent, Track, ConnectionQuality, DisconnectReason } from 'livekit-client';

// Wired up by voiceStore.js when this chunk loads (keeps this module free of
// app imports, so the store owns the state and tests can swap the engine).
let get, set, personFor, socket, api;
export function init(deps) {
  ({ get, set, personFor, socket, api } = deps);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('beforeunload', () => { room?.disconnect(); });
}

let room = null;
let channel = null;
let audioCtx = null;
let chain = null;      // { stream, source, analyser, gain, dest, track }
let gateTimer = null;
let statsTimer = null;
let pttHeld = false;
let holdUntil = 0;
let reconnects = 0;
let joinedAt = 0;
let joinSeq = 0;
let mutedBeforeDeafen = false;

const HOLD_MS = 350;

const QUALITY = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
};
const userFromIdentity = (id) => { const m = /^u(\d+)$/.exec(id || ''); return m ? Number(m[1]) : null; };
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const addLog = (line) => set((s) => ({ log: [...s.log.slice(-199), `${clock()}  ${line}`] }));

// ── audio context + sounds ──

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Tiny generated tones so there are no sound files to host (plan backlog).
function tone(notes, { gain = 0.08, dur = 0.09 } = {}) {
  if (!get().settings.sounds) return;
  try {
    const c = ctx();
    const t0 = c.currentTime;
    notes.forEach((freq, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + i * dur);
      g.gain.linearRampToValueAtTime(gain, t0 + i * dur + 0.01);
      g.gain.linearRampToValueAtTime(0, t0 + (i + 1) * dur);
      o.connect(g).connect(c.destination);
      o.start(t0 + i * dur);
      o.stop(t0 + (i + 1) * dur + 0.02);
    });
  } catch {}
}
const SOUND = {
  join: () => tone([523, 659, 784]),
  leave: () => tone([784, 659, 523]),
  mute: () => tone([392, 330], { dur: 0.07 }),
  unmute: () => tone([330, 392], { dur: 0.07 }),
  someoneJoined: () => tone([659, 784], { gain: 0.05, dur: 0.07 }),
  someoneLeft: () => tone([784, 659], { gain: 0.05, dur: 0.07 }),
};

// ── microphone chain ──

async function openMic(deviceId) {
  const s = get().settings;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: s.noise,
      autoGainControl: true,
    },
  });
  return stream;
}

async function buildChain() {
  const c = ctx();
  const stream = await openMic(get().settings.inputId);
  const source = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  const gain = c.createGain();
  gain.gain.value = 0;
  const dest = c.createMediaStreamDestination();
  source.connect(analyser);
  source.connect(gain).connect(dest);
  chain = { stream, source, analyser, gain, dest, track: dest.stream.getAudioTracks()[0] };
  startGate();
}

async function swapInput(deviceId) {
  if (!chain) return;
  const stream = await openMic(deviceId);
  chain.source.disconnect();
  chain.stream.getTracks().forEach((t) => t.stop());
  const source = ctx().createMediaStreamSource(stream);
  source.connect(chain.analyser);
  source.connect(chain.gain);
  chain.stream = stream;
  chain.source = source;
}

function teardownChain() {
  clearInterval(gateTimer);
  gateTimer = null;
  if (!chain) return;
  try { chain.source.disconnect(); chain.gain.disconnect(); } catch {}
  chain.stream.getTracks().forEach((t) => t.stop());
  chain.track.stop();
  chain = null;
}

function levelDb(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function startGate() {
  const buf = new Float32Array(chain.analyser.fftSize);
  let lastOpen = null;
  let tick = 0;
  gateTimer = setInterval(() => {
    if (!chain) return;
    const { settings, muted, deafened } = get();
    const db = levelDb(chain.analyser, buf);
    const now = Date.now();
    let open;
    if (muted || deafened) open = false;
    else if (settings.mode === 'ptt') open = pttHeld;
    else {
      if (db >= settings.threshold) holdUntil = now + HOLD_MS;
      open = now < holdUntil;
    }
    if (open !== lastOpen) {
      chain.gain.gain.setTargetAtTime(open ? 1 : 0, ctx().currentTime, 0.008);
      lastOpen = open;
      set({ gateOpen: open });
    }
    // The meter in settings only needs ~10 fps.
    if (++tick % 2 === 0) set({ level: Math.round(db) });
  }, 50);
}

// Push-to-talk on the web only works while the page has focus; the global
// hotkey arrives with the desktop app (batch 7).
function onKeyDown(e) {
  const s = get();
  if (s.phase === 'idle' || s.settings.mode !== 'ptt' || e.code !== s.settings.pttKey || e.repeat) return;
  if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName) && s.settings.pttKey.length === 4) return; // plain letters still type
  pttHeld = true;
}
function onKeyUp(e) {
  if (e.code === get().settings.pttKey) pttHeld = false;
}
function onBlur() { pttHeld = false; }

// ── room ──

function refreshParticipants() {
  if (!room) return;
  const speaking = [];
  const remoteMuted = [];
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
    const uid = userFromIdentity(p.identity);
    if (uid == null) continue;
    if (p.isSpeaking) speaking.push(uid);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    if (p !== room.localParticipant && (!mic || mic.isMuted)) remoteMuted.push(uid);
  }
  set({ speaking, remoteMuted, quality: QUALITY[room.localParticipant.connectionQuality] || 'unknown' });
}

function applyPerson(p) {
  const uid = userFromIdentity(p.identity);
  if (uid == null) return;
  const person = personFor(uid);
  p.setVolume(get().deafened || person.muted ? 0 : person.volume);
}

export async function join(ch) {
  const seq = ++joinSeq;
  if (room && channel?.id === ch.id) return;
  if (room) await leave({ silent: true });
  channel = ch;
  reconnects = 0;
  set({ phase: 'connecting', channelId: ch.id, error: null, log: [], stats: {}, speaking: [], remoteMuted: [] });
  addLog(`joining ${ch.name}`);
  try {
    const { url, token } = await api(`/api/voice/${ch.id}/join`, { method: 'POST' });
    if (seq !== joinSeq) return;
    const r = new Room({ webAudioMix: true, adaptiveStream: false, dynacast: false });
    room = r;
    r.on(RoomEvent.ParticipantConnected, (p) => { addLog(`${p.name || p.identity} joined`); applyPerson(p); SOUND.someoneJoined(); refreshParticipants(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { addLog(`${p.name || p.identity} left`); SOUND.someoneLeft(); refreshParticipants(); })
      .on(RoomEvent.ActiveSpeakersChanged, refreshParticipants)
      .on(RoomEvent.TrackMuted, refreshParticipants)
      .on(RoomEvent.TrackUnmuted, refreshParticipants)
      .on(RoomEvent.ConnectionQualityChanged, refreshParticipants)
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => { if (track.kind === Track.Kind.Audio) { track.attach(); applyPerson(p); } refreshParticipants(); })
      .on(RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); refreshParticipants(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => set({ needsAudioClick: !r.canPlaybackAudio }))
      .on(RoomEvent.Reconnecting, () => { reconnects++; set({ phase: 'reconnecting' }); addLog('connection dropped — reconnecting'); })
      .on(RoomEvent.Reconnected, () => { set({ phase: 'connected' }); addLog('reconnected'); })
      .on(RoomEvent.MediaDevicesError, (e) => addLog(`microphone error: ${e.message}`))
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== r) return;
        const why = reason === DisconnectReason.DUPLICATE_IDENTITY ? 'you joined from another device'
          : reason === DisconnectReason.ROOM_DELETED ? 'the room was closed'
          : reason === DisconnectReason.PARTICIPANT_REMOVED ? 'you were removed' : null;
        addLog(`disconnected${why ? ` (${why})` : ''}`);
        cleanup();
        set({ phase: 'idle', channelId: null, error: why, speaking: [], remoteMuted: [], needsAudioClick: false });
        socket.emit('voice:left');
      });

    await buildChain();
    if (seq !== joinSeq) { teardownChain(); r.disconnect(); return; }
    addLog(`connecting to ${url}`);
    await r.connect(url, token);
    if (seq !== joinSeq) { r.disconnect(); return; }
    await r.localParticipant.publishTrack(chain.track, { source: Track.Source.Microphone, dtx: true, red: true, name: 'mic' });
    const s = get();
    if (s.muted) await setMicMuted(true);
    if (s.settings.outputId) r.switchActiveDevice('audiooutput', s.settings.outputId).catch(() => {});
    await r.startAudio().catch(() => {});
    set({ phase: 'connected', needsAudioClick: !r.canPlaybackAudio });
    joinedAt = Date.now();
    addLog(`connected as ${r.localParticipant.name}`);
    for (const p of r.remoteParticipants.values()) applyPerson(p);
    refreshParticipants();
    reportJoined();
    SOUND.join();
    startStats();
  } catch (err) {
    if (seq !== joinSeq) return;
    const code = err?.body?.error || err?.message;
    const msg = code === 'channel_full' ? `That channel is full (${err.body?.cap || 10}/${err.body?.cap || 10}).`
      : code === 'voice_not_configured' ? 'Voice isn’t set up on the server yet.'
      : /NotAllowedError|Permission denied/i.test(String(err)) ? 'Microphone access was blocked — allow it in the browser and try again.'
      : /NotFoundError|Requested device not found/i.test(String(err)) ? 'No microphone found.'
      : 'Couldn’t connect to voice. Try again.';
    addLog(`failed: ${code}`);
    console.error(err);
    cleanup();
    set({ phase: 'idle', channelId: null, error: msg });
  }
}

function cleanup() {
  clearInterval(statsTimer);
  statsTimer = null;
  teardownChain();
  room = null;
  channel = null;
  pttHeld = false;
}

export async function leave({ silent } = {}) {
  joinSeq++;
  const r = room;
  if (!r) return;
  room = null;
  channel = null;
  cleanup();
  socket.emit('voice:left');
  set({ phase: 'idle', channelId: null, speaking: [], remoteMuted: [], needsAudioClick: false, error: null });
  if (!silent) SOUND.leave();
  await r.disconnect();
  addLog('left');
}

async function setMicMuted(muted) {
  if (!room) return;
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!pub?.track) return;
  if (muted) await pub.track.mute(); else await pub.track.unmute();
}

export async function toggleMute() {
  const s = get();
  const muted = !s.muted;
  set({ muted, ...(s.deafened && !muted ? { deafened: false } : {}) });
  if (s.deafened && !muted) undeafenAudio();
  await setMicMuted(muted);
  (muted ? SOUND.mute : SOUND.unmute)();
  reportStatus();
}

function undeafenAudio() {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) applyPerson(p);
}

export async function toggleDeafen() {
  const s = get();
  const deafened = !s.deafened;
  if (deafened) {
    mutedBeforeDeafen = s.muted;
    set({ deafened: true, muted: true });
    await setMicMuted(true);
    if (room) for (const p of room.remoteParticipants.values()) p.setVolume(0);
    SOUND.mute();
  } else {
    set({ deafened: false, muted: mutedBeforeDeafen });
    undeafenAudio();
    await setMicMuted(mutedBeforeDeafen);
    SOUND.unmute();
  }
  reportStatus();
}

export async function startAudio() {
  if (!room) return;
  await room.startAudio().catch(() => {});
  set({ needsAudioClick: !room.canPlaybackAudio });
}

// Tell the server (and so everyone's rail) where I am. Also called by App
// after a socket reconnect, so the membership survives a blip.
export function reportJoined() {
  const s = get();
  if (!room || s.channelId == null) return;
  socket.emit('voice:joined', { channel_id: s.channelId, muted: s.muted, deafened: s.deafened });
}
function reportStatus() {
  const s = get();
  if (room) socket.emit('voice:status', { muted: s.muted, deafened: s.deafened });
}

// ── settings / people hooks (called by the store) ──

export function settingsChanged(patch) {
  if ('inputId' in patch && chain) swapInput(patch.inputId).catch((e) => addLog(`mic switch failed: ${e.message}`));
  if ('outputId' in patch && room) room.switchActiveDevice('audiooutput', patch.outputId || 'default').catch(() => {});
  if ('noise' in patch && chain) swapInput(get().settings.inputId).catch(() => {});
  if ('mode' in patch) pttHeld = false;
}

export function personChanged(userId, person) {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    if (userFromIdentity(p.identity) === userId) p.setVolume(get().deafened || person.muted ? 0 : person.volume);
  }
}

export async function listDevices() {
  // Labels only show up once the mic permission has been granted.
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
  };
}

// ── stats ──

function readStats(report) {
  if (!report) return {};
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  let pair;
  report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId); });
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
    if (s.type === 'remote-inbound-rtp' && s.kind === 'audio' && s.roundTripTime != null && out.rttMs == null) out.rttMs = Math.round(s.roundTripTime * 1000);
  });
  return out;
}

function startStats() {
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!room) return;
    const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const send = readStats(await micPub?.track?.getRTCStatsReport().catch(() => undefined));
    let worst = {};
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.Microphone);
      const r = readStats(await pub?.track?.getRTCStatsReport().catch(() => undefined));
      if (worst.lossPct == null || (r.lossPct ?? 0) > worst.lossPct) worst = r;
    }
    set({ stats: { protocol: send.protocol, relay: send.relay, server: send.server, rttMs: send.rttMs, lossPct: worst.lossPct, jitterMs: worst.jitterMs, reconnects } });
  }, 3000);
}

export function diagnostics() {
  const s = get();
  const n = (v, unit) => (v == null ? '—' : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${unit}`);
  const secs = joinedAt ? Math.round((Date.now() - joinedAt) / 1000) : 0;
  const people = room ? [room.localParticipant, ...room.remoteParticipants.values()].map((p) => p.name || p.identity).join(', ') : '—';
  return [
    `Huddle voice — ${new Date().toISOString()}`,
    `channel: ${channel?.name || '—'} · in call: ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · people: ${people}`,
    `browser: ${navigator.userAgent}`,
    `mode: ${s.settings.mode}${s.settings.mode === 'vad' ? ` @ ${s.settings.threshold} dB` : ` (${s.settings.pttKey})`} · noise suppression: ${s.settings.noise ? 'on' : 'off'}`,
    `transport: ${s.stats.protocol || '—'}${s.stats.relay ? ' (relay)' : ''} → ${s.stats.server || '—'}`,
    `rtt: ${n(s.stats.rttMs, ' ms')} · recv loss (worst): ${n(s.stats.lossPct, '%')} · recv jitter: ${n(s.stats.jitterMs, ' ms')} · reconnects: ${reconnects}`,
    '',
    ...s.log,
  ].join('\n');
}
