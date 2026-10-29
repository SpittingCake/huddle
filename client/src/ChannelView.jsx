// The middle pane. Text channels get the message list (batch 3); voice
// channels still show a placeholder until click-to-join lands in batch 4.

import Messages from './Messages.jsx';

export default function ChannelView({ channel, user, members, onRead }) {
  if (!channel) return <div className="center muted">Pick a channel on the left.</div>;

  if (channel.type === 'text') {
    return <Messages channel={channel} user={user} members={members} isOwner={user.role === 'owner'} onRead={onRead} />;
  }

  return (
    <div className="channel-view">
      <header className="channel-header">
        <span className="glyph">🔊</span>
        <h2>{channel.name}</h2>
      </header>
      <div className="channel-body">
        <p className="muted">Click-to-join voice lands in batch 4.</p>
        <p className="muted">Until then, the throwaway test room is at <a href="/voice-test">/voice-test</a>.</p>
      </div>
    </div>
  );
}
