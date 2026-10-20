// Login tokens: a JWT carrying { uid, sid, tv }.
//   uid = user id, sid = sessions.id (this device), tv = users.token_version.
// A token is valid only if the session row still exists AND tv matches.
// Sign out = delete the row. Ban / password change = bump token_version.

const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change-me') {
  console.error('JWT_SECRET must be set to a long random string. See server/.env.example');
  process.exit(1);
}

const TOKEN_TTL = '30d';

async function createSession(user, deviceLabel) {
  const { rows } = await db.query(
    'INSERT INTO sessions (user_id, device_label) VALUES ($1, $2) RETURNING id',
    [user.id, deviceLabel || null]
  );
  const sid = rows[0].id;
  const token = jwt.sign({ uid: user.id, sid, tv: user.token_version }, SECRET, { expiresIn: TOKEN_TTL });
  return { token, sid };
}

// Returns the user row or null. Touches last_seen at most once a minute.
async function resolveToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return null;
  }
  const { rows } = await db.query(
    `SELECT u.*, s.id AS sid, s.last_seen
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND u.id = $2 AND u.active = true`,
    [payload.sid, payload.uid]
  );
  const row = rows[0];
  if (!row || row.token_version !== payload.tv) return null;

  if (Date.now() - new Date(row.last_seen).getTime() > 60_000) {
    db.query('UPDATE sessions SET last_seen = now() WHERE id = $1', [row.sid]).catch(() => {});
  }
  delete row.password_hash;
  return row;
}

async function endSession(sid) {
  await db.query('DELETE FROM sessions WHERE id = $1', [sid]);
}

// Signs the user out everywhere (all devices).
async function revokeAll(userId) {
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Express middleware: requires a valid Bearer token, sets req.user.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const user = await resolveToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
  next();
}

module.exports = { createSession, resolveToken, endSession, revokeAll, requireAuth, requireOwner };
