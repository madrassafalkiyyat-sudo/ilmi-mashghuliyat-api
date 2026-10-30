'use strict';
// Integration tests for the «علمی مشغولیت» MongoDB API.
// Runs against an in-memory MongoDB (mongodb-memory-server) — no Atlas,
// no network, no credentials. Run with: npm test
//
// Env is set BEFORE requiring the app, because src/config.js throws
// when MONGO_URI/JWT_SECRET are missing at require time.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let BASE;

async function start() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt';
  // The suite performs dozens of logins/refreshes from one loopback IP;
  // production keeps the default 60/15min (see src/app.js authLimiter).
  process.env.AUTH_RATE_MAX = '1000';
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  try { if (server) await new Promise((r) => server.close(r)); } catch (e) {}
  try {
    const { close } = require('../src/db');
    await close();
  } catch (e) {}
  try { if (mongod) await mongod.stop(); } catch (e) {}
}

async function call(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

// Direct DB handle for seeding (same in-memory server the app uses).
async function db() {
  const { getDb } = require('../src/db');
  return getDb();
}

async function seedUser(doc) {
  const d = await db();
  await d.collection('users').insertOne(doc);
  return doc;
}

async function login(email, password) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(r.status, 200, 'login should succeed: ' + JSON.stringify(r.data));
  return r.data.accessToken;
}

// Karachi "today" for open attendance windows (Asia/Karachi wall date).
function karachiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

before(start);
after(stop);

test('health endpoints answer ok + uptime, no data', async () => {
  for (const p of ['/health', '/api/health']) {
    const r = await call(p);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(typeof r.data.uptimeMs, 'number');
    assert.equal(r.data.db, undefined, 'health must not leak internals');
  }
});

test('re-register: approved migrated account -> migrated, login works immediately', async () => {
  await seedUser({
    _id: 'mig-approved', uid: 'mig-approved', email: 'approved-old@example.com',
    name: 'Old Approved', status: 'approved', role: 'student', profile: {},
  });
  const r = await call('/api/auth/re-register', {
    method: 'POST', body: { email: 'approved-old@example.com', password: 'newpass123' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.outcome, 'migrated');
  assert.equal(r.data.status, 'approved');
  const token = await login('approved-old@example.com', 'newpass123');
  const me = await call('/api/users/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'approved-old@example.com');
  assert.equal(me.data.user.status, 'approved');
});

test('re-register: pending migrated account stays pending, gated content blocked', async () => {
  await seedUser({
    _id: 'mig-pending', uid: 'mig-pending', email: 'pending-old@example.com',
    name: 'Old Pending', status: 'pending', role: 'student', profile: {},
  });
  const r = await call('/api/auth/re-register', {
    method: 'POST', body: { email: 'pending-old@example.com', password: 'newpass123' },
  });
  assert.equal(r.data.outcome, 'migrated');
  assert.equal(r.data.status, 'pending');
  const token = await login('pending-old@example.com', 'newpass123');
  const gated = await call('/api/content/announcements', { token });
  assert.equal(gated.status, 403, 'pending students must not read gated content');
});

test('re-register: unknown email -> brand-new pending registration', async () => {
  const r = await call('/api/auth/re-register', {
    method: 'POST', body: { email: 'brand-new@example.com', password: 'newpass123', name: 'Brand New' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.outcome, 'new_registration');
  assert.equal(r.data.status, 'pending');
  await login('brand-new@example.com', 'newpass123');
});

test('re-register: account that already has a password is never overwritten', async () => {
  const { hashPassword } = require('../src/auth');
  await seedUser({
    _id: 'has-pass', uid: 'has-pass', email: 'haspass@example.com',
    name: 'Has Pass', status: 'approved', role: 'student',
    passwordHash: await hashPassword('original123'), profile: {},
  });
  const r = await call('/api/auth/re-register', {
    method: 'POST', body: { email: 'haspass@example.com', password: 'hijack1234' },
  });
  assert.equal(r.data.outcome, 'already_migrated');
  // Old password still works, the attempted overwrite does not.
  await login('haspass@example.com', 'original123');
  const bad = await call('/api/auth/login', { method: 'POST', body: { email: 'haspass@example.com', password: 'hijack1234' } });
  assert.equal(bad.status, 401);
});

test('login before migration says re-register, never "wrong password"', async () => {
  await seedUser({
    _id: 'mig-nopass', uid: 'mig-nopass', email: 'nopass@example.com',
    name: 'No Pass', status: 'approved', role: 'student', profile: {},
  });
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'nopass@example.com', password: 'whatever123' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'no_password_set');
  assert.match(r.data.error.message, /دوبارہ رجسٹریشن/);
});

test('login rejects wrong password and unknown email with 401', async () => {
  const bad = await call('/api/auth/login', { method: 'POST', body: { email: 'haspass@example.com', password: 'nope-nope-nope' } });
  assert.equal(bad.status, 401);
  const unknown = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever123' } });
  assert.equal(unknown.status, 401);
});

test('role enforcement: students cannot read others, delete, or touch admin routes', async () => {
  const d = await db();
  await d.collection('notifications').insertMany([
    { _id: 'n-a1', id: 'n-a1', email: 'approved-old@example.com', title: 'A', body: '', date: new Date().toISOString(), read: false },
    { _id: 'n-b1', id: 'n-b1', email: 'other-student@example.com', title: 'B', body: '', date: new Date().toISOString(), read: false },
  ]);
  const tokenA = await login('approved-old@example.com', 'newpass123');
  const mine = await call('/api/notifications', { token: tokenA });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.docs.every((x) => x.email === 'approved-old@example.com'), 'only own notifications');
  assert.equal(mine.data.docs.length, 1);
  const del = await call('/api/content/announcements/x', { method: 'DELETE', token: tokenA });
  assert.equal(del.status, 403, 'students have no DELETE route');
  const adminUsers = await call('/api/admin/users', { token: tokenA });
  assert.equal(adminUsers.status, 403);
  const secrets = await call('/api/admin/secrets', { token: tokenA });
  assert.equal(secrets.status, 403, 'students must never read secret codes');
});

test('attendance: registration required, code checked server-side, one claim only', async () => {
  const d = await db();
  const today = karachiToday();
  await d.collection('courseSessions').insertOne({
    _id: 'cs-test', sessionId: 'sess-test-1', sessionDate: today,
    startTime: '00:00', endTime: '23:59', title: 'Test session',
  });
  await d.collection('sessionSecrets').insertOne({ _id: 'sec-test', sessionId: 'sess-test-1', code: 'QTT77' });
  const token = await login('approved-old@example.com', 'newpass123');
  // No registration yet -> 403 not_registered.
  const early = await call('/api/attendance/claim', { method: 'POST', token, body: { sessionId: 'sess-test-1', code: 'QTT77' } });
  assert.equal(early.status, 403);
  assert.equal(early.data.error.code, 'not_registered');
  // Register, then wrong code -> 403 bad_code (reveals nothing).
  await call('/api/attendance/register', { method: 'POST', token, body: { sessionId: 'sess-test-1' } });
  const wrong = await call('/api/attendance/claim', { method: 'POST', token, body: { sessionId: 'sess-test-1', code: 'WRONG' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error.code, 'bad_code');
  // Right code -> claim recorded as "under review".
  const ok = await call('/api/attendance/claim', { method: 'POST', token, body: { sessionId: 'sess-test-1', code: 'QTT77' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'زیرِ جائزہ');
  // Second claim -> 409 already_claimed (unique index).
  const dup = await call('/api/attendance/claim', { method: 'POST', token, body: { sessionId: 'sess-test-1', code: 'QTT77' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'already_claimed');
});

test('notifications exactly-once: repeated admin approve creates one doc', async () => {
  const d = await db();
  await d.collection('admins').insertOne({ _id: 'admin@example.com' });
  const { hashPassword } = require('../src/auth');
  await seedUser({
    _id: 'adm-1', uid: 'adm-1', email: 'admin@example.com',
    name: 'Admin', status: 'approved', role: 'student',
    passwordHash: await hashPassword('adminpass123'), profile: {},
  });
  await seedUser({
    _id: 'pend-1', uid: 'pend-1', email: 'toapprove@example.com',
    name: 'To Approve', status: 'pending', role: 'student', profile: {},
  });
  const adminToken = await login('admin@example.com', 'adminpass123');
  await call('/api/admin/users/pend-1/approve', { method: 'POST', token: adminToken, body: {} });
  await call('/api/admin/users/pend-1/approve', { method: 'POST', token: adminToken, body: {} });
  const count = await d.collection('notifications').countDocuments({ email: 'toapprove@example.com', id: 'approved-pend-1' });
  assert.equal(count, 1, 'decision notification must exist exactly once');
});

test('vision scorer: approve / incomplete / borderline cases', async () => {
  const { scoreVision } = require('../src/lib/rules');
  const approveText = 'میں یونیورسٹی میں تحقیق کرنا چاہتا ہوں اور مدرسہ ڈاٹ پی کے کے ساتھ مل کر ادارہ سازی کے لیے مفت تربیت دینا چاہتا ہوں';
  const a = scoreVision(approveText);
  assert.equal(a.decision, 'approve');
  assert.ok(a.score >= 3 && a.topical);
  const junk = 'ہاہاہا یہ ایک مذاق ہے';
  const j = scoreVision(junk);
  assert.equal(j.decision, 'incomplete');
  const thin = 'میں پڑھنا چاہتا ہوں';
  const t = scoreVision(thin);
  assert.notEqual(t.decision, 'approve');
});

test('vision API: approving vision auto-approves a pending student only', async () => {
  const d = await db();
  await seedUser({
    _id: 'vis-1', uid: 'vis-1', email: 'vision@example.com',
    name: 'Vision', status: 'pending', role: 'student', profile: {},
  });
  const token = await login('vision@example.com', 'newpass123').catch(async () => {
    // Vision user has no password yet: re-register first, then log in.
    await call('/api/auth/re-register', { method: 'POST', body: { email: 'vision@example.com', password: 'newpass123' } });
    return login('vision@example.com', 'newpass123');
  });
  const text = 'میں یونیورسٹی میں تحقیق کرنا چاہتا ہوں اور مدرسہ ڈاٹ پی کے کے ساتھ مل کر ادارہ سازی کے لیے مفت تربیت دینا چاہتا ہوں';
  const r = await call('/api/users/me/vision', { method: 'POST', token, body: { text } });
  assert.equal(r.status, 200);
  assert.equal(r.data.review.decision, 'approve');
  assert.equal(r.data.status, 'approved');
  const after = await d.collection('users').findOne({ _id: 'vis-1' });
  assert.equal(after.status, 'approved');
});

test('profile gate reads both top-level and profile fields (migrated shape)', async () => {
  const { profileMissing } = require('../src/lib/rules');
  const complete = {
    uni: 'GUTech', madrasa: 'Jamia', degree: 'MPhil',
    profile: { docName: 'doc.pdf', linkedin: 'https://linkedin.example/x', scholar: 'https://scholar.example/x', whatsapp: '03001234567', gender: 'مرد', photo: 'data:image/png;base64,AAA' },
  };
  assert.deepEqual(profileMissing(complete), []);
  const empty = { profile: {} };
  const miss = profileMissing(empty);
  assert.ok(miss.includes('document') && miss.includes('linkedin') && miss.includes('scholar') && miss.includes('uni') && miss.includes('madrasa') && miss.includes('degree') && miss.includes('whatsapp'));
  const womanNoPhoto = {
    uni: 'U', madrasa: 'M', degree: 'BS',
    profile: { docName: 'd', linkedin: 'l', scholar: 's', whatsapp: 'w', gender: 'خاتون' },
  };
  assert.deepEqual(profileMissing(womanNoPhoto), [], 'photo is mandatory for men only');
});

test('book lock: grant unlocks; full attendance + ended course unlocks; else locked', async () => {
  const { bookAccessState } = require('../src/lib/rules');
  const sessions = [
    { sessionId: 's1', sessionDate: '2020-01-01' },
    { sessionId: 's2', sessionDate: '2020-01-08' },
  ];
  assert.equal(bookAccessState({ bookAccess: true }, sessions, []).unlocked, true);
  assert.equal(bookAccessState({ courseReg: true }, sessions, [
    { sessionId: 's1', status: 'تصدیق شدہ' }, { sessionId: 's2', status: 'تصدیق شدہ' },
  ]).unlocked, true);
  assert.equal(bookAccessState({ courseReg: true }, sessions, [
    { sessionId: 's1', status: 'تصدیق شدہ' },
  ]).unlocked, false);
  assert.equal(bookAccessState({}, sessions, []).unlocked, false);
});

test('admin migration overview counts migrated vs pending correctly', async () => {
  const adminToken = await login('admin@example.com', 'adminpass123');
  const r = await call('/api/admin/migration', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.data.total >= 8, 'several seeded users exist');
  assert.ok(r.data.migrated >= 3, 'users with passwords counted as migrated');
  assert.equal(r.data.total, r.data.migrated + r.data.pendingMigration);
  assert.equal(r.data.byStatus.approved !== undefined, true);
});

test('refresh rotation: previous token has a one-time 60s grace, then is dead; logout revokes', async () => {
  const first = await call('/api/auth/login', { method: 'POST', body: { email: 'approved-old@example.com', password: 'newpass123' } });
  assert.equal(first.status, 200);
  const rotated = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(rotated.status, 200);
  // GRACE (2026-10-31): a second tab still holding the previous token must
  // not kill the session — the old token is accepted exactly ONCE inside
  // its 60-second grace window and issues that tab its own fresh pair.
  const grace = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(grace.status, 200, 'previous token must be accepted once inside the grace window');
  assert.ok(grace.data.refreshToken && grace.data.refreshToken !== first.data.refreshToken);
  const stale = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(stale.status, 401, 'previous token must be dead once its grace is consumed');
  const out = await call('/api/auth/logout', { method: 'POST', body: { refreshToken: grace.data.refreshToken } });
  assert.equal(out.status, 200);
  const afterLogout = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: grace.data.refreshToken } });
  assert.equal(afterLogout.status, 401, 'logged-out refresh token must be revoked');
});

test('refresh tokens are effectively permanent (~10 years)', async () => {
  const { refreshExpiresDays } = require('../src/config');
  assert.ok(refreshExpiresDays >= 3650, 'config TTL must be ~10 years, got ' + refreshExpiresDays);
  const r = await call('/api/auth/login', { method: 'POST', body: { email: 'approved-old@example.com', password: 'newpass123' } });
  assert.equal(r.status, 200);
  const d = await db();
  const u = await d.collection('users').findOne({ email: 'approved-old@example.com' });
  const fresh = (u.refreshTokens || []).filter((t) => !t.rotatedAt);
  const latest = fresh[fresh.length - 1];
  const years = (new Date(latest.expiresAt) - Date.now()) / (365.25 * 86400000);
  assert.ok(years > 9, 'stored refresh expiry must be ~10 years out, got ' + years.toFixed(2));
});

test('refresh grace: previous token dies once the grace window has passed', async () => {
  const first = await call('/api/auth/login', { method: 'POST', body: { email: 'approved-old@example.com', password: 'newpass123' } });
  assert.equal(first.status, 200);
  const rotated = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(rotated.status, 200);
  // Rewind the old entry's grace into the past, as if the 60s had elapsed.
  const { hashToken } = require('../src/auth');
  const d = await db();
  const h = hashToken(first.data.refreshToken);
  await d.collection('users').updateOne(
    { 'refreshTokens.hash': h },
    { $set: { 'refreshTokens.$.graceUntil': new Date(Date.now() - 1000).toISOString() } }
  );
  const stale = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(stale.status, 401, 'previous token must be rejected after its grace window');
  // The current token is untouched by the old token's death.
  const ok = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: rotated.data.refreshToken } });
  assert.equal(ok.status, 200, 'current token must keep working');
});

test('re-register duplicate email is flagged for admin resolution', async () => {
  const d = await db();
  // The production unique index normally prevents this; drop it in the
  // TEST database only so the defensive branch can be exercised.
  try { await d.collection('users').dropIndex('email_1'); } catch (e) {}
  await d.collection('users').insertMany([
    { _id: 'dup-1', uid: 'dup-1', email: 'dup@example.com', name: 'Dup One', status: 'approved', role: 'student', profile: {} },
    { _id: 'dup-2', uid: 'dup-2', email: 'dup@example.com', name: 'Dup Two', status: 'pending', role: 'student', profile: {} },
  ]);
  const r = await call('/api/auth/re-register', {
    method: 'POST', body: { email: 'dup@example.com', password: 'newpass123' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'duplicate_email');
  const flag = await d.collection('migrationFlags').findOne({ email: 'dup@example.com' });
  assert.ok(flag, 'duplicate must be flagged for admin resolution');
});

// ---------- Idara Sazi course classroom (2026-10-30) ----------
async function seedCourseUser(id, email, degree, eduStatus) {
  const { hashPassword } = require('../src/auth');
  await seedUser({
    _id: id, uid: id, email, name: 'Course ' + id, status: 'approved', role: 'student',
    passwordHash: await hashPassword('coursepass123'),
    degree, profile: { eduStatus },
  });
  return login(email, 'coursepass123');
}

test('course eligibility: MPhil graduate + PhD student register; BS student refused server-side', async () => {
  const mphilTok = await seedCourseUser('cu-mphil', 'cu-mphil@example.com', 'ایم فل', 'ایم فل مکمل ہے — فی الحال مزید تعلیم جاری نہیں');
  const ok1 = await call('/api/attendance/course-register', { method: 'POST', token: mphilTok, body: {} });
  assert.equal(ok1.status, 200, 'MPhil graduate must register: ' + JSON.stringify(ok1.data));
  const phdTok = await seedCourseUser('cu-phd', 'cu-phd@example.com', 'پی ایچ ڈی', 'پی ایچ ڈی جاری ہے');
  const ok2 = await call('/api/attendance/course-register', { method: 'POST', token: phdTok, body: {} });
  assert.equal(ok2.status, 200, 'PhD student must register');
  const bsTok = await seedCourseUser('cu-bs', 'cu-bs@example.com', 'بی ایس', 'بی ایس جاری ہے');
  const no = await call('/api/attendance/course-register', { method: 'POST', token: bsTok, body: {} });
  assert.equal(no.status, 403);
  assert.equal(no.data.error.code, 'not_eligible');
  const mphilOngoingTok = await seedCourseUser('cu-mphil-on', 'cu-mphil-on@example.com', 'ایم فل', 'ایم فل جاری ہے');
  const no2 = await call('/api/attendance/course-register', { method: 'POST', token: mphilOngoingTok, body: {} });
  assert.equal(no2.status, 403, 'MPhil still studying is NOT a graduate — refused');
});

test('course seed: 10 sessions + stable codes, announcement retargeted, secrets never reach students', async () => {
  const d = await db();
  const course = require('../src/lib/course');
  await d.collection('announcements').insertOne({
    _id: 'idara-batch1-launch', id: 'idara-batch1-launch', title: 't', body: 'b', audience: 'all',
  });
  const s1 = await course.seedCourseBatch(d);
  assert.equal(s1.sessions, 10);
  assert.equal(s1.announcement, 'retargeted-to-alumni');
  const s2 = await course.seedCourseBatch(d);
  assert.equal(s2.codesCreated, 0, 're-seed must never rotate codes');
  assert.equal(s2.announcement, 'already-alumni');
  assert.equal(await d.collection('courseSessions').countDocuments({ courseBatch: 'b1' }), 10);
  assert.equal(await d.collection('sessionSecrets').countDocuments({ sessionId: /^idara-b1-s/ }), 10);
  // Targeted notification exists for the eligible student, not for the BS one.
  assert.equal(await d.collection('notifications').countDocuments({ email: 'cu-mphil@example.com', id: /^course-b1-launch-/ }), 1);
  assert.equal(await d.collection('notifications').countDocuments({ email: 'cu-bs@example.com', id: /^course-b1-launch-/ }), 0);
  // Student session list carries NO secret code anywhere.
  const tok = await login('cu-mphil@example.com', 'coursepass123');
  const sess = await call('/api/attendance/sessions', { token: tok });
  assert.equal(sess.status, 200);
  assert.ok(!JSON.stringify(sess.data).includes('"code"'), 'secret codes must never reach students');
});

test('course releases: due items created once, registered students notified once', async () => {
  const d = await db();
  const course = require('../src/lib/course');
  const t1 = Date.parse('2026-11-03T09:00:00+05:00'); // Tue after session 1: form 1 only
  const r1 = await course.runCourseReleases(d, t1);
  assert.deepEqual(r1.created, ['asg-b1-f1-s1']);
  const r2 = await course.runCourseReleases(d, t1);
  assert.deepEqual(r2.created, [], 'second run creates nothing twice');
  const t2 = Date.parse('2026-11-04T09:00:00+05:00'); // Wed: activity (session 1 has no form 2)
  const r3 = await course.runCourseReleases(d, t2);
  assert.deepEqual(r3.created, ['asg-b1-act-s1']);
  assert.equal(await d.collection('notifications').countDocuments({ email: 'cu-mphil@example.com', id: /^asg-new-asg-b1-f1-s1-/ }), 1);
  assert.equal(await d.collection('notifications').countDocuments({ email: 'cu-bs@example.com', id: /^asg-new-/ }), 0, 'unregistered students are not notified');
  assert.ok(course.planGaps().some((g) => g.includes('session 7')), 'session 7 gap must be logged');
  assert.ok(course.planGaps().some((g) => g.includes('session 1')), 'session 1 single-form gap must be logged');
});

test('course assignments: submit, edit before deadline, grade -> points; late points halved', async () => {
  const d = await db();
  const { hashPassword } = require('../src/auth');
  await d.collection('admins').updateOne({ _id: 'admin@example.com' }, { $set: {} }, { upsert: true });
  const adminTok = await login('admin@example.com', 'adminpass123');
  const stuTok = await login('cu-mphil@example.com', 'coursepass123');
  const now = Date.now();
  const mk = await call('/api/course/admin/assignments', {
    method: 'POST', token: adminTok,
    body: { doc: { id: 'asg-test-1', title: 'ٹیسٹ مشق', instructions: 'جواب لکھیں', type: 'in-app', session: 1, maxMarks: 20, releaseAtMs: now - 1000, deadlineMs: now + 86400000 } },
  });
  assert.equal(mk.status, 201);
  const list = await call('/api/course/assignments', { token: stuTok });
  assert.ok(list.data.assignments.some((a) => a.id === 'asg-test-1'), 'registered student sees released assignment');
  const bsTok = await login('cu-bs@example.com', 'coursepass123');
  const listBs = await call('/api/course/assignments', { token: bsTok });
  assert.equal(listBs.data.assignments.length, 0, 'unregistered student sees no assignments');
  const sub = await call('/api/course/assignments/asg-test-1/submit', { method: 'POST', token: stuTok, body: { text: 'میرا جواب' } });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.late, false);
  const edit = await call('/api/course/assignments/asg-test-1/submit', { method: 'POST', token: stuTok, body: { text: 'ترمیم شدہ جواب' } });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.edited, true);
  const grade = await call('/api/course/admin/grade', { method: 'POST', token: adminTok, body: { submissionId: 'asg-test-1:cu-mphil@example.com', marks: 16, feedback: 'عمدہ' } });
  assert.equal(grade.status, 200);
  assert.equal(grade.data.points.assignmentPoints, 16);
  const afterGrade = await call('/api/course/assignments/asg-test-1/submit', { method: 'POST', token: stuTok, body: { text: 'دوبارہ' } });
  assert.equal(afterGrade.status, 409, 'graded submission is locked');
  // Late submission: full marks graded, points halved.
  await call('/api/course/admin/assignments', {
    method: 'POST', token: adminTok,
    body: { doc: { id: 'asg-test-late', title: 'تاخیری مشق', instructions: 'x', type: 'in-app', session: 1, maxMarks: 20, releaseAtMs: now - 3 * 86400000, deadlineMs: now - 86400000 } },
  });
  const lateSub = await call('/api/course/assignments/asg-test-late/submit', { method: 'POST', token: stuTok, body: { text: 'دیر سے جواب' } });
  assert.equal(lateSub.status, 200);
  assert.equal(lateSub.data.late, true);
  const g2 = await call('/api/course/admin/grade', { method: 'POST', token: adminTok, body: { submissionId: 'asg-test-late:cu-mphil@example.com', marks: 10 } });
  assert.equal(g2.data.points.assignmentPoints, 16 + 5, 'late 10 marks -> 5 points');
  const gb = await call('/api/course/admin/gradebook', { token: adminTok });
  assert.equal(gb.status, 200);
  assert.ok(gb.data.rows.some((r) => r.email === 'cu-mphil@example.com'));
});

test('course attendance: courseReg counts as registration; verified claim adds +10 points', async () => {
  const d = await db();
  const today = karachiToday();
  await d.collection('courseSessions').insertOne({
    _id: 'cs-course-today', sessionId: 'cs-course-today', sessionDate: today,
    startTime: '00:00', endTime: '23:59', title: 'ادارہ سازی کورس — ٹیسٹ کلاس', isCourseSession: true,
  });
  await d.collection('sessionSecrets').insertOne({ _id: 'cs-course-today', sessionId: 'cs-course-today', code: 'ABC12' });
  const stuTok = await login('cu-phd@example.com', 'coursepass123'); // courseReg in the eligibility test
  const claim = await call('/api/attendance/claim', { method: 'POST', token: stuTok, body: { sessionId: 'cs-course-today', code: 'ABC12' } });
  assert.equal(claim.status, 200, 'course-registered student claims without per-session registration: ' + JSON.stringify(claim.data));
  const adminTok = await login('admin@example.com', 'adminpass123');
  const ver = await call('/api/attendance/verify', { method: 'POST', token: adminTok, body: { claimId: 'cs-course-today:cu-phd@example.com', verified: true } });
  assert.equal(ver.status, 200);
  const pts = await call('/api/course/points', { token: stuTok });
  assert.equal(pts.data.points.attendanceCount, 1);
  assert.equal(pts.data.points.attendancePoints, 10);
  const board = await call('/api/course/leaderboard', { token: stuTok });
  assert.ok(board.data.leaderboard.some((b) => b.totalPoints >= 10));
});

test('admin-login: admin WITHOUT a users doc gets a passwordless session (refresh rotates, logout revokes)', async () => {
  const d = await db();
  await d.collection('admins').insertOne({ _id: 'boss@example.com' });
  const r = await call('/api/auth/admin-login', { method: 'POST', body: { email: '  Boss@Example.COM ' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.isAdmin, true);
  assert.ok(r.data.accessToken && r.data.refreshToken, 'same token pair shape as password login');
  assert.equal(r.data.user.email, 'boss@example.com');
  const me = await call('/api/users/me', { token: r.data.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.isAdmin, true, 'middleware must resolve the synthetic admin identity');
  const adm = await call('/api/admin/users?limit=5', { token: r.data.accessToken });
  assert.equal(adm.status, 200, 'admin-only session must reach admin routes');
  // Refresh rotation works for admin-only sessions (hashes live on the
  // admins doc, not in users).
  const rot = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: r.data.refreshToken } });
  assert.equal(rot.status, 200, JSON.stringify(rot.data));
  assert.equal(rot.data.isAdmin, true);
  // Same grace contract as users (hashes live on the admins doc): the
  // previous token is accepted once inside its grace, then dead.
  const grace = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: r.data.refreshToken } });
  assert.equal(grace.status, 200, 'previous admin token must be accepted once inside the grace window');
  assert.equal(grace.data.isAdmin, true);
  const stale = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: r.data.refreshToken } });
  assert.equal(stale.status, 401, 'old admin refresh token must be dead once its grace is consumed');
  await call('/api/auth/logout', { method: 'POST', body: { refreshToken: grace.data.refreshToken } });
  const afterLogout = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: grace.data.refreshToken } });
  assert.equal(afterLogout.status, 401, 'logged-out admin refresh token must be revoked');
});

test('admin-login: admin WITH a users doc but no password (the stuck case) gets in', async () => {
  const d = await db();
  await d.collection('admins').insertOne({ _id: 'chief@example.com' });
  await seedUser({
    _id: 'chief-1', uid: 'chief-1', email: 'chief@example.com',
    name: 'Chief Admin', status: 'pending', role: 'student', profile: {},
  });
  // Password login honestly refuses (no password was ever set) — this is
  // exactly the admin Mufti described, stuck while approvals wait.
  const pw = await call('/api/auth/login', { method: 'POST', body: { email: 'chief@example.com', password: 'whatever123' } });
  assert.equal(pw.status, 403);
  assert.equal(pw.data.error.code, 'no_password_set');
  const r = await call('/api/auth/admin-login', { method: 'POST', body: { email: 'chief@example.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.isAdmin, true);
  assert.equal(r.data.user.uid, 'chief-1', 'session must be issued for the real users doc');
  const me = await call('/api/users/me', { token: r.data.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.isAdmin, true);
  // ...and the session survives a refresh, like any other login.
  const rot = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: r.data.refreshToken } });
  assert.equal(rot.status, 200);
});

test('admin-login: non-admin emails rejected generically; student password login untouched', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { email: 'plain-student@example.com', password: 'studentpass123', name: 'Plain' } });
  assert.equal(reg.status, 201);
  for (const email of ['plain-student@example.com', 'nobody@example.com', 'not-an-email']) {
    const r = await call('/api/auth/admin-login', { method: 'POST', body: { email } });
    assert.equal(r.status, 403, email);
    assert.equal(r.data.error.code, 'bad_credentials', 'same generic failure as a wrong password');
    assert.equal(r.data.accessToken, undefined);
  }
  const missing = await call('/api/auth/admin-login', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  // The student themself still logs in with the password — and only with it.
  const ok = await call('/api/auth/login', { method: 'POST', body: { email: 'plain-student@example.com', password: 'studentpass123' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.isAdmin, undefined, 'normal login response shape unchanged for students');
  const bad = await call('/api/auth/login', { method: 'POST', body: { email: 'plain-student@example.com', password: '' } });
  assert.equal(bad.status, 400, 'an empty password must never log a student in');
});

const VISION_APPROVE_TEXT = 'میں یونیورسٹی میں تحقیق کرنا چاہتا ہوں اور مدرسہ ڈاٹ پی کے کے ساتھ مل کر ادارہ سازی کے لیے مفت تربیت دینا چاہتا ہوں';
const VISION_BORDERLINE_TEXT = 'میں یونیورسٹی میں تحقیق کرنا چاہتا ہوں اور مدرسہ میں پڑھاتا ہوں';

test('student-login: existing approved student enters with Gmail alone (Mufti 2026-10-31)', async () => {
  const r = await call('/api/auth/student-login', { method: 'POST', body: { email: '  Approved-Old@Example.COM ' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.accessToken && r.data.refreshToken, 'standard session pair');
  assert.equal(r.data.user.status, 'approved');
  const me = await call('/api/users/me', { token: r.data.accessToken });
  assert.equal(me.status, 200, 'issued access token must work');
});

test('student-login: pending + rejected records enter too — entry is not approval', async () => {
  await seedUser({ _id: 'pend-sl', uid: 'pend-sl', email: 'pending-student@example.com', name: 'Pending One', status: 'pending', role: 'student', profile: {} });
  await seedUser({ _id: 'rej-sl', uid: 'rej-sl', email: 'rejected-student@example.com', name: 'Rejected One', status: 'rejected', role: 'student', profile: {} });
  const p = await call('/api/auth/student-login', { method: 'POST', body: { email: 'pending-student@example.com' } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.user.status, 'pending', 'status preserved — pending screen routing is the client\u2019s job');
  const rj = await call('/api/auth/student-login', { method: 'POST', body: { email: 'rejected-student@example.com' } });
  assert.equal(rj.status, 200);
  assert.equal(rj.data.user.status, 'rejected');
});

test('student-login: unknown email -> generic 403, nothing revealed', async () => {
  const r = await call('/api/auth/student-login', { method: 'POST', body: { email: 'nobody-here@example.com' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'bad_credentials');
});

test('student-login: an email that is also an admin keeps isAdmin in the payload', async () => {
  const d = await db();
  await d.collection('admins').insertOne({ _id: 'dual@example.com' });
  await seedUser({ _id: 'dual-1', uid: 'dual-1', email: 'dual@example.com', name: 'Dual Role', status: 'approved', role: 'student', profile: {} });
  const r = await call('/api/auth/student-login', { method: 'POST', body: { email: 'dual@example.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.isAdmin, true, 'admin flag computed as usual even on the student path');
  const me = await call('/api/users/me', { token: r.data.accessToken });
  assert.equal(me.data.isAdmin, true);
});

test('student-login: per-route rate limit trips under hammering', async () => {
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const r = await call('/api/auth/student-login', { method: 'POST', body: { email: `rl-probe-${i}@example.com` } });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), 'route limiter (30/15min) must trip; got: ' + statuses.join(','));
});

test('register: name + form fields + vision persist; matching vision auto-approves + welcome notification (Mufti 2026-10-30)', async () => {
  const r = await call('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'new-student@example.com', password: 'studentpass123',
      name: 'نیا طالب علم', mobile: '03001234567', degree: 'پی ایچ ڈی', dept: 'اسلامک سٹڈیز',
      madrasa: 'جامعہ مثال', uni: 'مثال یونیورسٹی', country: 'پاکستان', admissionRoute: 'madrasa',
      visionSummary: VISION_APPROVE_TEXT,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.name, 'نیا طالب علم');
  assert.equal(r.data.user.status, 'approved', 'clearly matching vision auto-approves at submission time');
  const d = await db();
  const doc = await d.collection('users').findOne({ email: 'new-student@example.com' });
  assert.equal(doc.name, 'نیا طالب علم', 'admin card name line reads top-level name');
  assert.equal(doc.degree, 'پی ایچ ڈی');
  assert.equal(doc.uni, 'مثال یونیورسٹی');
  assert.equal(doc.visionSummary, VISION_APPROVE_TEXT, 'admin card vision line reads visionSummary');
  assert.equal(doc.visionReview.decision, 'approve');
  assert.equal(doc.visionReview.source, 'auto');
  const notif = await d.collection('notifications').findOne({ id: `welcome-approved-${doc.uid}` });
  assert.ok(notif, 'welcome notification with the old flow deterministic id');
  assert.equal(notif.kind, 'welcome-approved');
});

test('register: junk vision marks incomplete with deterministic notification; account stays pending', async () => {
  const r = await call('/api/auth/register', {
    method: 'POST',
    body: { email: 'junk-vision@example.com', password: 'studentpass123', name: 'فضول خلاصہ', visionSummary: 'ہاہاہا ہاہاہا یہ سب مذاق ہے مذاق' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'pending');
  const d = await db();
  const doc = await d.collection('users').findOne({ email: 'junk-vision@example.com' });
  assert.equal(doc.status, 'pending');
  assert.equal(doc.visionReview.decision, 'incomplete');
  assert.equal(doc.incomplete.reason, 'vision');
  assert.equal(doc.incomplete.state, 'awaiting');
  const { visionHash } = require('../src/lib/rules');
  const notif = await d.collection('notifications').findOne({ id: `incomplete-auto-${doc.uid}-${visionHash(doc.visionSummary)}` });
  assert.ok(notif, 'incomplete notification id matches the old flow format incomplete-auto-<uid>-<hash>');
  assert.equal(notif.kind, 'incomplete');
});

test('register: without vision fields the old sparse behaviour is unchanged', async () => {
  const r = await call('/api/auth/register', { method: 'POST', body: { email: 'plain-reg@example.com', password: 'studentpass123' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'pending');
  const d = await db();
  const doc = await d.collection('users').findOne({ email: 'plain-reg@example.com' });
  assert.equal(doc.visionReview, undefined);
  assert.equal(doc.visionSummary, undefined);
});

test('vision API: one decision per text — resubmission of the same text is a no-op, notification stays single', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'vision-dedupe@example.com', password: 'studentpass123', name: 'دوبارہ جمع' } });
  const token = await login('vision-dedupe@example.com', 'studentpass123');
  const first = await call('/api/users/me/vision', { method: 'POST', token, body: { text: VISION_APPROVE_TEXT } });
  assert.equal(first.status, 200);
  assert.equal(first.data.review.decision, 'approve');
  assert.equal(first.data.status, 'approved');
  const second = await call('/api/users/me/vision', { method: 'POST', token, body: { text: VISION_APPROVE_TEXT } });
  assert.equal(second.status, 200);
  assert.equal(second.data.review.decision, 'approve');
  assert.equal(second.data.review.hash, first.data.review.hash);
  const d = await db();
  const doc = await d.collection('users').findOne({ email: 'vision-dedupe@example.com' });
  const count = await d.collection('notifications').countDocuments({ id: `welcome-approved-${doc.uid}` });
  assert.equal(count, 1, 'exactly-once: repeated submission must not duplicate the welcome notification');
});

test('vision API: borderline text records the review only — no status change, no notification', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'vision-border@example.com', password: 'studentpass123', name: 'سرحدی' } });
  const token = await login('vision-border@example.com', 'studentpass123');
  const r = await call('/api/users/me/vision', { method: 'POST', token, body: { text: VISION_BORDERLINE_TEXT } });
  assert.equal(r.status, 200);
  assert.equal(r.data.review.decision, 'borderline');
  assert.equal(r.data.status, 'pending', 'borderline stays with the human — no auto status change');
  const d = await db();
  const doc = await d.collection('users').findOne({ email: 'vision-border@example.com' });
  assert.equal(doc.visionSummary, VISION_BORDERLINE_TEXT);
  assert.equal(doc.incomplete, undefined);
  const n = await d.collection('notifications').countDocuments({ email: 'vision-border@example.com' });
  assert.equal(n, 0);
});

test('vision heal: verdict + name backfilled only where missing; idempotent; awaiting/approved/sample untouched', async () => {
  const d = await db();
  const { healVisionRecords } = require('../src/lib/vision');
  const { visionHash } = require('../src/lib/rules');
  await seedUser({ _id: 'heal-1', uid: 'heal-1', email: 'heal1@example.com', name: '', status: 'pending', role: 'student', profile: { name: 'شفاء احمد' }, visionSummary: VISION_APPROVE_TEXT });
  await seedUser({ _id: 'heal-2', uid: 'heal-2', email: 'heal2@example.com', name: 'پہلے سے فیصلہ شدہ', status: 'pending', role: 'student', profile: {}, visionSummary: VISION_APPROVE_TEXT, visionReview: { decision: 'borderline', hash: visionHash(VISION_APPROVE_TEXT), source: 'auto' } });
  await seedUser({ _id: 'heal-3', uid: 'heal-3', email: 'heal3@example.com', name: 'منظور شدہ', status: 'approved', role: 'student', profile: {}, visionSummary: VISION_APPROVE_TEXT });
  await seedUser({ _id: 'heal-4', uid: 'heal-4', email: 'heal4@example.com', name: 'زیر التوا انسانی فیصلہ', status: 'pending', role: 'student', profile: {}, visionSummary: 'ہاہاہا مذاق', incomplete: { reason: 'vision', state: 'awaiting' } });
  const c1 = await healVisionRecords(d);
  assert.equal(c1.namesFilled, 1);
  assert.equal(c1.reviewed, 1);
  assert.equal(c1.approved, 1);
  const h1 = await d.collection('users').findOne({ _id: 'heal-1' });
  assert.equal(h1.name, 'شفاء احمد', 'name lifted from profile.name');
  assert.equal(h1.status, 'approved');
  assert.equal(h1.visionReview.decision, 'approve');
  const h2 = await d.collection('users').findOne({ _id: 'heal-2' });
  assert.equal(h2.status, 'pending', 'existing verdict record untouched');
  assert.equal(h2.visionReview.decision, 'borderline');
  const h3 = await d.collection('users').findOne({ _id: 'heal-3' });
  assert.equal(h3.visionReview, undefined, 'approved students are not re-reviewed by the heal');
  const h4 = await d.collection('users').findOne({ _id: 'heal-4' });
  assert.equal(h4.visionReview, undefined, 'human awaiting decision is never touched');
  const c2 = await healVisionRecords(d);
  assert.equal(c2.namesFilled, 0, 'second run fills nothing');
  assert.equal(c2.reviewed, 0, 'second run reviews nothing — idempotent');
});

test('expiry guard: real-data deadline parsing (latest date governs, no date = visible)', async () => {
  const { extractDates, isExpiredGuardedDoc } = require('../src/lib/expiry');
  const TODAY = '2026-10-31';
  // Real stored samples (Firestore export / nightly batches, Oct 2026):
  assert.deepEqual(extractDates('بیچ 60: درخواستیں 1 تا 30 اکتوبر 2026'), ['2026-10-30']);
  assert.deepEqual(extractDates('۳۰ اکتوبر ۲۰۲۶'), ['2026-10-30'], 'Urdu digits parse');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: 'بیچ 60: درخواستیں 1 تا 30 اکتوبر 2026', expiresAt: '2026-10-30' }, TODAY), true, 'IRSIP expired');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: 'آخری تاریخ: 28 اکتوبر 2026' }, TODAY), true, 'Fulbright expired');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: 'Spring/Summer 2027 راؤنڈ: 30 اکتوبر 2026 — Fall 2027 راؤنڈ: 30 مارچ 2027', expiresAt: '2026-10-30' }, TODAY), false, 'Knowledge Corridor: future round keeps it alive');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: '2026-10-31' }, TODAY), false, 'deadline today is not yet expired');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: 'سال بھر درخواستیں کھلی؛ پہلا سائیکل: اپریل کے آخر تک (اکتوبر انٹیک)' }, TODAY), false, 'no parseable date -> visible');
  assert.equal(isExpiredGuardedDoc({ cat: 'سکالرشپس', deadline: 'درخواستیں: ہر سال 10 جنوری تا 20 فروری (TBBS) — 2027 کے لیے آخری تاریخ 20 فروری 2027' }, TODAY), false, 'future deadline visible');
  assert.equal(isExpiredGuardedDoc({ cat: 'کورسز و تربیتی مواقع', deadline: '2026-10-01' }, TODAY), false, 'other categories are out of guard scope');
  assert.equal(isExpiredGuardedDoc({ cat: 'کانفرنسز', deadline: '2026-11-01' }, TODAY), false, 'tomorrow\u2019s conference visible');
});

test('expiry guard: student feed hides expired conf/schol; admins unaffected; direct link guarded', async () => {
  const d = await db();
  const seed = [
    { _id: 'n-exp-sch', id: 'n-exp-sch', cat: 'سکالرشپس', title: 'Expired Schol', deadline: 'آخری تاریخ: 28 اکتوبر 2026' },
    { _id: 'n-exp-conf', id: 'n-exp-conf', cat: 'کانفرنسز', title: 'Expired Conf', deadline: '2026-10-15' },
    { _id: 'n-future-sch', id: 'n-future-sch', cat: 'سکالرشپس', title: 'Future Schol', deadline: 'آخری تاریخ: 31 مارچ 2027' },
    { _id: 'n-corridor', id: 'n-corridor', cat: 'سکالرشپس', title: 'Corridor', deadline: 'راؤنڈ 1: 30 اکتوبر 2026 — راؤنڈ 2: 30 مارچ 2027' },
    { _id: 'n-nodate-conf', id: 'n-nodate-conf', cat: 'کانفرنسز', title: 'No Date Conf' },
    { _id: 'n-past-course', id: 'n-past-course', cat: 'کورسز و تربیتی مواقع', title: 'Past Course', deadline: '2026-10-01' },
  ];
  for (const doc of seed) await d.collection('news').insertOne(doc);
  const student = await login('approved-old@example.com', 'newpass123');
  const list = await call('/api/content/news?limit=200', { token: student });
  assert.equal(list.status, 200);
  const ids = list.data.docs.map((x) => x._id);
  assert.ok(!ids.includes('n-exp-sch'), 'expired scholarship hidden from students');
  assert.ok(!ids.includes('n-exp-conf'), 'expired conference hidden from students');
  assert.ok(ids.includes('n-future-sch'), 'future scholarship visible');
  assert.ok(ids.includes('n-corridor'), 'multi-round item visible');
  assert.ok(ids.includes('n-nodate-conf'), 'no-deadline item visible');
  assert.ok(ids.includes('n-past-course'), 'past course (out of scope) still visible');
  const direct = await call('/api/content/news/n-exp-sch', { token: student });
  assert.equal(direct.status, 404, 'expired item direct link closed for students');
  await d.collection('admins').insertOne({ _id: 'guard-admin@example.com' });
  const adm = await call('/api/auth/admin-login', { method: 'POST', body: { email: 'guard-admin@example.com' } });
  assert.equal(adm.status, 200);
  const aList = await call('/api/content/news?limit=200', { token: adm.data.accessToken });
  const aIds = aList.data.docs.map((x) => x._id);
  assert.ok(aIds.includes('n-exp-sch') && aIds.includes('n-exp-conf'), 'admins still see expired items');
  const aDirect = await call('/api/content/news/n-exp-sch', { token: adm.data.accessToken });
  assert.equal(aDirect.status, 200, 'admin direct link unaffected');
});

test('abstract endpoints: a valid JWT is required (401 without token)', async () => {
  const t1 = await call('/api/help/abstract/themes', { method: 'POST', body: { language: 'en', conference: { title: 'Conf' } } });
  assert.equal(t1.status, 401);
  const t2 = await call('/api/help/abstract/write', { method: 'POST', body: { language: 'en', theme: 'Some theme' } });
  assert.equal(t2.status, 401);
});

test('abstract endpoints: language + theme validation, honest 501 without a Gemini key', async () => {
  await call('/api/auth/register', { method: 'POST', body: { email: 'abs@example.com', password: 'studentpass123', name: 'ایبسٹریکٹ طالب' } });
  const t = await login('abs@example.com', 'studentpass123');
  const badLang = await call('/api/help/abstract/themes', { method: 'POST', token: t, body: { language: 'fr' } });
  assert.equal(badLang.status, 400);
  assert.equal(badLang.data.error.code, 'bad_language');
  const badLang2 = await call('/api/help/abstract/write', { method: 'POST', token: t, body: { language: '', theme: 'x' } });
  assert.equal(badLang2.status, 400);
  const noTheme = await call('/api/help/abstract/write', { method: 'POST', token: t, body: { language: 'en' } });
  assert.equal(noTheme.status, 400);
  assert.equal(noTheme.data.error.code, 'bad_theme');
  const valid = await call('/api/help/abstract/themes', { method: 'POST', token: t, body: { language: 'ur', conference: { title: 'بین الاقوامی کانفرنس' } } });
  assert.equal(valid.status, 501, 'valid input + valid token reaches the key check (no GEMINI_API_KEY in tests)');
  assert.equal(valid.data.error.code, 'ai_not_configured');
  const validWrite = await call('/api/help/abstract/write', { method: 'POST', token: t, body: { language: 'en', theme: 'AI in madrasa education' } });
  assert.equal(validWrite.status, 501);
});
