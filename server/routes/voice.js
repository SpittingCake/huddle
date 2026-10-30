// Voice channels (batch 4). Mounted at /api/voice.
//   GET  /state                → who is in every voice channel
//   POST /:channelId/join      → { url, token, room } (cap of 10 enforced)
//   POST /:channelId/leave     → drop me (the socket normally does this)
//   POST /webhook              → LiveKit webhooks (optional; see livekit/README)
// Membership lives in helpers/voice.js and is pushed to clients as
// `voice:state` over the socket.

const express = require('express');
const db = require('../db');
const voice = require('../helpers/voice');
const { requireAuth } = require('../helpers/sessions');

const router = express.Router();

// LiveKit signs webhooks with the API key/secret; the body must be verified
// raw, so index.js mounts this BEFORE the JSON body parser.
const webhook = [express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const receiver = voice.webhookReceiver();
  if (!receiver) return res.status(503).json({ error: 'voice_not_configured' });
  let event;
  try {
    event = await receiver.receive(typeof req.body === 'string' ? req.body : '', req.headers.authorization);
  } catch {
    return res.status(401).json({ error: 'bad_signature' });
  }
  voice.applyWebhook(event);
  res.json({ ok: true });
}];

router.use(requireAuth);

router.get('/state', (req, res) => {
  res.json({ channels: voice.snapshot(), cap: voice.CAP });
});

router.use('/:channelId', async (req, res, next) => {
  const id = Number(req.params.channelId);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const ch = (await db.query('SELECT id, type, name FROM channels WHERE id = $1', [id])).rows[0];
  if (!ch) return res.status(404).json({ error: 'not_found' });
  if (ch.type !== 'voice') return res.status(400).json({ error: 'not_voice_channel' });
  req.channel = ch;
  next();
});

router.post('/:channelId/join', async (req, res) => {
  try {
    const out = await voice.mintToken(req.channel.id, req.user);
    res.json({ ...out, channel_id: req.channel.id, cap: voice.CAP });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.code, cap: err.cap });
    throw err;
  }
});

router.post('/:channelId/leave', (req, res) => {
  voice.remove(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.webhook = webhook;
