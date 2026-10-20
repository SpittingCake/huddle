// End-to-end auth test against a real Postgres. Needs DATABASE_URL pointing at
// an EMPTY test database (it runs migrations and bootstraps an owner).
//   DATABASE_URL=postgres://.../huddle_test JWT_SECRET=x OWNER_USERNAME=t OWNER_PASSWORD=testpassword1 npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  console.log('skipping auth.test.js — DATABASE_URL not set');
  process.exit(0);
}
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.OWNER_USERNAME ||= 'owner';
process.env.OWNER_PASSWORD ||= 'ownerpassword1';
process.env.PORT = '0';

let base, token, server, db;

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

test('wrong password is rejected', async () => {
  const r = await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: 'nope-nope-nope' } });
  assert.equal(r.status, 401);
});

test('owner can log in and /me works', async () => {
  const r = await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD, device_label: 'test' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'owner');
  token = r.json.token;
  const me = await call('/auth/me', { auth: token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, process.env.OWNER_USERNAME);
});

test('server payload has the bootstrap channels', async () => {
  const r = await call('/api/server', { auth: token });
  assert.equal(r.status, 200);
  assert.equal(r.json.server.name, process.env.SERVER_NAME || 'Huddle');
  assert.deepEqual(r.json.channels.map((c) => c.name), ['general', 'Lobby']);
});

test('register needs a valid invite, then works', async () => {
  const bad = await call('/auth/register', { method: 'POST', body: { invite: 'nope', username: 'friend', password: 'friendpassword1' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_invite');

  const inv = await call('/api/server/invites', { method: 'POST', auth: token, body: { max_uses: 1 } });
  assert.equal(inv.status, 201);
  const code = inv.json.invite.code;

  const short = await call('/auth/register', { method: 'POST', body: { invite: code, username: 'friend', password: 'short' } });
  assert.equal(short.json.error, 'password_too_short');

  const ok = await call('/auth/register', { method: 'POST', body: { invite: code, username: 'friend', password: 'friendpassword1', display_name: 'Friend' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.role, 'member');

  const used = await call('/auth/register', { method: 'POST', body: { invite: code, username: 'friend2', password: 'friendpassword1' } });
  assert.equal(used.json.error, 'invalid_invite', 'max_uses=1 is enforced');

  const notOwner = await call('/api/server/invites', { method: 'POST', auth: ok.json.token, body: {} });
  assert.equal(notOwner.status, 403);
});

test('logout ends only that device', async () => {
  const second = await call('/auth/login', { method: 'POST', body: { username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD, device_label: 'second' } });
  const out = await call('/auth/logout', { method: 'POST', auth: second.json.token });
  assert.equal(out.status, 200);
  assert.equal((await call('/auth/me', { auth: second.json.token })).status, 401);
  assert.equal((await call('/auth/me', { auth: token })).status, 200, 'first device still signed in');
});
