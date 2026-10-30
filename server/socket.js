// One Socket.IO connection per client. Batch 0: auth handshake + presence
// (who's online). Batch 2: `server:changed` tells every client to reload
// /api/server after the owner edits channels, categories, or the server
// name. Batch 3: message / reaction / pin events are broadcast from the
// routes; typing goes client → server → everyone else; read markers go to
// the one user's own devices only. Batch 4: voice membership (helpers/voice.js)
// is reported by clients here and pushed to everyone as `voice:state`.
// Batch 5: the same status carries `sharing` (screen share up).

const { Server } = require('socket.io');
const { resolveToken } = require('./helpers/sessions');
const voice = require('./helpers/voice');

// userId -> Set<socketId>. A user is "online" while they have ≥1 socket.
const online = new Map();
let io = null;

const userRoom = (uid) => `user:${uid}`;

function attach(httpServer, { corsOrigins }) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    // Keep the socket cheap when idle.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = token ? await resolveToken(token) : null;
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.user.id;
    socket.join(userRoom(uid));
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(socket.id);

    socket.emit('presence:snapshot', { online: [...online.keys()] });
    if (online.get(uid).size === 1) io.emit('presence:online', { user_id: uid });

    // Typing: the client sends at most one of these every few seconds while
    // the user types; everyone else shows "<name> is typing…" for ~4 s.
    let lastTyping = 0;
    socket.on('typing', (payload) => {
      const channelId = Number(payload?.channel_id);
      if (!Number.isInteger(channelId)) return;
      const now = Date.now();
      if (now - lastTyping < 1500) return; // cheap abuse guard
      lastTyping = now;
      socket.broadcast.emit('typing', { channel_id: channelId, user_id: uid });
    });

    // Voice membership (batch 4). The client reports after it has actually
    // connected to LiveKit; the REST join route already enforced the cap.
    socket.emit('voice:snapshot', { channels: voice.snapshot() });
    socket.on('voice:joined', (payload) => {
      const channelId = Number(payload?.channel_id);
      if (!Number.isInteger(channelId)) return;
      voice.add(channelId, uid, { socket_id: socket.id, muted: Boolean(payload?.muted), deafened: Boolean(payload?.deafened), sharing: Boolean(payload?.sharing) });
    });
    socket.on('voice:left', () => voice.remove(uid));
    socket.on('voice:status', (payload) => voice.setStatus(uid, { muted: payload?.muted, deafened: payload?.deafened, sharing: payload?.sharing }));

    socket.on('disconnect', () => {
      voice.socketGone(uid, socket.id);
      const set = online.get(uid);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(uid);
        io.emit('presence:offline', { user_id: uid });
      }
    });
  });

  return io;
}

// Fire-and-forget broadcast to every connected client. Safe to call before
// attach() (e.g. in tests) — it just does nothing.
function broadcast(event, payload) {
  if (io) io.emit(event, payload || {});
}

// Same, but only to one user's devices.
function emitToUser(userId, event, payload) {
  if (io) io.to(userRoom(userId)).emit(event, payload || {});
}

module.exports = { attach, broadcast, emitToUser, online, io: () => io };
