'use strict';
// Notifications: date parsing, exactly-once that survives expiry, backfill
// of older records, the 20-day TTL index, and newest-first ordering.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let BASE;

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt';
  process.env.AUTH_RATE_MAX = '1000';
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { if (server) await new Promise((r) => server.close(r)); } catch (e) {}
  try { await require('../src/db').close(); } catch (e) {}
  try { if (mongod) await mongod.stop(); } catch (e) {}
});

const notify = require('../src/lib/notify');

async function db() {
  return require('../src/db').getDb();
}

test('parseNotifDate: ISO, day-first slashes and Urdu dates (Urdu digits too)', () => {
  assert.equal(notify.parseNotifDate('2026-10-28T19:35:36.947Z').toISOString(), '2026-10-28T19:35:36.947Z');
  // Karachi midnight = 19:00 UTC the previous day.
  assert.equal(notify.parseNotifDate('26/10/2026').toISOString(), '2026-10-25T19:00:00.000Z');
  assert.equal(notify.parseNotifDate('۲۴ اکتوبر ۲۰۲۶').toISOString(), '2026-10-23T19:00:00.000Z');
  assert.equal(notify.parseNotifDate('3 نومبر 2026').toISOString(), '2026-11-02T19:00:00.000Z');
  assert.equal(notify.parseNotifDate('10/26/2026').toISOString(), '2026-10-25T19:00:00.000Z', 'month-first only when unambiguous');
  for (const bad of ['', 'کل', null, undefined, 42, '99/99/2026', '24 Blah 2026']) {
    assert.equal(notify.parseNotifDate(bad), null, String(bad));
  }
});

test('notifyOnce: creates once with createdAt; a deleted notification is never re-sent', async () => {
  const d = await db();
  const doc = { id: 'n-once', email: 'Once@Example.com', title: 'T', body: 'B', date: '۲۴ اکتوبر ۲۰۲۶', read: false };
  assert.equal(await notify.notifyOnce(d, doc), true);
  assert.equal(await notify.notifyOnce(d, doc), false, 'second call is a no-op');
  const stored = await d.collection('notifications').findOne({ id: 'n-once' });
  assert.equal(stored._id, 'n-once');
  assert.equal(stored.email, 'once@example.com');
  assert.equal(stored.date, '۲۴ اکتوبر ۲۰۲۶', 'display date kept verbatim');
  assert.ok(stored.createdAt instanceof Date);
  await d.collection('notifications').deleteOne({ id: 'n-once' }); // what the TTL monitor does
  assert.equal(await notify.notifyOnce(d, doc), false, 'expiry must not cause a re-send');
  assert.equal(await d.collection('notifications').countDocuments({ id: 'n-once' }), 0);
});

test('TTL index: createdAt expires after 20 days; a changed setting is applied in place', async () => {
  const d = await db();
  const ttl = (await d.collection('notifications').indexes()).find((i) => i.name === 'createdAt_ttl');
  assert.ok(ttl, 'TTL index exists');
  assert.deepEqual(ttl.key, { createdAt: 1 });
  assert.equal(ttl.expireAfterSeconds, 20 * 86400);
  await d.command({ collMod: 'notifications', index: { name: 'createdAt_ttl', expireAfterSeconds: 60 } });
  await notify.ensureNotificationIndexes(d);
  const again = (await d.collection('notifications').indexes()).find((i) => i.name === 'createdAt_ttl');
  assert.equal(again.expireAfterSeconds, 20 * 86400, 'restored to the configured value');
});

test('backfill: older notifications get createdAt from their date + a marker; idempotent', async () => {
  const d = await db();
  await d.collection('notifications').insertMany([
    { _id: 'old-urdu', id: 'old-urdu', email: 'bf@example.com', title: 'a', date: '۲۴ اکتوبر ۲۰۲۶', read: false },
    { _id: 'old-slash', id: 'old-slash', email: 'bf@example.com', title: 'b', date: '26/10/2026', read: true },
    { _id: 'old-iso', id: 'old-iso', email: 'bf@example.com', title: 'c', date: '2026-10-28T10:00:00.000Z', read: false },
    { _id: 'old-junk', id: 'old-junk', email: 'bf@example.com', title: 'd', date: 'کل', read: false },
  ]);
  const before = Date.now();
  const r = await notify.backfillNotifications(d);
  assert.ok(r.updated >= 4);
  const get = async (id) => d.collection('notifications').findOne({ _id: id });
  assert.equal((await get('old-urdu')).createdAt.toISOString(), '2026-10-23T19:00:00.000Z');
  assert.equal((await get('old-slash')).createdAt.toISOString(), '2026-10-25T19:00:00.000Z');
  assert.equal((await get('old-iso')).createdAt.toISOString(), '2026-10-28T10:00:00.000Z');
  assert.ok((await get('old-junk')).createdAt.getTime() >= before, 'unparseable date -> now');
  assert.equal((await get('old-urdu')).date, '۲۴ اکتوبر ۲۰۲۶', 'display date untouched');
  assert.equal(await d.collection('notificationLog').countDocuments({ _id: /^bf@example\.com\|/ }), 4);
  assert.equal((await notify.backfillNotifications(d)).updated, 0, 'second run changes nothing');
  assert.equal(await notify.notifyOnce(d, { id: 'old-urdu', email: 'bf@example.com', title: 'a' }), false);
});

test('GET /notifications: newest first by createdAt across mixed date formats', async () => {
  const d = await db();
  const { hashPassword } = require('../src/auth');
  await d.collection('users').insertOne({
    _id: 'nt-1', uid: 'nt-1', email: 'bf@example.com', name: 'N', status: 'approved', role: 'student',
    profile: {}, passwordHash: await hashPassword('password123'), refreshTokens: [],
  });
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bf@example.com', password: 'password123' }),
  });
  const { accessToken } = await login.json();
  const r = await fetch(BASE + '/api/notifications?limit=200', { headers: { Authorization: 'Bearer ' + accessToken } });
  const { docs } = await r.json();
  assert.deepEqual(docs.map((n) => n.id), ['old-junk', 'old-iso', 'old-slash', 'old-urdu']);
});

test('course seed: a launch invite deleted by expiry is not re-sent on the next hourly run', async () => {
  const d = await db();
  await d.collection('users').insertOne({
    _id: 'cs-1', uid: 'cs-1', email: 'cs-1@example.com', name: 'PhD', status: 'approved', role: 'student',
    profile: { eduStatus: 'پی ایچ ڈی مکمل ہے' },
  });
  const course = require('../src/lib/course');
  const first = await course.seedCourseBatch(d);
  assert.ok(first.notified >= 1);
  assert.equal(await d.collection('notifications').countDocuments({ id: 'course-b1-launch-cs-1' }), 1);
  await d.collection('notifications').deleteOne({ id: 'course-b1-launch-cs-1' });
  const second = await course.seedCourseBatch(d);
  assert.equal(second.notified, 0);
  assert.equal(await d.collection('notifications').countDocuments({ id: 'course-b1-launch-cs-1' }), 0);
});

test('admin decision notification: once, with createdAt, and not re-sent after expiry', async () => {
  const d = await db();
  const { hashPassword } = require('../src/auth');
  await d.collection('admins').insertOne({ _id: 'nt-admin@example.com' });
  const hash = await hashPassword('password123');
  await d.collection('users').insertMany([
    { _id: 'nt-admin', uid: 'nt-admin', email: 'nt-admin@example.com', name: 'A', status: 'approved', role: 'student', profile: {}, passwordHash: hash, refreshTokens: [] },
    { _id: 'nt-pend', uid: 'nt-pend', email: 'nt-pend@example.com', name: 'P', status: 'pending', role: 'student', profile: {} },
  ]);
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nt-admin@example.com', password: 'password123' }),
  });
  const { accessToken } = await login.json();
  const approve = () => fetch(BASE + '/api/admin/users/nt-pend/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken }, body: '{}',
  });
  assert.equal((await approve()).status, 200);
  const n = await d.collection('notifications').findOne({ id: 'approved-nt-pend' });
  assert.ok(n && n.createdAt instanceof Date);
  await d.collection('notifications').deleteOne({ id: 'approved-nt-pend' });
  assert.equal((await approve()).status, 200);
  assert.equal(await d.collection('notifications').countDocuments({ id: 'approved-nt-pend' }), 0);
});
