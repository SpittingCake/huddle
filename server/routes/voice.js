// Voice: mints LiveKit join tokens.
//
// Batch 1 only has the throwaway test room used by /voice-test. Batch 4
// replaces this with POST /api/voice/:channelId/join (cap check, room per
// voice channel, membership via LiveKit webhooks).

const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const { requireAuth } = require('../helpers/sessions');

const router = express.Router();
router.use(requireAuth);

const TEST_ROOM = 'voice-test';

function livekitConfig() {
  const url = (process.env.LIVEKIT_URL || '').replace(/\/$/, '');
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  return url && key && secret ? { url, key, secret } : null;
}

// POST /api/voice/test-token → { url, token, room }
router.post('/test-token', async (req, res) => {
  const lk = livekitConfig();
  if (!lk) return res.status(503).json({ error: 'voice_not_configured' });

  const at = new AccessToken(lk.key, lk.secret, {
    identity: `u${req.user.id}`,
    name: req.user.display_name || req.user.username,
    ttl: '2h',
  });
  at.addGrant({
    room: TEST_ROOM,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  res.json({ url: lk.url, token: await at.toJwt(), room: TEST_ROOM });
});

module.exports = router;
