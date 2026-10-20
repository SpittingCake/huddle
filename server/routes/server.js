// The one server: name, channels, members, invites.
// Batch 0 exposes read endpoints and owner-only invite creation so the
// register flow can be exercised. Channel CRUD and the rail UI are batch 2.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireOwner } = require('../helpers/sessions');

const router = express.Router();
router.use(requireAuth);

// GET /api/server — everything the client needs on load.
router.get('/', async (req, res) => {
  const [server, channels, members] = await Promise.all([
    db.query('SELECT id, name, icon_url, owner_id FROM server WHERE id = 1'),
    db.query('SELECT id, type, name, position FROM channels ORDER BY position, id'),
    db.query(
      `SELECT id, username, display_name, avatar_url, role, status, custom_status
         FROM users WHERE active = true ORDER BY lower(display_name)`
    ),
  ]);
  res.json({ server: server.rows[0] || null, channels: channels.rows, members: members.rows });
});

// POST /api/server/invites { expires_in_hours?, max_uses? } — owner only.
router.post('/invites', requireOwner, async (req, res) => {
  const { expires_in_hours, max_uses } = req.body || {};
  const code = crypto.randomBytes(6).toString('base64url');
  const expiresAt = expires_in_hours ? new Date(Date.now() + Number(expires_in_hours) * 3600_000) : null;
  const { rows } = await db.query(
    `INSERT INTO invites (code, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [code, req.user.id, expiresAt, max_uses ? Number(max_uses) : null]
  );
  const base = (process.env.SERVER_URL || '').replace(/\/$/, '');
  res.status(201).json({ invite: rows[0], url: `${base}/invite/${code}` });
});

// GET /api/server/invites — owner only.
router.get('/invites', requireOwner, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM invites ORDER BY created_at DESC');
  res.json({ invites: rows });
});

// DELETE /api/server/invites/:code — owner only.
router.delete('/invites/:code', requireOwner, async (req, res) => {
  await db.query('DELETE FROM invites WHERE code = $1', [req.params.code]);
  res.json({ ok: true });
});

module.exports = router;
