// Batch 3 tests: messages (create / page / reply / edit / delete), mentions +
// unread counts, read markers, reactions, pins, uploads + file serving,
// avatar + server icon. Same setup as the other suites — EMPTY Postgres in
// DATABASE_URL. Uploads go to a temp dir.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.log('skipping messages.test.js — DATABASE_URL not set');
  process.exit(0);
}
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.OWNER_USERNAME ||= 'owner';
process.env.OWNER_PASSWORD ||= 'ownerpassword1';
process.env.SERVER_URL ||= 'http://test.local';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-uploads-'));
process.env.PORT = '0';

let base, owner, member, server, db, general, generalId, voiceId;

before(async () => {
  db = require('../db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  await require('../bootstrap').bootstrap();

  const http = require('http');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../routes/auth'));
  app.use('/api/server', require('../routes/server'));
  app.use('/api/channels', require('../routes/messages'));
  app.use('/api/uploads', require('../routes/uploads'));
  app.use('/api/me', require('../routes/me'));
  app.get('/files/:key', require('../helpers/files').serve);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = (await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD } })).json.token;
  const inv = await call('/api/server/invites', { method: 'POST', auth: owner, body: {} });
  member = (await call('/auth/register', { method: 'POST', body: { invite: inv.json.invite.code, username: 'pal', password: 'palpassword1', display_name: 'Pal' } })).json.token;

  const chans = (await call('/api/server', { auth: owner })).json.channels;
  general = chans.find((c) => c.type === 'text');
  generalId = general.id;
  voiceId = chans.find((c) => c.type === 'voice').id;
});

after(async () => {
  server.close();
  await db.pool.end();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body, auth, form } = {}) {
  const headers = { ...(auth ? { Authorization: `Bearer ${auth}` } : {}) };
  if (!form) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
}
const post = (auth, body, ch = generalId) => call(`/api/channels/${ch}/messages`, { method: 'POST', auth, body });

test('post, list newest page, voice channels refuse messages', async () => {
  const r = await post(owner, { body: 'hello **world**' });
  assert.equal(r.status, 201);
  assert.equal(r.json.message.body, 'hello **world**');
  assert.equal(r.json.message.author.username, 'owner');
  assert.deepEqual(r.json.message.attachments, []);
  assert.deepEqual(r.json.message.reactions, []);
  assert.equal(r.json.message.pinned, false);

  assert.equal((await post(owner, { body: '' })).json.error, 'empty_message');
  assert.equal((await post(owner, { body: 'x'.repeat(2001) })).json.error, 'body_too_long');
  assert.equal((await post(owner, { body: 'hi' }, voiceId)).json.error, 'not_text_channel');
  assert.equal((await call('/api/channels/999999/messages', { auth: owner })).status, 404);

  const list = await call(`/api/channels/${generalId}/messages`, { auth: owner });
  assert.equal(list.status, 200);
  assert.equal(list.json.messages.length, 1);
  assert.equal(list.json.has_more, false);
  assert.equal(list.json.last_read_message_id, r.json.message.id, 'posting marks your own message read');
});

test('paging walks back in pages of N with has_more', async () => {
  for (let i = 1; i <= 7; i++) await post(member, { body: `m${i}` });
  const p1 = await call(`/api/channels/${generalId}/messages?limit=3`, { auth: owner });
  assert.equal(p1.json.messages.length, 3);
  assert.equal(p1.json.has_more, true);
  assert.deepEqual(p1.json.messages.map((m) => m.body), ['m5', 'm6', 'm7']);
  const p2 = await call(`/api/channels/${generalId}/messages?limit=3&before=${p1.json.messages[0].id}`, { auth: owner });
  assert.deepEqual(p2.json.messages.map((m) => m.body), ['m2', 'm3', 'm4']);
  assert.equal(p2.json.has_more, true);
  const p3 = await call(`/api/channels/${generalId}/messages?limit=3&before=${p2.json.messages[0].id}`, { auth: owner });
  assert.deepEqual(p3.json.messages.map((m) => m.body), ['hello **world**', 'm1']);
  assert.equal(p3.json.has_more, false);
});

test('unread + mention counts, and read markers clear them', async () => {
  // Member posted 7 messages; owner has read only their own first one.
  let u = (await call('/api/channels/unread', { auth: owner })).json.channels;
  assert.equal(u[generalId].unread, 7);
  assert.equal(u[generalId].mentions, 0);

  await post(member, { body: 'hey @owner, and @nobody, and @owner. again' });
  await post(member, { body: '@everyone game tonight?' });
  u = (await call('/api/channels/unread', { auth: owner })).json.channels;
  assert.equal(u[generalId].unread, 9);
  assert.equal(u[generalId].mentions, 2, 'one per message, @everyone counts');

  // The member sees nothing unread: posting marks everything before your own message read.
  const um = (await call('/api/channels/unread', { auth: member })).json.channels;
  assert.equal(um[generalId].unread, 0);
  assert.equal(um[generalId].mentions, 0, '@everyone never mentions the author');

  const latest = (await call(`/api/channels/${generalId}/messages?limit=1`, { auth: owner })).json.messages[0];
  assert.equal((await call(`/api/channels/${generalId}/read`, { method: 'POST', auth: owner, body: { last_read_message_id: latest.id } })).status, 200);
  u = (await call('/api/channels/unread', { auth: owner })).json.channels;
  assert.equal(u[generalId].unread, 0);
  assert.equal(u[generalId].mentions, 0);

  // Markers never move backwards.
  await call(`/api/channels/${generalId}/read`, { method: 'POST', auth: owner, body: { last_read_message_id: 1 } });
  assert.equal((await call(`/api/channels/${generalId}/messages`, { auth: owner })).json.last_read_message_id, latest.id);
  assert.equal((await call(`/api/channels/${generalId}/read`, { method: 'POST', auth: owner, body: { last_read_message_id: 'x' } })).status, 400);
});

test('reply carries an excerpt; deleting the target keeps the reply honest', async () => {
  const target = (await post(member, { body: 'reply to me ' + 'x'.repeat(200) })).json.message;
  const reply = (await post(owner, { body: 'ok', reply_to_id: target.id })).json.message;
  assert.equal(reply.reply_to.id, target.id);
  assert.equal(reply.reply_to.author.display_name, 'Pal');
  assert.ok(reply.reply_to.excerpt.endsWith('…') && reply.reply_to.excerpt.length <= 121);
  assert.equal(reply.reply_to.deleted, false);

  assert.equal((await post(owner, { body: 'x', reply_to_id: 999999 })).json.error, 'bad_reply');

  // Member deletes their own; the reply now shows "deleted".
  assert.equal((await call(`/api/channels/${generalId}/messages/${target.id}`, { method: 'DELETE', auth: member })).status, 200);
  const again = (await call(`/api/channels/${generalId}/messages?limit=1`, { auth: owner })).json.messages[0];
  assert.equal(again.id, reply.id);
  assert.equal(again.reply_to.deleted, true);
  assert.equal(again.reply_to.author, null);
  assert.equal((await call(`/api/channels/${generalId}/messages/${target.id}`, { method: 'DELETE', auth: member })).status, 404, 'already gone');
});

test('edit is author-only; delete is author or owner', async () => {
  const m = (await post(member, { body: 'typo' })).json.message;
  assert.equal((await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'PATCH', auth: owner, body: { body: 'nope' } })).status, 403, 'owner cannot edit others');
  const e = await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'PATCH', auth: member, body: { body: 'fixed @owner' } });
  assert.equal(e.status, 200);
  assert.equal(e.json.message.body, 'fixed @owner');
  assert.ok(e.json.message.edited_at);
  assert.equal(e.json.message.mentions.length, 1, 'mentions re-parsed on edit');
  assert.equal((await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'PATCH', auth: member, body: { body: '' } })).json.error, 'empty_message');

  const o = (await post(owner, { body: 'mine' })).json.message;
  assert.equal((await call(`/api/channels/${generalId}/messages/${o.id}`, { method: 'DELETE', auth: member })).status, 403, 'member cannot delete owner');
  assert.equal((await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'DELETE', auth: owner })).status, 200, 'owner can delete anyone');
});

test('reactions toggle per user and validate emoji', async () => {
  const m = (await post(owner, { body: 'react' })).json.message;
  const url = (e) => `/api/channels/${generalId}/messages/${m.id}/reactions/${encodeURIComponent(e)}`;
  let r = await call(url('👍'), { method: 'PUT', auth: owner });
  assert.equal(r.status, 200);
  r = await call(url('👍'), { method: 'PUT', auth: member });
  await call(url('👍'), { method: 'PUT', auth: member }); // idempotent
  r = await call(url('🎉'), { method: 'PUT', auth: member });
  assert.deepEqual(r.json.reactions.map((x) => [x.emoji, x.user_ids.length]), [['👍', 2], ['🎉', 1]]);
  r = await call(url('👍'), { method: 'DELETE', auth: owner });
  assert.deepEqual(r.json.reactions.map((x) => [x.emoji, x.user_ids.length]), [['👍', 1], ['🎉', 1]]);
  assert.equal((await call(url('abc'), { method: 'PUT', auth: owner })).json.error, 'bad_emoji');
  assert.equal((await call(url('<script>'), { method: 'PUT', auth: owner })).json.error, 'bad_emoji');
  assert.equal((await call(url('👍🏽'), { method: 'PUT', auth: owner })).status, 200, 'skin tone ok');
  assert.equal((await call(url('🏳️‍🌈'), { method: 'PUT', auth: owner })).status, 200, 'ZWJ sequence ok');
  const listed = (await call(`/api/channels/${generalId}/messages?limit=1`, { auth: owner })).json.messages[0];
  assert.equal(listed.reactions.length, 4);
});

test('pins: anyone can pin, list is newest first, delete unpins', async () => {
  const a = (await post(owner, { body: 'pin a' })).json.message;
  const b = (await post(member, { body: 'pin b' })).json.message;
  assert.deepEqual((await call(`/api/channels/${generalId}/pins/${a.id}`, { method: 'PUT', auth: member })).json, { pinned: true, count: 1 });
  assert.deepEqual((await call(`/api/channels/${generalId}/pins/${b.id}`, { method: 'PUT', auth: owner })).json, { pinned: true, count: 2 });
  let pins = (await call(`/api/channels/${generalId}/pins`, { auth: member })).json.messages;
  assert.deepEqual(pins.map((m) => m.body), ['pin b', 'pin a']);
  assert.equal(pins[0].pinned, true);
  assert.deepEqual((await call(`/api/channels/${generalId}/pins/${a.id}`, { method: 'DELETE', auth: owner })).json, { pinned: false, count: 1 });
  await call(`/api/channels/${generalId}/messages/${b.id}`, { method: 'DELETE', auth: member });
  pins = (await call(`/api/channels/${generalId}/pins`, { auth: member })).json.messages;
  assert.equal(pins.length, 0);
});

test('uploads: images inline, files as downloads, blocked types rejected, link to message', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('files', new Blob([png], { type: 'image/png' }), 'dot.png');
  form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes é.txt');
  const up = await call('/api/uploads', { method: 'POST', auth: member, form });
  assert.equal(up.status, 201);
  assert.equal(up.json.attachments.length, 2);
  const [img, txt] = up.json.attachments;
  assert.equal(img.image, true);
  assert.equal(txt.image, false);
  assert.equal(txt.mime, 'application/octet-stream', 'non-images are never served with a sniffable type');
  assert.match(img.url, /^\/files\/[a-f0-9]{32}\.png$/);

  const imgRes = await fetch(base + img.url);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('content-type'), 'image/png');
  assert.match(imgRes.headers.get('content-disposition'), /^inline; filename="dot.png"/);
  assert.equal(imgRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await imgRes.arrayBuffer()).byteLength, png.length);

  const txtRes = await fetch(base + txt.url);
  assert.match(txtRes.headers.get('content-disposition'), /^attachment; filename="notes _.txt"; filename\*=UTF-8''notes%20%C3%A9.txt$/);
  assert.equal(await txtRes.text(), 'hello');
  assert.equal((await fetch(base + '/files/' + 'a'.repeat(32) + '.png')).status, 404);
  assert.equal((await fetch(base + '/files/..%2Fdb.js')).status, 404);

  const bad = new FormData();
  bad.append('files', new Blob(['MZ'], { type: 'application/octet-stream' }), 'game.exe');
  assert.equal((await call('/api/uploads', { method: 'POST', auth: member, form: bad })).json.error, 'blocked_type');
  assert.equal((await call('/api/uploads', { method: 'POST', auth: member, form: new FormData() })).status, 400);

  // Only the uploader can attach their uploads, and only once.
  assert.equal((await post(owner, { body: 'steal', attachment_ids: [img.id] })).json.error, 'bad_attachment');
  const m = (await post(member, { body: '', attachment_ids: [img.id, txt.id] })).json.message;
  assert.equal(m.attachments.length, 2);
  assert.equal(m.attachments[0].filename, 'dot.png');
  assert.equal((await post(member, { body: 'again', attachment_ids: [img.id] })).json.error, 'bad_attachment');

  // Editing an attachment-only message to empty body is fine (files remain).
  assert.equal((await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'PATCH', auth: member, body: { body: '' } })).status, 200);
  // Deleting removes the files from disk and the URL.
  await call(`/api/channels/${generalId}/messages/${m.id}`, { method: 'DELETE', auth: member });
  assert.equal((await fetch(base + img.url)).status, 404);
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0, 'disk is clean');
});

test('avatar and server icon upload, replace, remove', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = () => { const f = new FormData(); f.append('file', new Blob([png], { type: 'image/png' }), 'me.png'); return f; };
  const a1 = await call('/api/me/avatar', { method: 'POST', auth: member, form: form() });
  assert.equal(a1.status, 200);
  assert.match(a1.json.avatar_url, /^\/files\//);
  const a2 = await call('/api/me/avatar', { method: 'POST', auth: member, form: form() });
  assert.notEqual(a2.json.avatar_url, a1.json.avatar_url);
  assert.equal((await fetch(base + a1.json.avatar_url)).status, 404, 'old avatar removed');
  assert.equal((await fetch(base + a2.json.avatar_url)).status, 200);
  const members = (await call('/api/server', { auth: owner })).json.members;
  assert.equal(members.find((m) => m.username === 'pal').avatar_url, a2.json.avatar_url);
  const posted = (await post(member, { body: 'with face' })).json.message;
  assert.equal(posted.author.avatar_url, a2.json.avatar_url);
  await call('/api/me/avatar', { method: 'DELETE', auth: member });
  assert.equal((await fetch(base + a2.json.avatar_url)).status, 404);

  const notImg = new FormData();
  notImg.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await call('/api/me/avatar', { method: 'POST', auth: member, form: notImg })).json.error, 'not_image');

  assert.equal((await call('/api/server/icon', { method: 'POST', auth: member, form: form() })).status, 403);
  const icon = await call('/api/server/icon', { method: 'POST', auth: owner, form: form() });
  assert.equal(icon.status, 200);
  assert.equal((await call('/api/server', { auth: owner })).json.server.icon_url, icon.json.icon_url);
  await call('/api/server/icon', { method: 'DELETE', auth: owner });
  assert.equal((await call('/api/server', { auth: owner })).json.server.icon_url, null);

  const n = await call('/api/me', { method: 'PATCH', auth: member, body: { display_name: '  Pal  the  Great ' } });
  assert.equal(n.json.user.display_name, 'Pal the Great');
  assert.equal((await call('/api/me', { method: 'PATCH', auth: member, body: { display_name: '' } })).json.error, 'bad_name');
});
