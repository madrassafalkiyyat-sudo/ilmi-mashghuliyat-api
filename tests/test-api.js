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

test('refresh rotation revokes the old token; logout revokes', async () => {
  const first = await call('/api/auth/login', { method: 'POST', body: { email: 'approved-old@example.com', password: 'newpass123' } });
  assert.equal(first.status, 200);
  const rotated = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(rotated.status, 200);
  const stale = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(stale.status, 401, 'old refresh token must be revoked after rotation');
  const out = await call('/api/auth/logout', { method: 'POST', body: { refreshToken: rotated.data.refreshToken } });
  assert.equal(out.status, 200);
  const afterLogout = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: rotated.data.refreshToken } });
  assert.equal(afterLogout.status, 401, 'logged-out refresh token must be revoked');
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
  const stale = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: r.data.refreshToken } });
  assert.equal(stale.status, 401, 'old admin refresh token must be revoked after rotation');
  await call('/api/auth/logout', { method: 'POST', body: { refreshToken: rot.data.refreshToken } });
  const afterLogout = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: rot.data.refreshToken } });
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
