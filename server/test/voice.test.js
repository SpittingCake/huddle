// Batch 4 tests: voice join tokens (claims, cap of 10, voice-channel-only,
// unconfigured → 503), membership over the socket (join/status/leave/
// disconnect broadcast voice:state), webhook signature + apply, state route.
// LiveKit itself isn't running here — LIVEKIT_URL points at a closed port, so
// the "ask LiveKit" paths fall back to local membership.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  console.log('skipping voice.test.js — DATABASE_URL not set');
  process.exit(0);
}
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.OWNER_USERNAME ||= 'owner';
process.env.OWNER_PASSWORD ||= 'ownerpassword1';
process.env.SERVER_URL ||= 'http://test.local';
process.env.PORT = '0';
process.env.LIVEKIT_URL = 'ws://127.0.0.1:1';
process.env.LIVEKIT_API_KEY = 'testkey';
process.env.LIVEKIT_API_SECRET = 'x'.repeat(40);

let base, owner, member, server, db, lobbyId, generalId, voice, ioClient;

before(async () => {
  db = require('../db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  await require('../bootstrap').bootstrap();
  voice = require('../helpers/voice');
  ioClient = require('socket.io-client').io;

  const http = require('http');
  const express = require('express');
  const app = express();
  app.post('/api/voice/webhook', ...require('../routes/voice').webhook);
  app.use(express.json());
  app.use('/auth', require('../routes/auth'));
  app.use('/api/server', require('../routes/server'));
  app.use('/api/voice', require('../routes/voice'));
  server = http.createServer(app);
  const socket = require('../socket');
  socket.attach(server, { corsOrigins: ['http://test.local'] });
  voice.start(socket.io());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = (await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD } })).json.token;
  const inv = await call('/api/server/invites', { method: 'POST', auth: owner, body: {} });
  member = (await call('/auth/register', { method: 'POST', body: { invite: inv.json.invite.code, username: 'pal', password: 'palpassword1', display_name: 'Pal' } })).json.token;
  const chans = (await call('/api/server', { auth: owner })).json.channels;
  lobbyId = chans.find((c) => c.type === 'voice').id;
  generalId = chans.find((c) => c.type === 'text').id;
});

after(async () => {
  require('../socket').io().close();
  server.close();
  await db.pool.end();
});

async function call(path, { method = 'GET', body, auth, raw, headers = {} } = {}) {
  const h = { ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) };
  if (!raw) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
// The snapshot arrives right after connect, so listen for it before connecting.
const connect = (token) => new Promise((resolve, reject) => {
  const s = ioClient(base, { auth: { token }, transports: ['websocket'] });
  s.snapshot = new Promise((r) => s.once('voice:snapshot', r));
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const waitFor = (s, event, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(event, h); resolve(p); } };
  s.on(event, h);
});

test('join mints a LiveKit token with the right claims', async () => {
  const r = await call(`/api/voice/${lobbyId}/join`, { method: 'POST', auth: member });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, 'ws://127.0.0.1:1');
  assert.equal(r.json.room, `channel-${lobbyId}`);
  assert.equal(r.json.cap, 10);
  const claims = decode(r.json.token);
  assert.equal(claims.sub, 'u2');
  assert.equal(claims.name, 'Pal');
  assert.equal(claims.video.room, `channel-${lobbyId}`);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canPublishData, false);
  assert.deepEqual(JSON.parse(claims.metadata), { user_id: 2 });

  assert.equal((await call(`/api/voice/${generalId}/join`, { method: 'POST', auth: owner })).json.error, 'not_voice_channel');
  assert.equal((await call('/api/voice/999999/join', { method: 'POST', auth: owner })).status, 404);
  assert.equal((await call(`/api/voice/${lobbyId}/join`, { method: 'POST' })).status, 401);
});

test('cap of 10 is enforced from local membership when LiveKit is unreachable', async () => {
  voice._reset();
  for (let i = 100; i < 110; i++) voice.add(lobbyId, i);
  assert.equal(voice.count(lobbyId), 10);
  const full = await call(`/api/voice/${lobbyId}/join`, { method: 'POST', auth: member });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'channel_full');
  assert.equal(full.json.cap, 10);
  // Someone already inside can re-join (reconnect) without counting twice.
  voice.remove(109);
  voice.add(lobbyId, 2);
  assert.equal((await call(`/api/voice/${lobbyId}/join`, { method: 'POST', auth: member })).status, 200);
  voice._reset();
});

test('membership over the socket: joined / status / left / disconnect', async () => {
  const a = await connect(owner);
  const b = await connect(member);
  await b.snapshot;

  const seen = waitFor(b, 'voice:state', (p) => p.channel_id === lobbyId && p.members.length === 1);
  a.emit('voice:joined', { channel_id: lobbyId, muted: false, deafened: false });
  const st = await seen;
  assert.deepEqual(st.members, [{ user_id: 1, muted: false, deafened: false }]);

  const state = await call('/api/voice/state', { auth: member });
  assert.deepEqual(state.json.channels, { [lobbyId]: [{ user_id: 1, muted: false, deafened: false }] });

  const mutedSeen = waitFor(b, 'voice:state', (p) => p.members[0]?.muted === true);
  a.emit('voice:status', { muted: true });
  assert.equal((await mutedSeen).members[0].deafened, false);

  // A second channel: joining it moves the user out of the first.
  const late = (await call('/api/server/channels', { method: 'POST', auth: owner, body: { type: 'voice', name: 'Late' } })).json.channel;
  const moved = waitFor(b, 'voice:state', (p) => p.channel_id === late.id && p.members.length === 1);
  const emptied = waitFor(b, 'voice:state', (p) => p.channel_id === lobbyId && p.members.length === 0);
  a.emit('voice:joined', { channel_id: late.id });
  await moved; await emptied;

  // Fresh connections get a snapshot with the current occupants.
  const c = await connect(member);
  const snap = await c.snapshot;
  assert.deepEqual(Object.keys(snap.channels), [String(late.id)]);
  c.disconnect();

  // Dropping the socket that joined removes the user.
  const gone = waitFor(b, 'voice:state', (p) => p.channel_id === late.id && p.members.length === 0);
  a.disconnect();
  await gone;
  assert.equal(voice.count(late.id), 0);

  // Explicit leave works too.
  b.emit('voice:joined', { channel_id: lobbyId });
  await waitFor(b, 'voice:state', (p) => p.members.length === 1);
  assert.equal((await call(`/api/voice/${lobbyId}/leave`, { method: 'POST', auth: member })).status, 200);
  assert.equal(voice.count(lobbyId), 0);
  b.disconnect();
});

test('webhooks: bad signature rejected, participant events apply', async () => {
  const { AccessToken } = require('livekit-server-sdk');
  const crypto = require('crypto');
  const sign = async (body) => {
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: '5m' });
    at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
    return at.toJwt();
  };
  const post = async (event, auth) => call('/api/voice/webhook', { method: 'POST', raw: event, headers: { 'Content-Type': 'application/webhook+json', ...(auth ? { Authorization: auth } : {}) } });

  const joined = JSON.stringify({ event: 'participant_joined', room: { name: `channel-${lobbyId}` }, participant: { identity: 'u2' } });
  assert.equal((await post(joined)).status, 401);
  assert.equal((await post(joined, 'nonsense')).status, 401);
  assert.equal((await post(joined, await sign('tampered'))).status, 401);

  assert.equal((await post(joined, await sign(joined))).status, 200);
  assert.equal(voice.count(lobbyId), 1);
  const left = JSON.stringify({ event: 'participant_left', room: { name: `channel-${lobbyId}` }, participant: { identity: 'u2' } });
  assert.equal((await post(left, await sign(left))).status, 200);
  assert.equal(voice.count(lobbyId), 0);

  const ignored = JSON.stringify({ event: 'participant_joined', room: { name: 'voice-test' }, participant: { identity: 'u2' } });
  assert.equal((await post(ignored, await sign(ignored))).status, 200, 'unknown rooms are ignored, not errors');
  assert.equal(voice.count(lobbyId), 0);
});

test('join is 503 when LiveKit is not configured', async () => {
  const saved = process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_URL;
  const r = await call(`/api/voice/${lobbyId}/join`, { method: 'POST', auth: owner });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'voice_not_configured');
  process.env.LIVEKIT_URL = saved;
});
