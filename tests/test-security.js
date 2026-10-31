'use strict';
// Hardening: async errors no longer crash the process, per-visitor rate
// limiting behind Render's proxy, safe profile values (no script in photo
// src / names), admin-owned decision fields, strict ids and emails.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let BASE;
let auth;

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt';
  process.env.AUTH_RATE_MAX = '1000';
  const app = require('../src/app');
  auth = require('../src/auth');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const d = await db();
  await d.collection('users').insertMany([
    { _id: 'u_a', email: 'a@example.com', name: 'A', status: 'approved', role: 'student', profile: {}, refreshTokens: [] },
    { _id: 'u_b', email: 'b@example.com', name: 'B', status: 'approved', role: 'student', profile: {}, refreshTokens: [] },
  ]);
});

after(async () => {
  try { if (server) await new Promise((r) => server.close(r)); } catch (e) {}
  try { await require('../src/db').close(); } catch (e) {}
  try { if (mongod) await mongod.stop(); } catch (e) {}
});

async function db() {
  return require('../src/db').getDb();
}

function tokenFor(id, email) {
  return auth.signAccessToken({ _id: id, email, role: 'student', status: 'approved' });
}

async function call(path, { method = 'GET', body, as, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (as) h.Authorization = `Bearer ${tokenFor(as, `${as.slice(2)}@example.com`)}`;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers: h,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
    // An unhandled async error leaves the request unanswered; fail instead of hanging.
    signal: AbortSignal.timeout(10000),
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, headers: res.headers };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a failed async write answers 409 and the server keeps running', async () => {
  const mine = await call('/api/users/me/drafts', { method: 'POST', as: 'u_a', body: { doc: { id: 'draft1', title: 'mine' } } });
  assert.equal(mine.status, 201);
  // Same id from another student: the insert collides on _id. Before the
  // fix this rejection escaped Express and terminated the process.
  const clash = await call('/api/users/me/drafts', { method: 'POST', as: 'u_b', body: { doc: { id: 'draft1', title: 'not yours' } } });
  assert.equal(clash.status, 409);
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  const stored = await (await db()).collection('drafts').findOne({ _id: 'draft1' });
  assert.equal(stored.email, 'a@example.com');
  assert.equal(stored.title, 'mine', 'the other student cannot overwrite it');
});

test('malformed JSON is a 400, not a 500', async () => {
  const r = await call('/api/auth/login', { method: 'POST', raw: '{"email":' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_json');
});

test('rate limit is per visitor behind the proxy; refresh and logout are not counted', async () => {
  const hit = (ip) => call('/api/auth/login', { method: 'POST', body: { email: 'x@example.com', password: 'whatever1' }, headers: { 'X-Forwarded-For': ip } });
  const a1 = await hit('203.0.113.1');
  const a2 = await hit('203.0.113.1');
  const b1 = await hit('203.0.113.2');
  const rem = (r) => Number(r.headers.get('ratelimit-remaining'));
  assert.equal(rem(a2), rem(a1) - 1, 'same visitor shares a bucket');
  assert.equal(rem(b1), rem(a1), 'another visitor has their own bucket');
  const refresh = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: 'nope' }, headers: { 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(refresh.status, 401);
  assert.equal(refresh.headers.get('ratelimit-remaining'), null, 'refresh is not rate-limited');
  const a3 = await hit('203.0.113.1');
  assert.equal(rem(a3), rem(a2) - 1, 'refresh did not consume an attempt');
});

test('profile: script in the photo is refused, a real image is stored', async () => {
  const evil = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body: { profile: { photo: 'x" onerror="alert(1)' } } });
  assert.equal(evil.status, 400);
  assert.equal(evil.json.error.code, 'bad_photo');
  const svg = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body: { profile: { photo: 'data:image/svg+xml;base64,PHN2Zz4=' } } });
  assert.equal(svg.status, 400, 'SVG can carry script and is not accepted');
  const ok = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body: { profile: { photo: PNG, roll: '12', skills: ['تدریس'] } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.profile.photo, PNG);
  const cleared = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body: { profile: { photo: '' } } });
  assert.equal(cleared.status, 200, 'removing the photo is allowed');
});

test('profile: HTML characters, odd keys and nested objects are refused; apostrophes are fine', async () => {
  const cases = [
    { name: '<img src=x onerror=alert(1)>' },
    { madrasa: 'x" onmouseover="alert(1)' },
    { profile: { linkedin: 'https://x.com/"><script>' } },
    { profile: { 'a.b': 'x' } },
    { profile: { $set: 'x' } },
    { profile: { roll: { $gt: '' } } },
    { profile: { skills: ['ok', { bad: 1 }] } },
    { name: { first: 'A' } },
  ];
  for (const body of cases) {
    const r = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const ok = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_a', body: { name: 'محمد علی', madrasa: "Jami'a Ashrafia" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.madrasa, "Jami'a Ashrafia");
});

test('profile: status/role/email in the profile object are still ignored', async () => {
  const r = await call('/api/users/me/profile', { method: 'PATCH', as: 'u_b', body: { profile: { status: 'x', role: 'admin', roll: '7' } } });
  assert.equal(r.status, 200);
  const u = await (await db()).collection('users').findOne({ _id: 'u_b' });
  assert.equal(u.role, 'student');
  assert.equal(u.status, 'approved');
  assert.equal(u.profile.status, undefined);
  assert.equal(u.profile.roll, '7');
});

test('a student cannot approve their own transfer; the admin verdict survives a re-send', async () => {
  const sent = await call('/api/users/me/transfers', { method: 'POST', as: 'u_a', body: { doc: { id: 'tr1', uni: 'PU', status: 'منظور شدہ', email: 'b@example.com' } } });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.doc.status, 'زیرِ غور', 'new transfers always start pending');
  assert.equal(sent.json.doc.email, 'a@example.com', 'email comes from the login, not the body');
  const d = await db();
  await d.collection('transfers').updateOne({ _id: 'tr1' }, { $set: { status: 'مسترد' } }); // admin decision
  const resend = await call('/api/users/me/transfers', { method: 'POST', as: 'u_a', body: { doc: { id: 'tr1', uni: 'PU', status: 'منظور شدہ' } } });
  assert.equal(resend.status, 201);
  assert.equal(resend.json.doc.status, 'مسترد', "the admin's verdict is kept");
});

test('a student cannot mark their competition entry as winner', async () => {
  const r = await call('/api/users/me/competitions', { method: 'POST', as: 'u_b', body: { doc: { id: 'cmp1', title: 'T', status: 'فاتح', position: 1, decidedAt: 'x' } } });
  assert.equal(r.status, 201);
  assert.equal(r.json.doc.status, 'زیرِ غور');
  assert.equal(r.json.doc.position, undefined);
  assert.equal(r.json.doc.decidedAt, undefined);
});

test('own writes: object ids and unsafe keys are refused', async () => {
  const objId = await call('/api/users/me/messages', { method: 'POST', as: 'u_a', body: { doc: { id: { $gt: '' }, txt: 'hi' } } });
  assert.equal(objId.status, 400);
  const badKey = await call('/api/users/me/messages', { method: 'POST', as: 'u_a', body: { doc: { $where: '1', txt: 'hi' } } });
  assert.equal(badKey.status, 400);
  const ok = await call('/api/users/me/messages', { method: 'POST', as: 'u_a', body: { doc: { txt: 'hi', topic: 't' } } });
  assert.equal(ok.status, 201);
});

test('registration: emails with quotes and names with HTML are refused', async () => {
  const q = await call('/api/auth/register', { method: 'POST', body: { email: "a'+alert(1)+'@x.co", password: 'password123' } });
  assert.equal(q.status, 400);
  assert.equal(q.json.error.code, 'bad_email');
  const n = await call('/api/auth/register', { method: 'POST', body: { email: 'new1@example.com', password: 'password123', name: '<b>x</b>' } });
  assert.equal(n.status, 400);
  const rr = await call('/api/auth/re-register', { method: 'POST', body: { email: 'new2@example.com', password: 'password123', name: '"x' } });
  assert.equal(rr.status, 400);
  const ok = await call('/api/auth/register', { method: 'POST', body: { email: 'new3@example.com', password: 'password123', name: 'نیا طالب علم' } });
  assert.equal(ok.status, 201);
});

test('attendance: a non-text session id is refused', async () => {
  const reg = await call('/api/attendance/register', { method: 'POST', as: 'u_a', body: { sessionId: { $ne: null } } });
  assert.equal(reg.status, 400);
  const dotted = await call('/api/attendance/register', { method: 'POST', as: 'u_a', body: { sessionId: 'a.b' } });
  assert.equal(dotted.status, 400);
  const claim = await call('/api/attendance/claim', { method: 'POST', as: 'u_a', body: { sessionId: 'idara-b1-s1', code: { $ne: null } } });
  assert.equal(claim.status, 403);
});

test('push tokens: newest 10 per student, oversized refused', async () => {
  for (let i = 0; i < 13; i++) {
    const r = await call('/api/users/me/push-token', { method: 'POST', as: 'u_b', body: { token: `tok${i}` } });
    assert.equal(r.status, 200);
  }
  await call('/api/users/me/push-token', { method: 'POST', as: 'u_b', body: { token: 'tok5' } });
  const u = await (await db()).collection('users').findOne({ _id: 'u_b' });
  assert.equal(u.fcmTokens.length, 10);
  assert.equal(u.fcmTokens[9], 'tok5', 're-registering moves a token to the newest slot');
  const big = await call('/api/users/me/push-token', { method: 'POST', as: 'u_b', body: { token: 'x'.repeat(5000) } });
  assert.equal(big.status, 400);
});
