// The middle pane. Batch 2 only shows the channel header and a placeholder;
// messages land here in batch 3, voice join/leave in batch 4.

export default function ChannelView({ channel }) {
  if (!channel) return <div className="center muted">Pick a channel on the left.</div>;

  const isVoice = channel.type === 'voice';
  return (
    <div className="channel-view">
      <header className="channel-header">
        <span className="glyph">{isVoice ? '🔊' : '#'}</span>
        <h2>{channel.name}</h2>
      </header>
      <div className="channel-body">
        {isVoice ? (
          <>
            <p className="muted">Click-to-join voice lands in batch 4.</p>
            <p className="muted">Until then, the throwaway test room is at <a href="/voice-test">/voice-test</a>.</p>
          </>
        ) : (
          <p className="muted">Messages land here in batch 3.</p>
        )}
      </div>
    </div>
  );
}
