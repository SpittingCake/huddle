// The middle pane. Text channels get the message list (batch 3). A voice
// channel selected via its URL shows who's in it and a join/leave button —
// day to day you join from the rail and this pane stays on a text channel.

import Messages from './Messages.jsx';
import Avatar from './Avatar.jsx';
import * as voice from './voiceStore.js';

export default function ChannelView({ channel, user, members, onRead, voiceMembers = [] }) {
  const v = voice.useVoice();
  if (!channel) return <div className="center muted">Pick a channel on the left.</div>;

  if (channel.type === 'text') {
    return <Messages channel={channel} user={user} members={members} isOwner={user.role === 'owner'} onRead={onRead} />;
  }

  const mine = v.channelId === channel.id;
  return (
    <div className="channel-view">
      <header className="channel-header">
        <span className="glyph">🔊</span>
        <h2>{channel.name}</h2>
        <span className="spacer" />
        <span className="muted small">{voiceMembers.length}/10</span>
      </header>
      <div className="channel-body voice-body">
        {voiceMembers.length === 0 ? (
          <p className="muted">Nobody's here yet.</p>
        ) : (
          <div className="voice-grid">
            {voiceMembers.map((m) => {
              const member = members.find((x) => x.id === m.user_id) || { id: m.user_id, display_name: '…' };
              const speaking = mine && v.speaking.includes(m.user_id);
              return (
                <div key={m.user_id} className={`voice-tile${speaking ? ' speaking' : ''}`}>
                  <span className="voice-ring big"><Avatar user={member} size={64} /></span>
                  <span className="voice-tile-name">{member.display_name}</span>
                  <span className="muted small">{m.deafened ? '🎧 deafened' : m.muted ? '🎤 muted' : ''}</span>
                </div>
              );
            })}
          </div>
        )}
        {mine ? (
          <button type="button" className="danger" onClick={() => voice.leave()}>Disconnect</button>
        ) : (
          <button type="button" className="primary" onClick={() => voice.join(channel)} disabled={v.phase === 'connecting' || voiceMembers.length >= 10}>
            {voiceMembers.length >= 10 ? 'Channel is full' : v.phase === 'connecting' ? 'Joining…' : 'Join voice'}
          </button>
        )}
      </div>
    </div>
  );
}
