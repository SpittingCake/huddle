// Batch 2 tests: server name, channel + category CRUD, reorder, owner-only
// guards, the last-text-channel rule, and the public invite preview.
// Same setup as auth.test.js — needs an EMPTY Postgres in DATABASE_URL.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  console.log('skipping channels.test.js — DATABASE_URL not set');
  process.exit(0);
}
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.OWNER_USERNAME ||= 'owner';
process.env.OWNER_PASSWORD ||= 'ownerpassword1';
process.env.SERVER_URL ||= 'http://test.local';
process.env.PORT = '0';

let base, owner, member, server, db;

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
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = (await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD } })).json.token;
  const inv = await call('/api/server/invites', { method: 'POST', auth: owner, body: {} });
  member = (await call('/auth/register', { method: 'POST', body: { invite: inv.json.invite.code, username: 'pal', password: 'palpassword1' } })).json.token;
});

after(async () => {
  server.close();
  await db.pool.end();
});

async function call(path, { method = 'GET', body, auth } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('public invite preview reports server name and validity', async () => {
  const bad = await call('/auth/invite/nope');
  assert.equal(bad.status, 200);
  assert.equal(bad.json.valid, false);
  assert.equal(bad.json.server_name, 'Huddle');

  const inv = await call('/api/server/invites', { method: 'POST', auth: owner, body: { max_uses: 1 } });
  assert.equal(inv.json.invite.url, `http://test.local/invite/${inv.json.invite.code}`);
  const good = await call(`/auth/invite/${inv.json.invite.code}`);
  assert.equal(good.json.valid, true);
});

test('owner can rename the server; members cannot', async () => {
  const no = await call('/api/server', { method: 'PATCH', auth: member, body: { name: 'Nope' } });
  assert.equal(no.status, 403);
  const yes = await call('/api/server', { method: 'PATCH', auth: owner, body: { name: '  Game  Night ' } });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.server.name, 'Game Night');
  const empty = await call('/api/server', { method: 'PATCH', auth: owner, body: { name: '   ' } });
  assert.equal(empty.json.error, 'bad_name');
});

test('channel create: text names are slugged, voice names kept, members blocked', async () => {
  assert.equal((await call('/api/server/channels', { method: 'POST', auth: member, body: { type: 'text', name: 'x' } })).status, 403);

  const t = await call('/api/server/channels', { method: 'POST', auth: owner, body: { type: 'text', name: 'Elden Ring Chat!' } });
  assert.equal(t.status, 201);
  assert.equal(t.json.channel.name, 'elden-ring-chat');
  assert.equal(t.json.channel.category_id, null);

  const v = await call('/api/server/channels', { method: 'POST', auth: owner, body: { type: 'voice', name: 'Late Night' } });
  assert.equal(v.json.channel.name, 'Late Night');
  assert.ok(v.json.channel.position > t.json.channel.position, 'appended after');

  assert.equal((await call('/api/server/channels', { method: 'POST', auth: owner, body: { type: 'video', name: 'x' } })).json.error, 'bad_type');
  assert.equal((await call('/api/server/channels', { method: 'POST', auth: owner, body: { type: 'text', name: '!!!' } })).json.error, 'bad_name');
});

test('categories: create, assign channels, rename, delete keeps channels', async () => {
  const cat = await call('/api/server/categories', { method: 'POST', auth: owner, body: { name: 'Games' } });
  assert.equal(cat.status, 201);
  const catId = cat.json.category.id;

  const chans = (await call('/api/server', { auth: owner })).json.channels;
  const elden = chans.find((c) => c.name === 'elden-ring-chat');
  const moved = await call(`/api/server/channels/${elden.id}`, { method: 'PATCH', auth: owner, body: { category_id: catId } });
  assert.equal(moved.json.channel.category_id, catId);

  const badCat = await call(`/api/server/channels/${elden.id}`, { method: 'PATCH', auth: owner, body: { category_id: 9999 } });
  assert.equal(badCat.json.error, 'bad_category');

  const renamed = await call(`/api/server/categories/${catId}`, { method: 'PATCH', auth: owner, body: { name: 'Gaming' } });
  assert.equal(renamed.json.category.name, 'Gaming');

  const del = await call(`/api/server/categories/${catId}`, { method: 'DELETE', auth: owner });
  assert.equal(del.status, 200);
  const after = (await call('/api/server', { auth: owner })).json;
  assert.equal(after.categories.length, 0);
  assert.ok(after.channels.find((c) => c.id === elden.id), 'channel survives category delete');
  assert.equal(after.channels.find((c) => c.id === elden.id).category_id, null);
});

test('rename channel and reorder', async () => {
  const chans = (await call('/api/server', { auth: owner })).json.channels;
  const elden = chans.find((c) => c.name === 'elden-ring-chat');
  const r = await call(`/api/server/channels/${elden.id}`, { method: 'PATCH', auth: owner, body: { name: 'Elden Ring' } });
  assert.equal(r.json.channel.name, 'elden-ring');

  const reversed = chans.map((c) => c.id).reverse();
  const ord = await call('/api/server/channels/order', { method: 'PUT', auth: owner, body: { ids: reversed } });
  assert.equal(ord.status, 200);
  const now = (await call('/api/server', { auth: owner })).json.channels.map((c) => c.id);
  assert.deepEqual(now, reversed);

  assert.equal((await call('/api/server/channels/order', { method: 'PUT', auth: member, body: { ids: reversed } })).status, 403);
  assert.equal((await call('/api/server/channels/order', { method: 'PUT', auth: owner, body: { ids: ['a'] } })).status, 400);
});

test('delete channels, but never the last text channel', async () => {
  const chans = (await call('/api/server', { auth: owner })).json.channels;
  const voice = chans.find((c) => c.name === 'Late Night');
  assert.equal((await call(`/api/server/channels/${voice.id}`, { method: 'DELETE', auth: member })).status, 403);
  assert.equal((await call(`/api/server/channels/${voice.id}`, { method: 'DELETE', auth: owner })).status, 200);

  const texts = chans.filter((c) => c.type === 'text');
  assert.equal(texts.length, 2);
  assert.equal((await call(`/api/server/channels/${texts[0].id}`, { method: 'DELETE', auth: owner })).status, 200);
  const last = await call(`/api/server/channels/${texts[1].id}`, { method: 'DELETE', auth: owner });
  assert.equal(last.status, 400);
  assert.equal(last.json.error, 'last_text_channel');

  assert.equal((await call('/api/server/channels/999999', { method: 'DELETE', auth: owner })).status, 404);
});

test('invite list is owner-only and shows creator + url', async () => {
  assert.equal((await call('/api/server/invites', { auth: member })).status, 403);
  const list = await call('/api/server/invites', { auth: owner });
  assert.equal(list.status, 200);
  assert.ok(list.json.invites.length >= 2);
  assert.ok(list.json.invites[0].url.includes('/invite/'));
  assert.equal(list.json.invites[0].created_by_name, process.env.OWNER_USERNAME);
  const code = list.json.invites[0].code;
  assert.equal((await call(`/api/server/invites/${code}`, { method: 'DELETE', auth: owner })).status, 200);
  assert.equal((await call(`/auth/invite/${code}`)).json.valid, false);
});
