// The signed-in user's own profile: display name and avatar.
// Mounted at /api/me. Changes broadcast server:changed (members list).

const express = require('express');
const db = require('../db');
const files = require('../helpers/files');
const { requireAuth } = require('../helpers/sessions');
const { broadcast } = require('../socket');

const router = express.Router();
router.use(requireAuth);

const DISPLAY_MAX = 32;

function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url,
    role: u.role, status: u.status, custom_status: u.custom_status, activity_sharing: u.activity_sharing,
  };
}

// PATCH /api/me { display_name }
router.patch('/', async (req, res) => {
  const raw = req.body?.display_name;
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > DISPLAY_MAX) return res.status(400).json({ error: 'bad_name', max: DISPLAY_MAX });
  const { rows } = await db.query('UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [req.user.id, name]);
  broadcast('server:changed');
  res.json({ user: publicUser(rows[0]) });
});

// POST /api/me/avatar — multipart "file" (png/jpeg/gif/webp, ≤ 8 MB)
router.post('/avatar', (req, res, next) => files.imageUpload.single('file')(req, res, (err) => files.uploadErrors(err, req, res, next)), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const row = await files.record({ file: req.file, uploaderId: req.user.id, kind: 'avatar' });
  const url = files.urlFor(row.storage_key);
  await files.replaceImage('users', 'avatar_url', req.user.id, url);
  broadcast('server:changed');
  res.json({ avatar_url: url });
});

// DELETE /api/me/avatar — back to initials.
router.delete('/avatar', async (req, res) => {
  await files.replaceImage('users', 'avatar_url', req.user.id, null);
  broadcast('server:changed');
  res.json({ avatar_url: null });
});

module.exports = router;
