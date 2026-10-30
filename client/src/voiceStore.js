// Voice state for the UI, without pulling livekit-client (~400 kB) into the
// main bundle. Components read it with useVoice(); actions lazy-load
// ./voice.js the first time someone joins a channel. Batch 5 adds screen
// share state (sharing / shares / watching) and the share actions.

import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import * as socket from './socket.js';

const SETTINGS_KEY = 'huddle_voice_settings';
const PEOPLE_KEY = 'huddle_voice_people'; // per-user volume / local mute (per browser)

export const DEFAULT_SETTINGS = {
  mode: 'vad',            // 'vad' | 'ptt'
  threshold: -45,         // dB; VAD opens above this
  pttKey: 'Backquote',    // KeyboardEvent.code
  noise: true,            // browser noise suppression
  sounds: true,
  inputId: '',
  outputId: '',
  shareFps: 30,           // 30 | 60 — screen share frame rate (plan §3.5: 1080p30 default, 60 toggle)
  shareAudio: true,       // include system/window audio with the share
};

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let state = {
  phase: 'idle',          // idle | connecting | connected | reconnecting
  channelId: null,
  muted: false,
  deafened: false,
  error: null,
  needsAudioClick: false,
  quality: 'unknown',     // excellent | good | poor | lost | unknown
  speaking: [],           // user ids currently speaking (my channel only)
  remoteMuted: [],        // user ids whose mic LiveKit reports muted
  level: -100,            // my mic level, dB (for the settings meter)
  gateOpen: false,        // is my mic currently passing audio
  stats: {},              // { protocol, relay, server, rttMs, lossPct, jitterMs, reconnects, share: { fps, kbps, width, height } }
  log: [],
  // Screen share (batch 5)
  sharing: false,         // am I sharing my screen
  shareHasAudio: false,   // did my share come with audio
  shares: [],             // user ids with a screen share up in my channel (me included)
  watching: null,         // user id whose share is in the viewer pane (null = none)
  shareError: null,
  settings: load(SETTINGS_KEY, DEFAULT_SETTINGS),
  people: load(PEOPLE_KEY, {}), // userId -> { volume: 0..2, muted: bool }
};

const listeners = new Set();
function emit() { for (const l of listeners) l(); }

export function get() { return state; }
export function set(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  emit();
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function useVoice() { return useSyncExternalStore(subscribe, get); }

export function updateSettings(patch) {
  const settings = { ...state.settings, ...patch };
  save(SETTINGS_KEY, settings);
  set({ settings });
  engine?.settingsChanged(patch);
}

export function personFor(userId) {
  return state.people[userId] || { volume: 1, muted: false };
}
export function updatePerson(userId, patch) {
  const people = { ...state.people, [userId]: { ...personFor(userId), ...patch } };
  save(PEOPLE_KEY, people);
  set({ people });
  engine?.personChanged(userId, people[userId]);
}

// ── actions (lazy engine) ──

let engine = null;
let loading = null;
async function load_() {
  if (engine) return engine;
  if (!loading) loading = import('./voice.js').then((m) => { m.init({ get, set, personFor, socket, api }); engine = m; return m; });
  return loading;
}

export async function join(channel) {
  const e = await load_();
  return e.join(channel);
}
export async function leave() { if (engine) await engine.leave(); }
export async function toggleMute() { if (engine) await engine.toggleMute(); }
export async function toggleDeafen() { if (engine) await engine.toggleDeafen(); }
export async function startAudio() { if (engine) await engine.startAudio(); }
export async function toggleShare() { if (engine) await engine.toggleShare(); }
export async function stopShare() { if (engine) await engine.stopShare(); }
export function watch(userId) { engine?.watch(userId); }
export function stopWatching() { engine?.watch(null); }
export function attachShare(el) { engine?.attachShare(el); }
export function canShare() { return Boolean(navigator.mediaDevices?.getDisplayMedia || window.huddleDesktop?.getDisplayMedia); }
export function diagnostics() { return engine ? engine.diagnostics() : ''; }
export function reportJoined() { engine?.reportJoined(); }
export async function listDevices() { const e = await load_(); return e.listDevices(); }

export function keyLabel(code) {
  if (!code) return '…';
  if (code === 'Backquote') return '`';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/(Left|Right)$/, ' ($1)').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
