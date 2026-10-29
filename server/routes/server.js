// The one server: name, categories, channels, members, invites.
// Everything here needs a signed-in user; writes are owner-only. Any write
// broadcasts `server:changed` so every open client reloads this payload.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const files = require('../helpers/files');
const { requireAuth, requireOwner } = require('../helpers/sessions');
const { broadcast } = require('../socket');

const router = express.Router();
router.use(requireAuth);

const NAME_MAX = 32;

// Text channels get Discord-style names: lowercase, dashes, no spaces.
// Voice channels and categories keep whatever the owner typed (trimmed).
function cleanName(raw, { slug } = {}) {
  if (typeof raw !== 'string') return null;
  let name = raw.trim().replace(/\s+/g, ' ');
  if (slug) name = name.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

function changed() {
  broadcast('server:changed');
}

async function loadServer() {
  const [server, categories, channels, members] = await Promise.all([
    db.query('SELECT id, name, icon_url, owner_id FROM server WHERE id = 1'),
    db.query('SELECT id, name, position FROM categories ORDER BY position, id'),
    db.query('SELECT id, type, name, position, category_id FROM channels ORDER BY position, id'),
    db.query(
      `SELECT id, username, display_name, avatar_url, role, status, custom_status
         FROM users WHERE active = true ORDER BY lower(display_name)`
    ),
  ]);
  return { server: server.rows[0] || null, categories: categories.rows, channels: channels.rows, members: members.rows };
}

// GET /api/server — everything the client needs on load.
router.get('/', async (req, res) => {
  res.json(await loadServer());
});

// PATCH /api/server { name } — owner only.
router.patch('/', requireOwner, async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'bad_name', max: NAME_MAX });
  const { rows } = await db.query('UPDATE server SET name = $1 WHERE id = 1 RETURNING id, name, icon_url, owner_id', [name]);
  changed();
  res.json({ server: rows[0] });
});

// POST /api/server/icon — owner only, multipart "file" (image ≤ 8 MB).
router.post('/icon', requireOwner, (req, res, next) => files.imageUpload.single('file')(req, res, (err) => files.uploadErrors(err, req, res, next)), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const row = await files.record({ file: req.file, uploaderId: req.user.id, kind: 'icon' });
  const url = files.urlFor(row.storage_key);
  await files.replaceImage('server', 'icon_url', 1, url);
  changed();
  res.json({ icon_url: url });
});

// DELETE /api/server/icon — owner only.
router.delete('/icon', requireOwner, async (req, res) => {
  await files.replaceImage('server', 'icon_url', 1, null);
  changed();
  res.json({ icon_url: null });
});

// ── Channels ───────────────────────────────────────────────────────────────

// POST /api/server/channels { type, name, category_id? } — owner only.
router.post('/channels', requireOwner, async (req, res) => {
  const { type, category_id } = req.body || {};
  if (type !== 'text' && type !== 'voice') return res.status(400).json({ error: 'bad_type' });
  const name = cleanName(req.body?.name, { slug: type === 'text' });
  if (!name) return res.status(400).json({ error: 'bad_name', max: NAME_MAX });
  const categoryId = await resolveCategory(category_id);
  if (categoryId === false) return res.status(400).json({ error: 'bad_category' });

  const { rows } = await db.query(
    `INSERT INTO channels (type, name, position, category_id)
     VALUES ($1, $2, (SELECT coalesce(max(position), -1) + 1 FROM channels), $3)
     RETURNING id, type, name, position, category_id`,
    [type, name, categoryId]
  );
  changed();
  res.status(201).json({ channel: rows[0] });
});

// PATCH /api/server/channels/:id { name?, category_id? } — owner only.
// Pass category_id: null to move a channel out of its category.
router.patch('/channels/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.query('SELECT * FROM channels WHERE id = $1', [id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  let name = existing.name;
  if ('name' in body) {
    name = cleanName(body.name, { slug: existing.type === 'text' });
    if (!name) return res.status(400).json({ error: 'bad_name', max: NAME_MAX });
  }
  let categoryId = existing.category_id;
  if ('category_id' in body) {
    categoryId = await resolveCategory(body.category_id);
    if (categoryId === false) return res.status(400).json({ error: 'bad_category' });
  }

  const { rows } = await db.query(
    `UPDATE channels SET name = $2, category_id = $3 WHERE id = $1
     RETURNING id, type, name, position, category_id`,
    [id, name, categoryId]
  );
  changed();
  res.json({ channel: rows[0] });
});

// DELETE /api/server/channels/:id — owner only. The last text channel stays.
router.delete('/channels/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.query('SELECT * FROM channels WHERE id = $1', [id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.type === 'text') {
    const n = (await db.query(`SELECT count(*)::int AS n FROM channels WHERE type = 'text'`)).rows[0].n;
    if (n <= 1) return res.status(400).json({ error: 'last_text_channel' });
  }
  await db.query('DELETE FROM channels WHERE id = $1', [id]);
  changed();
  res.json({ ok: true });
});

// PUT /api/server/channels/order { ids: [channelId, ...] } — owner only.
// Positions become the index in `ids`; channels not listed keep their
// position (so the client can reorder one category at a time).
router.put('/channels/order', requireOwner, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
  if (!ids || ids.some((n) => !Number.isInteger(n))) return res.status(400).json({ error: 'bad_request' });
  await reorder('channels', ids);
  changed();
  res.json({ ok: true });
});

// ── Categories ─────────────────────────────────────────────────────────────

router.post('/categories', requireOwner, async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'bad_name', max: NAME_MAX });
  const { rows } = await db.query(
    `INSERT INTO categories (name, position)
     VALUES ($1, (SELECT coalesce(max(position), -1) + 1 FROM categories))
     RETURNING id, name, position`,
    [name]
  );
  changed();
  res.status(201).json({ category: rows[0] });
});

router.patch('/categories/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'bad_name', max: NAME_MAX });
  const { rows } = await db.query('UPDATE categories SET name = $2 WHERE id = $1 RETURNING id, name, position', [id, name]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  changed();
  res.json({ category: rows[0] });
});

// Deleting a category keeps its channels (they become uncategorized).
router.delete('/categories/:id', requireOwner, async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  changed();
  res.json({ ok: true });
});

router.put('/categories/order', requireOwner, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
  if (!ids || ids.some((n) => !Number.isInteger(n))) return res.status(400).json({ error: 'bad_request' });
  await reorder('categories', ids);
  changed();
  res.json({ ok: true });
});

// ── Invites ────────────────────────────────────────────────────────────────

function inviteUrl(code) {
  const base = (process.env.SERVER_URL || '').replace(/\/$/, '');
  return `${base}/invite/${code}`;
}
function withUrl(inv) {
  return { ...inv, url: inviteUrl(inv.code) };
}

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
  res.status(201).json({ invite: withUrl(rows[0]), url: inviteUrl(code) });
});

// GET /api/server/invites — owner only.
router.get('/invites', requireOwner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT i.*, u.display_name AS created_by_name
       FROM invites i JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC`
  );
  res.json({ invites: rows.map(withUrl) });
});

// DELETE /api/server/invites/:code — owner only.
router.delete('/invites/:code', requireOwner, async (req, res) => {
  await db.query('DELETE FROM invites WHERE code = $1', [req.params.code]);
  res.json({ ok: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

// null/undefined → null (uncategorized); a real id → that id; unknown → false.
async function resolveCategory(raw) {
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) return false;
  const { rowCount } = await db.query('SELECT 1 FROM categories WHERE id = $1', [id]);
  return rowCount ? id : false;
}

async function reorder(table, ids) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE ${table} SET position = $2 WHERE id = $1`, [ids[i], i]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
