const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { createSession, endSession, requireAuth } = require('../helpers/sessions');

const router = express.Router();

const MIN_PASSWORD = 10;
const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/i;

// 10 attempts per 15 minutes per IP on login/register.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Looser limit for the invite preview (it's read-only and public).
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    role: u.role,
    status: u.status,
    custom_status: u.custom_status,
    activity_sharing: u.activity_sharing,
  };
}

function inviteIsValid(inv) {
  return Boolean(
    inv &&
      !(inv.expires_at && new Date(inv.expires_at) < new Date()) &&
      !(inv.max_uses != null && inv.uses >= inv.max_uses)
  );
}

// POST /auth/login { username, password, device_label? }
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, device_label } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad_request' });
  }
  const { rows } = await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
  const user = rows[0];
  // Compare against a dummy hash when the user doesn't exist so timing is the same.
  const ok = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, DUMMY_HASH).then(() => false);
  if (!ok || !user.active) return res.status(401).json({ error: 'invalid_login' });

  const { token } = await createSession(user, device_label);
  res.json({ token, user: publicUser(user) });
});

// GET /auth/invite/:code — public. Lets the invite page say which server
// you're joining (and whether the link still works) before you sign up.
router.get('/invite/:code', inviteLimiter, async (req, res) => {
  const inv = (await db.query('SELECT * FROM invites WHERE code = $1', [req.params.code])).rows[0];
  const server = (await db.query('SELECT name FROM server WHERE id = 1')).rows[0];
  res.json({ valid: inviteIsValid(inv), server_name: server?.name || 'Huddle' });
});

// POST /auth/register { invite, username, password, display_name, device_label? }
// The only way in: a valid invite code.
router.post('/register', loginLimiter, async (req, res) => {
  const { invite, username, password, display_name, device_label } = req.body || {};
  if (typeof invite !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad_request' });
  }
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'bad_username' });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'password_too_short', min: MIN_PASSWORD });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const inv = (await client.query('SELECT * FROM invites WHERE code = $1 FOR UPDATE', [invite.trim()])).rows[0];
    if (!inviteIsValid(inv)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_invite' });
    }
    const taken = (await client.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username])).rowCount > 0;
    if (taken) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'username_taken' });
    }
    const hash = await bcrypt.hash(password, 12);
    const user = (
      await client.query(
        `INSERT INTO users (username, password_hash, display_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [username, hash, (display_name || username).toString().slice(0, 64)]
      )
    ).rows[0];
    await client.query('UPDATE invites SET uses = uses + 1 WHERE code = $1', [inv.code]);
    await client.query('COMMIT');

    const { token } = await createSession(user, device_label);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// POST /auth/logout — this device only.
router.post('/logout', requireAuth, async (req, res) => {
  await endSession(req.user.sid);
  res.json({ ok: true });
});

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

module.exports = router;
