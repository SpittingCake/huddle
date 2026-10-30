import { useEffect, useState } from 'react';
import * as voice from './voiceStore.js';
import { keyLabel } from './voiceStore.js';

// Voice settings modal: devices, voice activity vs push-to-talk, sensitivity
// (with a live meter), PTT key, noise suppression, sounds, screen share
// (frame rate + audio), diagnostics.
// Everything is per-browser (localStorage) — it's about this machine's mic.

export default function VoiceSettings({ onClose }) {
  const v = voice.useVoice();
  const s = v.settings;
  const [devices, setDevices] = useState({ inputs: [], outputs: [] });
  const [capturing, setCapturing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    voice.listDevices().then(setDevices).catch(() => {});
    const onChange = () => voice.listDevices().then(setDevices).catch(() => {});
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key !== 'Escape') voice.updateSettings({ pttKey: e.code });
        setCapturing(false);
        return;
      }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, onClose]);

  async function copy() {
    const text = voice.diagnostics();
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { window.prompt('Copy this:', text); }
  }

  const meterPct = Math.max(0, Math.min(100, ((v.level + 100) / 100) * 100));
  const threshPct = ((s.threshold + 100) / 100) * 100;
  const label = (d, i) => d.label || `${d.kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-label="Voice settings">
        <nav className="modal-tabs">
          <button className="active" type="button">Voice</button>
          <span className="spacer" />
          <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
        </nav>
        <div className="modal-body settings-form">
          <label>
            Microphone
            <select value={s.inputId} onChange={(e) => voice.updateSettings({ inputId: e.target.value })}>
              <option value="">Default</option>
              {devices.inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
            </select>
          </label>
          <label>
            Speakers
            <select value={s.outputId} onChange={(e) => voice.updateSettings({ outputId: e.target.value })} disabled={!devices.outputs.length}>
              <option value="">Default</option>
              {devices.outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
            </select>
          </label>

          <div className="voice-mode">
            <label className="radio"><input type="radio" checked={s.mode === 'vad'} onChange={() => voice.updateSettings({ mode: 'vad' })} /> Voice activity</label>
            <label className="radio"><input type="radio" checked={s.mode === 'ptt'} onChange={() => voice.updateSettings({ mode: 'ptt' })} /> Push to talk</label>
          </div>

          {s.mode === 'vad' ? (
            <label>
              Sensitivity — opens at {s.threshold} dB
              <div className="meter" title="Your mic level. Talk; the bar should pass the marker.">
                <div className={`meter-fill${v.gateOpen ? ' open' : ''}`} style={{ width: `${v.phase === 'idle' ? 0 : meterPct}%` }} />
                <div className="meter-mark" style={{ left: `${threshPct}%` }} />
              </div>
              <input type="range" min={-90} max={-10} value={s.threshold} onChange={(e) => voice.updateSettings({ threshold: Number(e.target.value) })} />
              <span className="muted small">Lower = more sensitive. {v.phase === 'idle' ? 'Join a channel to see your level.' : ''}</span>
            </label>
          ) : (
            <label>
              Push-to-talk key
              <div className="row">
                <button type="button" className="ghost ptt-key" onClick={() => setCapturing(true)}>
                  {capturing ? 'Press a key…' : keyLabel(s.pttKey)}
                </button>
                <span className="muted small">Works while Huddle has focus; the in-game hotkey comes with the desktop app.</span>
              </div>
            </label>
          )}

          <label className="check"><input type="checkbox" checked={s.noise} onChange={(e) => voice.updateSettings({ noise: e.target.checked })} /> Noise suppression</label>
          <label className="check"><input type="checkbox" checked={s.sounds} onChange={(e) => voice.updateSettings({ sounds: e.target.checked })} /> Join / leave / mute sounds</label>

          <h4 className="settings-sub">Screen share</h4>
          <div className="row">
            <span>Frame rate</span>
            <div className="fps-toggle">
              <button type="button" className={s.shareFps !== 60 ? 'active' : ''} onClick={() => voice.updateSettings({ shareFps: 30 })}>30 fps</button>
              <button type="button" className={s.shareFps === 60 ? 'active' : ''} onClick={() => voice.updateSettings({ shareFps: 60 })}>60 fps</button>
            </div>
            <span className="muted small">Up to 1080p. 60 looks smoother for games but costs more CPU and upload.{v.sharing ? ' Changes apply to your current share.' : ''}</span>
          </div>
          <label className="check"><input type="checkbox" checked={s.shareAudio} onChange={(e) => voice.updateSettings({ shareAudio: e.target.checked })} /> Share audio with my screen</label>
          <span className="muted small">Needs the browser's “Share audio” box ticked in the picker. Windows can share system audio; macOS browsers only share a tab's audio (the desktop app will fix that).</span>

          <div className="row voice-diag">
            <button type="button" className="ghost" onClick={copy} disabled={v.phase === 'idle'}>{copied ? 'Copied ✓' : 'Copy diagnostics'}</button>
            {v.phase !== 'idle' && (
              <span className="muted small">
                {v.stats.protocol || '…'}{v.stats.relay ? ' (relay)' : ''}
                {v.stats.rttMs != null ? ` · ${v.stats.rttMs} ms` : ''}
                {v.stats.lossPct != null ? ` · ${v.stats.lossPct.toFixed(1)}% loss` : ''}
                {v.stats.reconnects ? ` · ${v.stats.reconnects} reconnect${v.stats.reconnects > 1 ? 's' : ''}` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
