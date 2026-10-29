// One Socket.IO connection per client. Batch 0: auth handshake + presence
// (who's online). Batch 2: `server:changed` tells every client to reload
// /api/server after the owner edits channels, categories, or the server
// name. Messages, typing, voice membership come in later batches.

const { Server } = require('socket.io');
const { resolveToken } = require('./helpers/sessions');

// userId -> Set<socketId>. A user is "online" while they have ≥1 socket.
const online = new Map();
let io = null;

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
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(socket.id);

    socket.emit('presence:snapshot', { online: [...online.keys()] });
    if (online.get(uid).size === 1) io.emit('presence:online', { user_id: uid });

    socket.on('disconnect', () => {
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

module.exports = { attach, broadcast, online };
