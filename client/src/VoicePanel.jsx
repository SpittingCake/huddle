import { lazy, Suspense, useState } from 'react';
import * as voice from './voiceStore.js';
import { keyLabel } from './voiceStore.js';

// Bottom-left voice panel (plan §3.4): channel name, connection quality,
// mute / deafen / share / disconnect, and a gear for voice settings.
// Only rendered while you're in (or joining) a voice channel. The share
// button (batch 5) starts/stops your screen share; it lights up while sharing.

const VoiceSettings = lazy(() => import('./VoiceSettings.jsx'));

const QUALITY_TEXT = { excellent: 'Excellent connection', good: 'Good connection', poor: 'Poor connection', lost: 'Connection lost', unknown: 'Connecting…' };

export default function VoicePanel({ channel }) {
  const v = voice.useVoice();
  const [settings, setSettings] = useState(false);
  if (v.phase === 'idle') return null;

  const s = v.stats;
  const statsTitle = [
    QUALITY_TEXT[v.quality],
    s.protocol ? `${s.protocol}${s.relay ? ' via relay' : ''}` : null,
    s.rttMs != null ? `${s.rttMs} ms round trip` : null,
    s.lossPct != null ? `${s.lossPct.toFixed(1)}% loss` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="voice-panel">
      <div className="voice-panel-head">
        <span className={`quality q-${v.phase === 'connected' ? v.quality : 'unknown'}`} title={statsTitle} />
        <div className="voice-panel-text">
          <div className={`voice-panel-status ${v.phase}`}>
            {v.phase === 'connecting' ? 'Connecting…' : v.phase === 'reconnecting' ? 'Reconnecting…' : 'Voice connected'}
          </div>
          <div className="muted small voice-panel-channel">🔊 {channel?.name || '…'}</div>
        </div>
        <button type="button" className="icon" title="Voice settings" onClick={() => setSettings(true)}>⚙</button>
      </div>

      {v.needsAudioClick && (
        <button type="button" className="primary voice-unlock" onClick={voice.startAudio}>Click to hear others</button>
      )}

      <div className="voice-panel-buttons">
        <button type="button" className={`voice-btn${v.muted ? ' off' : ''}`} onClick={voice.toggleMute} title={v.muted ? 'Unmute (mic off)' : 'Mute'}>
          {v.muted ? '🎙️' : '🎤'}
          {v.muted && <span className="slash" />}
        </button>
        <button type="button" className={`voice-btn${v.deafened ? ' off' : ''}`} onClick={voice.toggleDeafen} title={v.deafened ? 'Undeafen' : 'Deafen (mutes you too)'}>
          🎧
          {v.deafened && <span className="slash" />}
        </button>
        <button
          type="button"
          className={`voice-btn${v.sharing ? ' on' : ''}`}
          disabled={v.phase !== 'connected' || !voice.canShare()}
          onClick={voice.toggleShare}
          title={!voice.canShare() ? 'Screen sharing isn’t supported in this browser' : v.sharing ? 'Stop sharing your screen' : `Share your screen (${v.settings.shareFps >= 60 ? 60 : 30} fps${v.settings.shareAudio ? ', with audio' : ''})`}
        >
          🖥️
        </button>
        <button type="button" className="voice-btn hang" onClick={() => voice.leave()} title="Disconnect">📵</button>
      </div>

      {v.sharing && (
        <div className="small share-live">
          <span className="live-dot" /> Sharing{v.shareHasAudio ? ' with audio' : ''}
          {!v.shareHasAudio && v.settings.shareAudio && <span className="muted"> — no audio (tick “Share audio” in the picker)</span>}
        </div>
      )}
      {v.shareError && (
        <div className="error small">{v.shareError} <button type="button" className="link" onClick={() => voice.set({ shareError: null })}>✕</button></div>
      )}

      {v.settings.mode === 'ptt' && v.phase === 'connected' && (
        <div className={`muted small ptt-hint${v.gateOpen ? ' live' : ''}`}>
          {v.gateOpen ? 'Transmitting' : `Hold ${keyLabel(v.settings.pttKey)} to talk`}
        </div>
      )}

      {settings && (
        <Suspense fallback={null}>
          <VoiceSettings onClose={() => setSettings(false)} />
        </Suspense>
      )}
    </div>
  );
}
