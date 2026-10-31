'use strict';
// Integration tests for the polling-cost fixes: gzip, ETag/304, secrets
// never leaving the server, lite mode (photos/poster by signature),
// refresh-token cap and the supporting indexes. In-memory MongoDB only.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let BASE;

const PHOTO = 'data:image/jpeg;base64,' + 'P'.repeat(60000);
const PHOTO2 = 'data:image/jpeg;base64,' + 'Q'.repeat(30000);
const POSTER = 'data:image/jpeg;base64,' + 'S'.repeat(90000);

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt';
  process.env.AUTH_RATE_MAX = '1000';
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const d = await db();
  const { hashPassword } = require('../src/auth');
  const hash = await hashPassword('password123');
  await d.collection('admins').insertOne({ _id: 'perf-admin@example.com' });
  await d.collection('users').insertMany([
    { _id: 'perf-admin', uid: 'perf-admin', email: 'perf-admin@example.com', name: 'Admin', status: 'approved', role: 'student', profile: {}, passwordHash: hash, refreshTokens: [] },
    { _id: 'perf-s1', uid: 'perf-s1', email: 'perf-s1@example.com', name: 'Student One', status: 'approved', role: 'student',
      profile: { photo: PHOTO, gender: 'مرد' }, passwordHash: hash, refreshTokens: [], resetTokenHash: 'r', loginTokenHash: 'l' },
    { _id: 'perf-s2', uid: 'perf-s2', email: 'perf-s2@example.com', name: 'Student Two', status: 'approved', role: 'student',
      profile: { photo: 'https://example.com/p.jpg' }, passwordHash: hash, refreshTokens: [] },
    { _id: 'perf-s3', uid: 'perf-s3', email: 'perf-s3@example.com', name: 'Student Three', status: 'pending', role: 'student',
      profile: {}, passwordHash: hash, refreshTokens: [] },
  ]);
  await d.collection('settings').insertOne({
    _id: 'session', title: 'Live', sessionDate: '2026-11-06', when: 'Fri', poster: POSTER, secretCode: 'NEVER', zoomPass: '1432',
  });
  await d.collection('news').insertOne({ _id: 'perf-n1', title: 'News one', date: '2026-10-30' });
});

after(async () => {
  try { if (server) await new Promise((r) => server.close(r)); } catch (e) {}
  try { await require('../src/db').close(); } catch (e) {}
  try { if (mongod) await mongod.stop(); } catch (e) {}
});

async function db() {
  return require('../src/db').getDb();
}

async function call(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: res.status, headers: res.headers, data, bytes: Buffer.byteLength(text) };
}

async function login(email) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

// Raw HTTP GET with exactly the given headers. fetch() cannot be used for
// conditional requests: per the Fetch spec, a manual If-None-Match also
// adds `Cache-Control: no-cache`, which (correctly) disables the 304.
// Browsers revalidating their own cache send If-None-Match alone.
function rawGet(path, headers) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks).length }));
    });
    req.on('error', reject);
  });
}

function assertNoSecrets(u) {
  for (const k of ['passwordHash', 'refreshTokens', 'resetTokenHash', 'loginTokenHash']) {
    assert.equal(k in u, false, `${k} must never be returned (${u._id})`);
  }
}

test('gzip: large JSON responses are compressed when the client accepts it', async () => {
  const { accessToken } = await login('perf-s1@example.com');
  const r = await call('/api/attendance/sessions', { token: accessToken, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.equal(r.data.liveSession.poster, POSTER, 'body decodes to the full payload');
});

test('ETag: an unchanged polled feed answers 304 with no body; a change answers 200', async () => {
  const { accessToken } = await login('perf-s1@example.com');
  const first = await call('/api/content/news?limit=200', { token: accessToken });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag header present');
  const auth = { Authorization: 'Bearer ' + accessToken, 'Accept-Encoding': 'gzip, deflate, br' };
  const again = await rawGet('/api/content/news?limit=200', { ...auth, 'If-None-Match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.bytes, 0);
  const d = await db();
  await d.collection('news').insertOne({ _id: 'perf-n2', title: 'News two', date: '2026-10-31' });
  const changed = await rawGet('/api/content/news?limit=200', { ...auth, 'If-None-Match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, etag);
});

test('ETag never turns a 401 into a 304, and POST responses are not marked cacheable', async () => {
  const r = await rawGet('/api/content/news', { 'If-None-Match': 'W/"anything"' });
  assert.equal(r.status, 401);
  const p = await call('/api/auth/login', { method: 'POST', body: { email: 'perf-s1@example.com', password: 'password123' } });
  assert.equal(p.headers.get('cache-control'), null);
});

test('admin users list: never carries credential fields (full and lite)', async () => {
  const { accessToken } = await login('perf-admin@example.com');
  for (const q of ['', '&lite=1']) {
    const r = await call('/api/admin/users?limit=200' + q, { token: accessToken });
    assert.equal(r.status, 200);
    assert.ok(r.data.docs.length >= 4);
    r.data.docs.forEach(assertNoSecrets);
  }
  const s = await call('/api/admin/users/search?q=Student', { token: accessToken });
  assert.equal(s.status, 200);
  assert.ok(s.data.docs.length >= 3);
  s.data.docs.forEach(assertNoSecrets);
});

test('admin users list: default response is unchanged (photos inline, pending first)', async () => {
  const { accessToken } = await login('perf-admin@example.com');
  const r = await call('/api/admin/users?limit=200', { token: accessToken });
  const s1 = r.data.docs.find((d) => d._id === 'perf-s1');
  assert.equal(s1.profile.photo, PHOTO);
  assert.equal(s1.profile.photoSig, undefined);
  assert.equal(r.data.docs[0].status, 'pending');
  assert.equal(r.data.nextCursor, r.data.docs[r.data.docs.length - 1]._id);
});

test('admin users list lite: photos become signatures; /users/photos returns matching images', async () => {
  const { accessToken } = await login('perf-admin@example.com');
  const full = await call('/api/admin/users?limit=200', { token: accessToken });
  const lite = await call('/api/admin/users?limit=200&lite=1', { token: accessToken });
  assert.equal(lite.status, 200);
  assert.ok(lite.bytes < full.bytes - 50000, `lite ${lite.bytes} vs full ${full.bytes}`);
  assert.deepEqual(lite.data.docs.map((d) => d._id), full.data.docs.map((d) => d._id), 'same docs, same order');
  const s1 = lite.data.docs.find((d) => d._id === 'perf-s1');
  assert.equal(s1.profile.photo, undefined);
  assert.equal(s1.profile.gender, 'مرد');
  const s2 = lite.data.docs.find((d) => d._id === 'perf-s2');
  assert.equal(s2.profile.photo, 'https://example.com/p.jpg', 'URL photos stay inline');
  assert.equal(s2.profile.photoSig, undefined);

  const p = await call('/api/admin/users/photos?ids=perf-s1,perf-s2,missing-id', { token: accessToken });
  assert.equal(p.status, 200);
  assert.equal(p.data.photos['perf-s1'].photo, PHOTO);
  assert.equal(p.data.photos['perf-s1'].photoSig, s1.profile.photoSig);
  assert.equal(p.data.photos['perf-s2'].photoSig, '');
  assert.equal(p.data.photos['missing-id'], undefined);
});

test('/admin/users/photos: validates ids and is admin-only', async () => {
  const admin = (await login('perf-admin@example.com')).accessToken;
  assert.equal((await call('/api/admin/users/photos', { token: admin })).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => 'id' + i).join(',');
  assert.equal((await call('/api/admin/users/photos?ids=' + many, { token: admin })).status, 400);
  const student = (await login('perf-s1@example.com')).accessToken;
  assert.equal((await call('/api/admin/users/photos?ids=perf-s1', { token: student })).status, 403);
});

test('/users/me lite: photo replaced by signature, /me/photo returns it, profileMissing unchanged', async () => {
  const { accessToken } = await login('perf-s1@example.com');
  const full = await call('/api/users/me', { token: accessToken });
  const lite = await call('/api/users/me?lite=1', { token: accessToken });
  assert.equal(full.data.user.profile.photo, PHOTO, 'default /me is unchanged');
  assertNoSecrets(full.data.user);
  assertNoSecrets(lite.data.user);
  assert.equal(lite.data.user.profile.photo, undefined);
  assert.deepEqual(lite.data.profileMissing, full.data.profileMissing);
  const p = await call('/api/users/me/photo', { token: accessToken });
  assert.equal(p.status, 200);
  assert.equal(p.data.photo, PHOTO);
  assert.equal(p.data.photoSig, lite.data.user.profile.photoSig);
});

test('PATCH /me/profile: photoSig is never stored and the response has no secrets', async () => {
  const { accessToken } = await login('perf-s2@example.com');
  const r = await call('/api/users/me/profile', {
    method: 'PATCH', token: accessToken, body: { profile: { photoSig: 'bogus', city: 'Lahore' } },
  });
  assert.equal(r.status, 200);
  assertNoSecrets(r.data.user);
  assert.equal(r.data.user.profile.city, 'Lahore');
  const d = await db();
  const stored = await d.collection('users').findOne({ _id: 'perf-s2' });
  assert.equal(stored.profile.photoSig, undefined);
  assert.equal(stored.profile.photo, 'https://example.com/p.jpg', 'other profile fields untouched');
});

test('/attendance/sessions lite: poster by signature, secrets still stripped, poster endpoint matches', async () => {
  const { accessToken } = await login('perf-s1@example.com');
  const full = await call('/api/attendance/sessions', { token: accessToken });
  const lite = await call('/api/attendance/sessions?lite=1', { token: accessToken });
  assert.equal(full.data.liveSession.poster, POSTER, 'default response is unchanged');
  for (const r of [full, lite]) {
    assert.equal(r.data.liveSession.secretCode, undefined, 'secret codes never reach students');
    assert.equal(r.data.liveSession.zoomPass, '1432');
  }
  assert.equal(lite.data.liveSession.poster, undefined);
  assert.ok(lite.bytes < full.bytes - 80000);
  const p = await call('/api/attendance/session-poster', { token: accessToken });
  assert.equal(p.status, 200);
  assert.equal(p.data.poster, POSTER);
  assert.equal(p.data.posterSig, lite.data.liveSession.posterSig);
});

test('/attendance/session-poster: approved students and admins only', async () => {
  const pending = (await login('perf-s3@example.com')).accessToken;
  assert.equal((await call('/api/attendance/session-poster', { token: pending })).status, 403);
  const admin = (await login('perf-admin@example.com')).accessToken;
  assert.equal((await call('/api/attendance/session-poster', { token: admin })).status, 200);
});

test('admin settings/session: lite read; PUT never stores posterSig and keeps the poster', async () => {
  const { accessToken } = await login('perf-admin@example.com');
  const lite = await call('/api/admin/settings/session?lite=1', { token: accessToken });
  assert.equal(lite.status, 200);
  assert.equal(lite.data.session.poster, undefined);
  assert.ok(lite.data.session.posterSig);
  const full = await call('/api/admin/settings/session', { token: accessToken });
  assert.equal(full.data.session.poster, POSTER);
  const put = await call('/api/admin/settings/session', {
    method: 'PUT', token: accessToken,
    body: { session: { ...lite.data.session, title: 'Live (edited)' } },
  });
  assert.equal(put.status, 200);
  const d = await db();
  const stored = await d.collection('settings').findOne({ _id: 'session' });
  assert.equal(stored.title, 'Live (edited)');
  assert.equal(stored.poster, POSTER, 'poster survives an edit that did not send it');
  assert.equal(stored.posterSig, undefined);
});

test('refresh tokens: only the newest 10 are kept; the newest still refreshes, the oldest is revoked', async () => {
  const sessions = [];
  for (let i = 0; i < 12; i++) sessions.push(await login('perf-s2@example.com'));
  const d = await db();
  const u = await d.collection('users').findOne({ _id: 'perf-s2' });
  assert.equal(u.refreshTokens.length, 10);
  const newest = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: sessions[11].refreshToken } });
  assert.equal(newest.status, 200);
  const oldest = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: sessions[0].refreshToken } });
  assert.equal(oldest.status, 401);
});

test('indexes: refresh-token hash lookups and newest-first notifications are indexed', async () => {
  const d = await db();
  const keys = async (c) => (await d.collection(c).indexes()).map((i) => JSON.stringify(i.key));
  assert.ok((await keys('users')).includes('{"refreshTokens.hash":1}'));
  assert.ok((await keys('admins')).includes('{"refreshTokens.hash":1}'));
  assert.ok((await keys('notifications')).includes('{"email":1,"createdAt":-1}'));
});
