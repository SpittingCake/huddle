// Uploaded files live on disk in UPLOAD_DIR (a Railway volume in production,
// server/uploads locally). Every file gets a random storage key; the key is
// also its public URL (/files/<key>), so a file is reachable only by someone
// who was shown the link in a channel. Images are served inline, everything
// else as a download, always with nosniff — nothing is ever executed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const MAX_FILE_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // avatars / server icon

const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
// Things a browser or OS might run. Served as downloads anyway, but don't
// even accept them — this is a chat for friends, not a file drop.
const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'app', 'dmg', 'pkg', 'sh', 'command', 'cpl', 'reg', 'lnk', 'url',
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Keep the user's filename readable but harmless: no paths, no control chars.
function cleanFilename(raw) {
  let name = String(raw || 'file');
  // multer/busboy hand us the filename decoded as latin1; undo that when it
  // round-trips cleanly so "notes é.txt" stays "notes é.txt".
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  if (!utf8.includes('\ufffd') && Buffer.from(utf8, 'utf8').toString('latin1') === name) name = utf8;
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return name.slice(0, 120);
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = extOf(file.originalname);
    cb(null, crypto.randomBytes(16).toString('hex') + (ext ? `.${ext}` : ''));
  },
});

function fileFilter(req, file, cb) {
  if (BLOCKED_EXT.has(extOf(file.originalname))) return cb(Object.assign(new Error('blocked_type'), { code: 'BLOCKED_TYPE' }));
  cb(null, true);
}

const messageUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_MESSAGE } });
const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => (INLINE_IMAGE.has(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('not_image'), { code: 'NOT_IMAGE' }))),
});

// Express error → JSON for multer's failure modes.
function uploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', max_mb: Math.round(MAX_FILE_BYTES / 1024 / 1024) });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'too_many_files', max: MAX_FILES_PER_MESSAGE });
  if (err.code === 'BLOCKED_TYPE') return res.status(400).json({ error: 'blocked_type' });
  if (err.code === 'NOT_IMAGE') return res.status(400).json({ error: 'not_image' });
  next(err);
}

function urlFor(key) {
  return `/files/${key}`;
}

function publicAttachment(a) {
  return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: urlFor(a.storage_key), image: INLINE_IMAGE.has(a.mime) };
}

async function record({ file, uploaderId, kind = 'message', messageId = null }) {
  // The client's declared MIME can lie; it only decides inline-vs-download, and
  // nosniff + Content-Disposition keep a mislabelled file from doing anything.
  const mime = INLINE_IMAGE.has(file.mimetype) ? file.mimetype : 'application/octet-stream';
  const { rows } = await db.query(
    `INSERT INTO attachments (message_id, uploader_id, kind, filename, mime, size, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [messageId, uploaderId, kind, cleanFilename(file.originalname), mime, file.size, file.filename]
  );
  return rows[0];
}

function unlinkQuiet(key) {
  fs.promises.unlink(path.join(UPLOAD_DIR, key)).catch(() => {});
}

async function removeRows(rows) {
  for (const r of rows) unlinkQuiet(r.storage_key);
}

// Points users.avatar_url / server.icon_url at a new file (or null) and
// deletes the previous one if it was one of ours.
async function replaceImage(table, column, id, url) {
  if (!['users', 'server'].includes(table) || !['avatar_url', 'icon_url'].includes(column)) throw new Error('bad replaceImage target');
  const old = (await db.query(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id])).rows[0]?.v;
  await db.query(`UPDATE ${table} SET ${column} = $2 WHERE id = $1`, [id, url]);
  const oldKey = old && old.startsWith('/files/') ? old.slice('/files/'.length) : null;
  if (oldKey && oldKey !== (url || '').slice('/files/'.length)) {
    const { rows } = await db.query('DELETE FROM attachments WHERE storage_key = $1 AND kind <> $2 RETURNING storage_key', [oldKey, 'message']);
    await removeRows(rows);
  }
}

// GET /files/:key — public by obscurity (the key is 128 random bits).
async function serve(req, res) {
  const key = req.params.key;
  if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/.test(key)) return res.status(404).end();
  const row = (await db.query('SELECT filename, mime, size FROM attachments WHERE storage_key = $1', [key])).rows[0];
  if (!row) return res.status(404).end();
  const file = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(file)) return res.status(404).end();

  const inline = INLINE_IMAGE.has(row.mime);
  const asciiName = row.filename.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': row.mime,
    'Content-Length': String(row.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  fs.createReadStream(file).on('error', () => res.status(500).end()).pipe(res);
}

// Message uploads that never got attached to a message (user closed the tab).
async function sweepOrphans() {
  const { rows } = await db.query(
    `DELETE FROM attachments WHERE kind = 'message' AND message_id IS NULL AND created_at < now() - interval '1 hour'
     RETURNING storage_key`
  );
  await removeRows(rows);
  if (rows.length) console.log(`[files] swept ${rows.length} orphaned upload(s)`);
}

module.exports = {
  UPLOAD_DIR,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  messageUpload,
  imageUpload,
  uploadErrors,
  urlFor,
  publicAttachment,
  record,
  replaceImage,
  removeRows,
  unlinkQuiet,
  serve,
  sweepOrphans,
};
