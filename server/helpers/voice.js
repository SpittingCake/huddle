// Who is in which voice channel. Lives in memory (plan §4.2) — the server
// is the one place everyone connects to, so it's the source of truth for
// the rail. Kept honest three ways:
//   1. the client tells us over its socket when it has joined/left LiveKit,
//      and a socket disconnect removes the user;
//   2. LiveKit webhooks (if LIVEKIT_WEBHOOK is configured) add/remove on
//      participant_joined / participant_left / room_finished;
//   3. every 30 s we ask LiveKit who is really in each busy room and drop
//      anyone it doesn't know about (crashed tab, lost laptop).

const { RoomServiceClient, AccessToken, WebhookReceiver } = require('livekit-server-sdk');

const CAP = 10;
const RECONCILE_MS = 30_000;

// channelId -> Map<userId, { user_id, muted, deafened, socket_id, since }>
const channels = new Map();
// userId -> channelId
const where = new Map();
let io = null; // set by socket.js

function config() {
  const url = (process.env.LIVEKIT_URL || '').replace(/\/$/, '');
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  return url && key && secret ? { url, key, secret } : null;
}

// LiveKit's HTTP API lives on the same host as the WebSocket URL.
function httpUrl(url) {
  return url.replace(/^ws/, 'http');
}
function roomService() {
  const lk = config();
  if (!lk) return null;
  // Prefer an internal URL on Railway (no round trip through the public edge).
  const base = (process.env.LIVEKIT_API_URL || httpUrl(lk.url)).replace(/\/$/, '');
  return new RoomServiceClient(base, lk.key, lk.secret);
}

const roomName = (channelId) => `channel-${channelId}`;
const identity = (userId) => `u${userId}`;
const userFromIdentity = (id) => { const m = /^u(\d+)$/.exec(id || ''); return m ? Number(m[1]) : null; };
const channelFromRoom = (room) => { const m = /^channel-(\d+)$/.exec(room || ''); return m ? Number(m[1]) : null; };

function snapshot() {
  const out = {};
  for (const [cid, members] of channels) {
    if (members.size) out[cid] = [...members.values()].map(({ user_id, muted, deafened }) => ({ user_id, muted, deafened }));
  }
  return out;
}

function broadcastChannel(channelId) {
  if (!io) return;
  const members = channels.get(channelId);
  io.emit('voice:state', {
    channel_id: channelId,
    members: members ? [...members.values()].map(({ user_id, muted, deafened }) => ({ user_id, muted, deafened })) : [],
  });
}

function count(channelId) {
  return channels.get(channelId)?.size || 0;
}

// Put a user in a channel (moving them out of any other one).
function add(channelId, userId, { socket_id = null, muted = false, deafened = false } = {}) {
  const prev = where.get(userId);
  if (prev != null && prev !== channelId) remove(userId);
  if (!channels.has(channelId)) channels.set(channelId, new Map());
  const members = channels.get(channelId);
  const existing = members.get(userId);
  members.set(userId, { user_id: userId, muted, deafened, socket_id: socket_id ?? existing?.socket_id ?? null, since: existing?.since || Date.now() });
  where.set(userId, channelId);
  broadcastChannel(channelId);
}

function remove(userId) {
  const cid = where.get(userId);
  if (cid == null) return null;
  channels.get(cid)?.delete(userId);
  if (channels.get(cid)?.size === 0) channels.delete(cid);
  where.delete(userId);
  broadcastChannel(cid);
  return cid;
}

function setStatus(userId, { muted, deafened }) {
  const cid = where.get(userId);
  if (cid == null) return;
  const m = channels.get(cid).get(userId);
  if (typeof muted === 'boolean') m.muted = muted;
  if (typeof deafened === 'boolean') m.deafened = deafened;
  broadcastChannel(cid);
}

// A socket went away: if it was the socket that joined voice, drop the user.
function socketGone(userId, socketId) {
  const cid = where.get(userId);
  if (cid == null) return;
  const m = channels.get(cid).get(userId);
  if (!m.socket_id || m.socket_id === socketId) remove(userId);
}

// How many are really in the room, per LiveKit (null if we can't ask).
async function liveCount(channelId) {
  const svc = roomService();
  if (!svc) return null;
  try {
    const parts = await svc.listParticipants(roomName(channelId));
    return parts.filter((p) => userFromIdentity(p.identity) != null).length;
  } catch (err) {
    // Room doesn't exist yet → 0; anything else → unknown.
    if (/not found|does not exist/i.test(err?.message || '')) return 0;
    return null;
  }
}

// Mint a join token. Throws { code } on cap / config problems.
async function mintToken(channelId, user) {
  const lk = config();
  if (!lk) throw Object.assign(new Error('voice_not_configured'), { code: 'voice_not_configured', status: 503 });

  const alreadyHere = where.get(user.id) === channelId;
  const local = count(channelId) - (alreadyHere ? 1 : 0);
  const live = await liveCount(channelId);
  const occupied = live != null ? Math.max(local, live - (alreadyHere ? 1 : 0)) : local;
  if (occupied >= CAP) throw Object.assign(new Error('channel_full'), { code: 'channel_full', status: 409, cap: CAP });

  const at = new AccessToken(lk.key, lk.secret, {
    identity: identity(user.id),
    name: user.display_name || user.username,
    ttl: '6h',
    metadata: JSON.stringify({ user_id: user.id }),
  });
  at.addGrant({
    room: roomName(channelId),
    roomJoin: true,
    canPublish: true,     // mic now, screen share in batch 5
    canSubscribe: true,
    canPublishData: false,
  });
  return { url: lk.url, token: await at.toJwt(), room: roomName(channelId) };
}

// ── webhooks (optional) ────────────────────────────────────────────────────

function webhookReceiver() {
  const lk = config();
  return lk ? new WebhookReceiver(lk.key, lk.secret) : null;
}

function applyWebhook(event) {
  const cid = channelFromRoom(event.room?.name);
  if (cid == null) return false;
  if (event.event === 'participant_joined') {
    const uid = userFromIdentity(event.participant?.identity);
    if (uid != null && where.get(uid) !== cid) add(cid, uid);
    return true;
  }
  if (event.event === 'participant_left') {
    const uid = userFromIdentity(event.participant?.identity);
    if (uid != null && where.get(uid) === cid) remove(uid);
    return true;
  }
  if (event.event === 'room_finished') {
    for (const uid of [...(channels.get(cid)?.keys() || [])]) remove(uid);
    return true;
  }
  return false;
}

// ── reconcile ──────────────────────────────────────────────────────────────

async function reconcile() {
  const svc = roomService();
  if (!svc || channels.size === 0) return;
  for (const cid of [...channels.keys()]) {
    let parts;
    try { parts = await svc.listParticipants(roomName(cid)); } catch (err) {
      if (/not found|does not exist/i.test(err?.message || '')) parts = [];
      else continue; // LiveKit unreachable — leave things alone
    }
    const present = new Set(parts.map((p) => userFromIdentity(p.identity)).filter((n) => n != null));
    for (const [uid, m] of [...(channels.get(cid) || [])]) {
      // Give a fresh join 15 s to actually land in LiveKit before we doubt it.
      if (!present.has(uid) && Date.now() - m.since > 15_000) remove(uid);
    }
  }
}

function start(socketIo) {
  io = socketIo;
  setInterval(() => reconcile().catch(() => {}), RECONCILE_MS).unref();
}

// Owner-only kick comes in batch 6; this is the primitive for it.
async function kick(userId) {
  const cid = where.get(userId);
  if (cid == null) return;
  const svc = roomService();
  if (svc) await svc.removeParticipant(roomName(cid), identity(userId)).catch(() => {});
  remove(userId);
}

module.exports = {
  CAP, config, roomName, identity, userFromIdentity, channelFromRoom,
  snapshot, count, add, remove, setStatus, socketGone, mintToken, liveCount,
  webhookReceiver, applyWebhook, reconcile, start, kick,
  _reset: () => { channels.clear(); where.clear(); },
};
