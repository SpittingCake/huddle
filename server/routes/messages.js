// Text channels: messages, replies, edit/delete, reactions, pins, read
// markers, unread + mention counts. Mounted at /api/channels.
//
// Everyone in the server can read every text channel, so writes broadcast to
// all sockets: message:new / message:updated / message:deleted,
// reactions:changed, pins:changed. Read markers are per user and only go to
// that user's own devices (read:updated).

const express = require('express');
const db = require('../db');
const files = require('../helpers/files');
const { requireAuth } = require('../helpers/sessions');
const { broadcast, emitToUser } = require('../socket');

const router = express.Router();
router.use(requireAuth);

const BODY_MAX = 2000;
const PAGE = 50;
const PAGE_MAX = 100;
const EXCERPT = 120;

// ── Unread / mentions (all channels at once) ───────────────────────────────

// GET /api/channels/unread → { channels: { [id]: { unread, mentions } } }
// A channel you've never opened counts everything in it. Your own messages
// never count.
router.get('/unread', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id AS channel_id,
            count(m.id)::int AS unread,
            count(mm.user_id)::int AS mentions
       FROM channels c
       LEFT JOIN read_markers r ON r.channel_id = c.id AND r.user_id = $1
       LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
                           AND m.author_id <> $1 AND m.id > coalesce(r.last_read_message_id, 0)
       LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = $1
      WHERE c.type = 'text'
      GROUP BY c.id`,
    [req.user.id]
  );
  const channels = {};
  for (const r of rows) channels[r.channel_id] = { unread: r.unread, mentions: r.mentions };
  res.json({ channels });
});

// ── Per-channel ────────────────────────────────────────────────────────────

router.use('/:channelId', async (req, res, next) => {
  const id = Number(req.params.channelId);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const ch = (await db.query('SELECT id, type, name FROM channels WHERE id = $1', [id])).rows[0];
  if (!ch) return res.status(404).json({ error: 'not_found' });
  if (ch.type !== 'text') return res.status(400).json({ error: 'not_text_channel' });
  req.channel = ch;
  next();
});

// GET /api/channels/:id/messages?before=<id>&limit=50
// Newest page by default; pass before=<oldest id you have> to page up.
router.get('/:channelId/messages', async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  if (before !== null && !Number.isInteger(before)) return res.status(400).json({ error: 'bad_request' });
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || PAGE));

  const rows = await loadMessages({ channelId: req.channel.id, before, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();

  const out = { messages, has_more: hasMore };
  if (before === null) {
    const r = (await db.query('SELECT last_read_message_id FROM read_markers WHERE user_id = $1 AND channel_id = $2', [req.user.id, req.channel.id])).rows[0];
    out.last_read_message_id = r?.last_read_message_id ?? 0;
    out.pin_count = (await db.query('SELECT count(*)::int AS n FROM pins WHERE channel_id = $1', [req.channel.id])).rows[0].n;
  }
  res.json(out);
});

// POST /api/channels/:id/messages { body, reply_to_id?, attachment_ids? }
router.post('/:channelId/messages', async (req, res) => {
  const { reply_to_id } = req.body || {};
  const body = cleanBody(req.body?.body);
  if (body === null) return res.status(400).json({ error: 'body_too_long', max: BODY_MAX });

  const attachmentIds = Array.isArray(req.body?.attachment_ids) ? req.body.attachment_ids.map(Number).filter(Number.isInteger) : [];
  if (attachmentIds.length > files.MAX_FILES_PER_MESSAGE) return res.status(400).json({ error: 'too_many_files', max: files.MAX_FILES_PER_MESSAGE });
  if (!body && attachmentIds.length === 0) return res.status(400).json({ error: 'empty_message' });

  let replyTo = null;
  if (reply_to_id != null) {
    replyTo = Number(reply_to_id);
    const ok = Number.isInteger(replyTo) && (await db.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL', [replyTo, req.channel.id])).rowCount;
    if (!ok) return res.status(400).json({ error: 'bad_reply' });
  }

  const client = await db.pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    id = (
      await client.query(
        'INSERT INTO messages (channel_id, author_id, body, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.channel.id, req.user.id, body, replyTo]
      )
    ).rows[0].id;
    if (attachmentIds.length) {
      // Only this user's own, still-unattached uploads can be linked.
      const linked = await client.query(
        `UPDATE attachments SET message_id = $1
          WHERE id = ANY($2::int[]) AND uploader_id = $3 AND message_id IS NULL AND kind = 'message'
          RETURNING id`,
        [id, attachmentIds, req.user.id]
      );
      if (linked.rowCount !== attachmentIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'bad_attachment' });
      }
    }
    await saveMentions(client, id, body, req.user.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Posting marks your own message as read on all your devices.
  await markRead(req.user.id, req.channel.id, id);

  const message = (await loadMessages({ ids: [id] }))[0];
  broadcast('message:new', { message });
  res.status(201).json({ message });
});

// PATCH /api/channels/:id/messages/:mid { body } — author only.
router.patch('/:channelId/messages/:mid', async (req, res) => {
  const m = await ownMessage(req, res);
  if (!m) return;
  if (m.author_id !== req.user.id) return res.status(403).json({ error: 'not_author' });
  const body = cleanBody(req.body?.body);
  if (body === null) return res.status(400).json({ error: 'body_too_long', max: BODY_MAX });
  const hasFiles = (await db.query('SELECT 1 FROM attachments WHERE message_id = $1', [m.id])).rowCount > 0;
  if (!body && !hasFiles) return res.status(400).json({ error: 'empty_message' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [m.id, body]);
    await client.query('DELETE FROM message_mentions WHERE message_id = $1', [m.id]);
    await saveMentions(client, m.id, body, req.user.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const message = (await loadMessages({ ids: [m.id] }))[0];
  broadcast('message:updated', { message });
  res.json({ message });
});

// DELETE /api/channels/:id/messages/:mid — author or owner. Soft-deletes the
// row (so replies can say "original message deleted") and removes the files.
router.delete('/:channelId/messages/:mid', async (req, res) => {
  const m = await ownMessage(req, res);
  if (!m) return;
  if (m.author_id !== req.user.id && req.user.role !== 'owner') return res.status(403).json({ error: 'not_author' });

  const { rows: atts } = await db.query('DELETE FROM attachments WHERE message_id = $1 RETURNING storage_key', [m.id]);
  await files.removeRows(atts);
  await db.query(`UPDATE messages SET deleted_at = now(), body = '' WHERE id = $1`, [m.id]);
  await db.query('DELETE FROM reactions WHERE message_id = $1', [m.id]);
  await db.query('DELETE FROM pins WHERE message_id = $1', [m.id]);
  await db.query('DELETE FROM message_mentions WHERE message_id = $1', [m.id]);
  broadcast('message:deleted', { channel_id: req.channel.id, id: m.id });
  res.json({ ok: true });
});

// ── Reactions ──────────────────────────────────────────────────────────────

// Standard emoji only (custom emoji is v2). One or two pictographic
// characters plus modifiers/ZWJ — "👍", "👍🏽", "🏳️‍🌈" all pass; "abc" doesn't.
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\p{Emoji_Modifier}‍️]|\p{Extended_Pictographic}|\p{Regional_Indicator}){0,8}$/u;

async function reactionRoute(req, res, add) {
  const m = await ownMessage(req, res);
  if (!m) return;
  const emoji = decodeURIComponent(req.params.emoji || '');
  if (!EMOJI_RE.test(emoji)) return res.status(400).json({ error: 'bad_emoji' });
  if (add) {
    await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.id, req.user.id, emoji]);
  } else {
    await db.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [m.id, req.user.id, emoji]);
  }
  const reactions = await loadReactions(m.id);
  broadcast('reactions:changed', { channel_id: req.channel.id, message_id: m.id, reactions });
  res.json({ reactions });
}
router.put('/:channelId/messages/:mid/reactions/:emoji', (req, res) => reactionRoute(req, res, true));
router.delete('/:channelId/messages/:mid/reactions/:emoji', (req, res) => reactionRoute(req, res, false));

// ── Pins ───────────────────────────────────────────────────────────────────

// Anyone can pin/unpin — it's a friend group. Newest pin first.
router.get('/:channelId/pins', async (req, res) => {
  const ids = (await db.query('SELECT message_id FROM pins WHERE channel_id = $1 ORDER BY created_at DESC', [req.channel.id])).rows.map((r) => r.message_id);
  const messages = ids.length ? await loadMessages({ ids }) : [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  res.json({ messages: ids.map((id) => byId.get(id)).filter(Boolean) });
});

async function pinRoute(req, res, pin) {
  const m = await ownMessage(req, res);
  if (!m) return;
  if (pin) {
    await db.query('INSERT INTO pins (message_id, channel_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.id, req.channel.id, req.user.id]);
  } else {
    await db.query('DELETE FROM pins WHERE message_id = $1', [m.id]);
  }
  const count = (await db.query('SELECT count(*)::int AS n FROM pins WHERE channel_id = $1', [req.channel.id])).rows[0].n;
  broadcast('pins:changed', { channel_id: req.channel.id, message_id: m.id, pinned: pin, count });
  res.json({ pinned: pin, count });
}
router.put('/:channelId/pins/:mid', (req, res) => pinRoute(req, res, true));
router.delete('/:channelId/pins/:mid', (req, res) => pinRoute(req, res, false));

// ── Read markers ───────────────────────────────────────────────────────────

// POST /api/channels/:id/read { last_read_message_id } — never moves backwards.
router.post('/:channelId/read', async (req, res) => {
  const id = Number(req.body?.last_read_message_id);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'bad_request' });
  await markRead(req.user.id, req.channel.id, id);
  res.json({ ok: true });
});

async function markRead(userId, channelId, messageId) {
  const { rows } = await db.query(
    `INSERT INTO read_markers (user_id, channel_id, last_read_message_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_message_id = greatest(read_markers.last_read_message_id, EXCLUDED.last_read_message_id)
     RETURNING last_read_message_id`,
    [userId, channelId, messageId]
  );
  emitToUser(userId, 'read:updated', { channel_id: channelId, last_read_message_id: rows[0].last_read_message_id });
}

// ── helpers ────────────────────────────────────────────────────────────────

// '' is allowed (attachment-only); null means too long / not a string.
function cleanBody(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') return null;
  const body = raw.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return body.length > BODY_MAX ? null : body;
}

async function ownMessage(req, res) {
  const mid = Number(req.params.mid);
  const m = Number.isInteger(mid)
    ? (await db.query('SELECT id, author_id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL', [mid, req.channel.id])).rows[0]
    : null;
  if (!m) res.status(404).json({ error: 'not_found' });
  return m || null;
}

// @username and @everyone. Trailing punctuation is forgiven ("@danny.").
const MENTION_RE = /(^|[^a-z0-9_.-])@([a-z0-9_.-]{2,32})/gi;
function mentionNames(body) {
  const names = new Set();
  for (const m of body.matchAll(MENTION_RE)) names.add(m[2].replace(/[.-]+$/, '').toLowerCase());
  return names;
}

async function saveMentions(client, messageId, body, authorId) {
  const names = mentionNames(body);
  if (!names.size) return;
  const everyone = names.has('everyone');
  const { rows } = everyone
    ? await client.query('SELECT id FROM users WHERE active = true AND id <> $1', [authorId])
    : await client.query('SELECT id FROM users WHERE active = true AND lower(username) = ANY($1::text[])', [[...names]]);
  for (const r of rows) {
    await client.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, r.id]);
  }
}

async function loadReactions(messageId) {
  const { rows } = await db.query(
    `SELECT emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first
       FROM reactions WHERE message_id = $1 GROUP BY emoji ORDER BY first`,
    [messageId]
  );
  return rows.map((r) => ({ emoji: r.emoji, user_ids: r.user_ids }));
}

// Newest-first rows with everything the client renders. Either a channel
// page ({channelId, before, limit}) or specific ids ({ids}).
async function loadMessages({ channelId, before, limit, ids }) {
  const where = ids ? 'm.id = ANY($1::int[])' : 'm.channel_id = $1 AND m.deleted_at IS NULL AND ($2::int IS NULL OR m.id < $2)';
  const params = ids ? [ids] : [channelId, before, limit];
  const { rows } = await db.query(
    `SELECT m.id, m.channel_id, m.body, m.reply_to_id, m.edited_at, m.created_at,
            u.id AS author_id, u.username, u.display_name, u.avatar_url,
            (SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mime', a.mime, 'size', a.size, 'storage_key', a.storage_key) ORDER BY a.id)
               FROM attachments a WHERE a.message_id = m.id) AS attachments,
            (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_ids', r.user_ids) ORDER BY r.first)
               FROM (SELECT emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first
                       FROM reactions WHERE message_id = m.id GROUP BY emoji) r) AS reactions,
            (SELECT array_agg(user_id) FROM message_mentions WHERE message_id = m.id) AS mentions,
            EXISTS (SELECT 1 FROM pins p WHERE p.message_id = m.id) AS pinned,
            rm.id AS r_id, rm.deleted_at IS NOT NULL AS r_deleted, rm.body AS r_body,
            ru.id AS r_author_id, ru.display_name AS r_author_name,
            (SELECT count(*)::int FROM attachments a WHERE a.message_id = rm.id) AS r_files
       FROM messages m
       JOIN users u ON u.id = m.author_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.author_id
      WHERE ${where}
      ORDER BY m.id DESC
      ${ids ? '' : 'LIMIT $3'}`,
    params
  );
  return rows.map(shape);
}

function shape(r) {
  return {
    id: r.id,
    channel_id: r.channel_id,
    author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url },
    body: r.body,
    reply_to: r.reply_to_id
      ? r.r_id
        ? {
            id: r.r_id,
            deleted: r.r_deleted,
            author: r.r_deleted ? null : { id: r.r_author_id, display_name: r.r_author_name },
            excerpt: r.r_deleted ? '' : r.r_body.length > EXCERPT ? r.r_body.slice(0, EXCERPT) + '…' : r.r_body,
            files: r.r_files,
          }
        : { id: r.reply_to_id, deleted: true, author: null, excerpt: '', files: 0 }
      : null,
    attachments: (r.attachments || []).map(files.publicAttachment),
    reactions: r.reactions || [],
    mentions: r.mentions || [],
    pinned: r.pinned,
    edited_at: r.edited_at,
    created_at: r.created_at,
  };
}

module.exports = router;
module.exports.loadMessages = loadMessages;
