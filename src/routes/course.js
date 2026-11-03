'use strict';
// Idara Sazi course classroom API (Google-Classroom-like, fully in-app):
// assignments, submissions, grading, gradebook, points/leaderboard, plus
// the admin seed/release controls. Plan + rules live in lib/course.js.
//
// Visibility law: assignments are visible ONLY to course-registered
// students and ONLY after their release time; a student reads/writes ONLY
// their own submissions; students can never delete anything (no DELETE
// route exists here); admin checks precede student checks throughout.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireApproved, fail } = require('../middleware/auth');
const course = require('../lib/course');

const router = express.Router();
router.use(requireAuth, requireApproved);

const isReg = (req) => !!(req.user && req.user.courseReg);

// GET /api/course/assignments — released assignments + my submissions.
// Unregistered students get an empty list (the hub explains registration).
router.get('/assignments', async (req, res) => {
  const db = await getDb();
  if (!isReg(req) && !req.isAdmin) return res.json({ assignments: [], submissions: [], registered: false });
  const now = Date.now();
  const docs = await db.collection('assignments').find({}).sort({ releaseAtMs: 1 }).toArray();
  const released = docs.filter((a) => (a.releaseAtMs || 0) <= now);
  const subs = await db.collection('assignmentSubmissions').find({ email: req.user.email }).toArray();
  return res.json({ assignments: released, submissions: subs, registered: isReg(req) });
});

// GET /api/course/points — my points ledger + badges.
router.get('/points', async (req, res) => {
  const db = await getDb();
  if (!isReg(req)) return res.json({ points: null, badges: [] });
  const doc = await course.recomputeCoursePoints(db, req.user.email);
  const regs = new Set((await db.collection('users').find({ courseReg: true }).project({ email: 1 }).toArray()).map((u) => u.email));
  const all = (await db.collection('coursePoints').find({}).sort({ totalPoints: -1 }).toArray())
    .filter((d) => regs.has(d.email));
  const rank = all.findIndex((d) => d.email === req.user.email) + 1;
  return res.json({ points: doc, badges: course.badgesFor(doc, rank > 0 ? rank : null) });
});

// GET /api/course/leaderboard — top 10 (names + points only).
router.get('/leaderboard', async (req, res) => {
  const db = await getDb();
  const board = await course.courseLeaderboard(db, 10);
  return res.json({ leaderboard: board });
});

// POST /api/course/assignments/:id/submit — in-app submission OR, for a
// google-form assignment, the student's FORM CLAIM (Mufti 2026-11-03):
// the answers themselves live in the form's Sheet; here the student
// declares "I submitted the form" and the admin later grades that claim
// against the Sheet. One doc per (assignment, student). Edit is allowed
// BEFORE the deadline and only while ungraded; after the deadline a
// first submission is still accepted but flagged late (points halved at
// grading — see lib/course). A form claim's text (an optional note) may
// be empty — only in-app answers require text/link.
router.post('/assignments/:id/submit', async (req, res) => {
  const db = await getDb();
  if (!isReg(req)) return fail(res, 403, 'not_registered', 'یہ مشق صرف کورس رجسٹرڈ طلبہ کے لیے ہے');
  const asg = await db.collection('assignments').findOne({ _id: req.params.id });
  if (!asg) return fail(res, 404, 'not_found', 'مشق نہیں ملی');
  const isForm = asg.type === 'google-form';
  if (!isForm && asg.type !== 'in-app') return fail(res, 400, 'wrong_type', 'اس مشق کی قسم درست نہیں');
  if ((asg.releaseAtMs || 0) > Date.now()) return fail(res, 403, 'not_released', 'یہ مشق ابھی جاری نہیں ہوئی');
  const text = String((req.body && req.body.text) || '').trim();
  const link = String((req.body && req.body.link) || '').trim();
  if (!isForm && !text && !link) return fail(res, 400, 'empty', 'جواب لکھنا ضروری ہے');
  if (text.length > 20000) return fail(res, 400, 'too_long', 'جواب بہت طویل ہے — 20,000 حروف تک لکھیں');
  if (link && !/^https:\/\//i.test(link)) return fail(res, 400, 'bad_link', 'لنک درست https ربط ہونا چاہیے');
  const id = `${asg._id}:${req.user.email}`;
  const prev = await db.collection('assignmentSubmissions').findOne({ _id: id });
  const nowMs = Date.now();
  const late = nowMs > (asg.deadlineMs || Infinity);
  if (prev && typeof prev.marks === 'number') {
    return fail(res, 409, 'already_graded', 'اس مشق کے نمبر لگ چکے ہیں — اب تبدیلی نہیں ہو سکتی');
  }
  if (prev && !late) {
    await db.collection('assignmentSubmissions').updateOne(
      { _id: id },
      { $set: { text, link, updatedAt: new Date().toISOString() } }
    );
    return res.json({ ok: true, edited: true, late: false });
  }
  if (prev && late) return fail(res, 409, 'already_submitted', 'آپ یہ مشق پہلے جمع کرا چکے ہیں');
  const doc = {
    _id: id, id, assignmentId: asg._id, email: req.user.email, name: req.user.name || '',
    text, link, late, submittedAt: new Date().toISOString(), marks: null, feedback: '',
    source: 'student', ...(isForm ? { formClaim: true } : {}),
  };
  await db.collection('assignmentSubmissions').updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
  return res.json({ ok: true, late });
});

// ---------- admin ----------
router.use('/admin', requireAdmin);

// GET /api/course/admin/overview — every assignment (released or not),
// every submission, plan gaps and the release plan for the admin panel.
router.get('/admin/overview', async (req, res) => {
  const db = await getDb();
  const assignments = await db.collection('assignments').find({}).sort({ releaseAtMs: 1 }).toArray();
  const submissions = await db.collection('assignmentSubmissions').find({}).sort({ submittedAt: -1 }).toArray();
  const sessions = await db.collection('courseSessions').find({ courseBatch: 'b1' }).toArray();
  const registered = await db.collection('users').countDocuments({ courseReg: true, status: 'approved' });
  return res.json({
    assignments, submissions, sessionsSeeded: sessions.length, registered,
    gaps: course.planGaps(),
    plan: course.releasePlan().map((p) => ({ id: p.id, session: p.session, releaseAt: new Date(p.releaseAtMs).toISOString(), type: p.type })),
  });
});

// POST /api/course/admin/assignments — create/update one assignment.
// Admins pre-write the slide-activity instructions here (or edit an auto
// one); releaseAtMs in the future = scheduled, the student read path
// releases it automatically when the time passes.
router.post('/admin/assignments', async (req, res) => {
  const d = (req.body && req.body.doc) || {};
  const title = String(d.title || '').trim();
  if (!title) return fail(res, 400, 'bad_request', 'مشق کا عنوان درکار ہے');
  const type = d.type === 'google-form' ? 'google-form' : 'in-app';
  if (type === 'google-form' && !/^https:\/\//i.test(String(d.formUrl || ''))) {
    return fail(res, 400, 'bad_form', 'گوگل فارم مشق کے لیے درست فارم لنک درکار ہے');
  }
  const db = await getDb();
  const id = d.id || `asg-m${Date.now().toString(36)}`;
  const releaseAtMs = Number(d.releaseAtMs) || Date.now();
  const deadlineMs = Number(d.deadlineMs) || (releaseAtMs + 5 * 86400000);
  const doc = {
    _id: id, id, course: 'idara-b1', kind: d.kind || 'manual',
    title, instructions: String(d.instructions || ''),
    session: Number(d.session) || null, type,
    formUrl: type === 'google-form' ? String(d.formUrl).trim() : '',
    releaseAtMs, deadlineMs,
    releaseAt: new Date(releaseAtMs).toISOString(),
    deadline: new Date(deadlineMs).toISOString(),
    maxMarks: Math.max(0, Number(d.maxMarks) || 0),
    updatedAt: new Date().toISOString(),
  };
  await db.collection('assignments').updateOne({ _id: id }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

// POST /api/course/admin/grade — marks + optional feedback for one
// submission; the student's points ledger is recomputed immediately and
// the student is notified exactly once per grading event (id carries the
// marks, so a re-grade with different marks is a new, single notice).
router.post('/admin/grade', async (req, res) => {
  const { submissionId, marks, feedback } = req.body || {};
  if (!submissionId || marks === undefined || marks === null || isNaN(Number(marks))) {
    return fail(res, 400, 'bad_request', 'جمع کرائی گئی مشق اور نمبر درکار ہیں');
  }
  const db = await getDb();
  const sub = await db.collection('assignmentSubmissions').findOne({ _id: submissionId });
  if (!sub) return fail(res, 404, 'not_found', 'جمع کرائی گئی مشق نہیں ملی');
  const asg = await db.collection('assignments').findOne({ _id: sub.assignmentId });
  const max = (asg && asg.maxMarks) || 0;
  const m = Math.max(0, Math.min(Number(marks), max || Number(marks)));
  await db.collection('assignmentSubmissions').updateOne(
    { _id: submissionId },
    { $set: { marks: m, feedback: String(feedback || ''), gradedAt: new Date().toISOString(), gradedBy: req.user.email } }
  );
  const points = await course.recomputeCoursePoints(db, sub.email);
  const nid = `asg-grade-${submissionId}-${m}`;
  await db.collection('notifications').updateOne(
    { email: sub.email, id: nid },
    {
      $setOnInsert: {
        _id: nid, id: nid, email: sub.email, kind: 'grade', read: false,
        date: new Date().toISOString(),
        title: '🏅 مشق کے نمبر لگ گئے — ادارہ سازی کورس',
        body: `«${(asg && asg.title) || 'مشق'}» میں آپ کو ${m}${max ? '/' + max : ''} نمبر ملے۔${sub.late ? ' (تاخیر سے جمع — پوائنٹس نصف شمار ہوئے)' : ''} تفصیل «اسائنمنٹس» میں دیکھیں۔`,
      },
    },
    { upsert: true }
  );
  return res.json({ ok: true, marks: m, points });
});

// POST /api/course/admin/submissions/manual — admin asserts a submission
// exists OUTSIDE the app (Mufti 2026-11-03: e.g. the student's answers are
// in the form's Sheet but they never pressed the in-app claim button).
// Creates an UNGRADED record (source 'manual'); grading then flows
// through the ordinary grade route. 409 when a record already exists —
// manual entry never overwrites a student's own claim.
router.post('/admin/submissions/manual', async (req, res) => {
  const { assignmentId, email } = req.body || {};
  if (!assignmentId || !email) return fail(res, 400, 'bad_request', 'مشق اور طالب علم درکار ہیں');
  const db = await getDb();
  const asg = await db.collection('assignments').findOne({ _id: String(assignmentId) });
  if (!asg) return fail(res, 404, 'not_found', 'مشق نہیں ملی');
  const em = String(email).trim().toLowerCase();
  const user = await db.collection('users').findOne({ email: em });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  if (!user.courseReg || user.status !== 'approved') {
    return fail(res, 403, 'not_registered', 'یہ طالب علم کورس رجسٹرڈ نہیں ہے');
  }
  const id = `${asg._id}:${em}`;
  const prev = await db.collection('assignmentSubmissions').findOne({ _id: id });
  if (prev) return fail(res, 409, 'already_exists', 'اس طالب علم کا اندراج اس مشق میں پہلے سے موجود ہے');
  const doc = {
    _id: id, id, assignmentId: asg._id, email: em, name: user.name || '',
    text: '', link: '', late: Date.now() > (asg.deadlineMs || Infinity),
    submittedAt: new Date().toISOString(), marks: null, feedback: '',
    source: 'manual', markedBy: req.user.email,
    ...(asg.type === 'google-form' ? { formClaim: true } : {}),
  };
  try {
    await db.collection('assignmentSubmissions').insertOne(doc);
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'already_exists', 'اس طالب علم کا اندراج اس مشق میں پہلے سے موجود ہے');
    throw e;
  }
  return res.status(201).json({ ok: true, doc });
});

// POST /api/course/admin/submissions/remove — delete an UNGRADED
// submission record (any source) and recompute the student's points.
// A GRADED record is the student's permanent grade history: removal is
// refused (409) — with ONE hard-coded exception: {force:true} may delete
// a graded record ONLY when it belongs to the known test account
// (muftihassan2026@gmail.com), so end-to-end test proofs can clean up
// after themselves without a general delete-graded capability.
router.post('/admin/submissions/remove', async (req, res) => {
  const { submissionId, force } = req.body || {};
  if (!submissionId) return fail(res, 400, 'bad_request', 'اندراج درکار ہے');
  const db = await getDb();
  const sub = await db.collection('assignmentSubmissions').findOne({ _id: String(submissionId) });
  if (!sub) return fail(res, 404, 'not_found', 'اندراج نہیں ملا');
  if (typeof sub.marks === 'number') {
    const testCleanup = force === true && sub.email === 'muftihassan2026@gmail.com';
    if (!testCleanup) return fail(res, 409, 'already_graded', 'اس اندراج کے نمبر لگ چکے ہیں — حذف نہیں ہو سکتا');
  }
  await db.collection('assignmentSubmissions').deleteOne({ _id: sub._id });
  const points = await course.recomputeCoursePoints(db, sub.email);
  return res.json({ ok: true, points });
});

// GET /api/course/admin/gradebook — one row per registered student:
// per-session attendance, per-assignment marks, totals. Attendance is
// derived by the ONE canonical rule (lib/course.js attStateFor):
// att[] stays the present booleans, attState[] carries 'code' |
// 'manual' | 'pending' | '' per session so every surface can show the
// tick WITH its source and pending claims as their own state.
router.get('/admin/gradebook', async (req, res) => {
  const db = await getDb();
  const students = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1, name: 1, courseAtt: 1, sessionAtts: 1 }).toArray();
  const sessions = await db.collection('courseSessions').find({}).sort({ sessionDate: 1 }).toArray();
  const claims = await db.collection('attendanceClaims').find({}).toArray();
  const assignments = await db.collection('assignments').find({}).sort({ releaseAtMs: 1 }).toArray();
  const subs = await db.collection('assignmentSubmissions').find({}).toArray();
  const claimBy = {};
  for (const c of claims) claimBy[`${c.email}|${c.sessionId}`] = c;
  const subBy = {};
  for (const s of subs) subBy[`${s.assignmentId}:${s.email}`] = s;
  const rows = students.map((u) => {
    const states = sessions.map((s) => course.attStateFor(u, s.sessionId, claimBy[`${u.email}|${s.sessionId}`]));
    const att = states.map((x) => x.state === 'present');
    const attState = states.map((x) => (x.state === 'present' ? x.source : (x.state === 'pending' ? 'pending' : '')));
    const marks = assignments.map((a) => {
      const s = subBy[`${a._id}:${u.email}`];
      if (!s) return null;
      return { marks: s.marks, late: !!s.late, submitted: true };
    });
    const totalMarks = marks.reduce((t, m) => t + (m && typeof m.marks === 'number' ? m.marks : 0), 0);
    return {
      email: u.email, name: u.name, att, attState,
      attCount: att.filter(Boolean).length,
      attPend: attState.filter((x) => x === 'pending').length,
      marks, totalMarks,
    };
  });
  return res.json({
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, sessionDate: s.sessionDate })),
    assignments: assignments.map((a) => ({ id: a.id, title: a.title, maxMarks: a.maxMarks, type: a.type })),
    rows,
  });
});

// GET /api/course/admin/attendance/:sessionId — per-session attendance
// for the admin classroom: verified present (with source: code/manual),
// code claims still awaiting verification, and the absent list
// (registered students with no claim at all for this session).
router.get('/admin/attendance/:sessionId', async (req, res) => {
  const db = await getDb();
  const sid = req.params.sessionId;
  const session = await db.collection('courseSessions').findOne({ sessionId: sid });
  if (!session) return fail(res, 404, 'not_found', 'سیشن نہیں ملا');
  const students = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1, name: 1, sessionAtts: 1, courseAtt: 1 }).toArray();
  const claims = await db.collection('attendanceClaims').find({ sessionId: sid }).toArray();
  const claimOf = {};
  for (const c of claims) claimOf[c.email] = c;
  const shape = (c) => ({
    email: c.email, name: c.name || '', at: c.date || null,
    source: c.source === 'manual' ? 'manual' : 'code',
    markedBy: c.markedBy || null, claimId: c._id,
  });
  // Same ONE rule as the gradebook (attStateFor): verified claim OR an
  // admin-entered user-doc record = present; an unverified claim stays
  // visibly pending; a rejected claim never masquerades as absent.
  const present = [], pending = [], rejected = [], absent = [];
  for (const u of students) {
    const c = claimOf[u.email] || null;
    const st = course.attStateFor(u, sid, c);
    if (st.state === 'present') {
      if (c && c.status === 'تصدیق شدہ') present.push(shape(c));
      else present.push({ email: u.email, name: u.name || '', at: null, source: 'manual', markedBy: null, claimId: null, legacy: true });
    } else if (st.state === 'pending') {
      pending.push(shape(c));
    } else if (c && c.status === 'مسترد') {
      rejected.push(shape(c));
    } else if (!c) {
      absent.push({ email: u.email, name: u.name || '' });
    }
  }
  return res.json({
    session: { sessionId: sid, title: session.title || '', sessionDate: session.sessionDate || '' },
    present, pending, rejected, absent,
    registered: students.length,
  });
});

// POST /api/course/admin/attendance/manual — mark one registered student
// present for a course session BY HAND (Mufti 2026-11-03: students who
// could not claim by code in the window must not lose their attendance).
// Creates EXACTLY what a verified code claim creates — the claim doc,
// users.sessionAtts/sessionAtt, and the recomputed points (+10) — tagged
// source:'manual' with the marking admin and the time, so it stays
// distinguishable from (and never confused with) a code claim.
router.post('/admin/attendance/manual', async (req, res) => {
  const { sessionId, userId } = req.body || {};
  if (!sessionId || !userId) return fail(res, 400, 'missing_fields', 'سیشن اور طالب علم درکار ہیں');
  const db = await getDb();
  const session = await db.collection('courseSessions').findOne({ sessionId });
  if (!session) return fail(res, 404, 'not_found', 'سیشن نہیں ملا');
  const user = await db.collection('users').findOne({
    $or: [{ _id: String(userId) }, { email: String(userId).toLowerCase() }],
  });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  if (!user.courseReg || user.status !== 'approved') {
    return fail(res, 403, 'not_registered', 'یہ طالب علم کورس رجسٹرڈ نہیں ہے');
  }
  const id = `${sessionId}:${user.email}`;
  const existing = await db.collection('attendanceClaims').findOne({ _id: id });
  if (existing) {
    if (existing.status === 'تصدیق شدہ') return fail(res, 409, 'already_present', 'اس طالب علم کی حاضری پہلے سے درج ہے');
    return fail(res, 409, 'pending_claim', 'اس طالب علم کا کوڈ دعویٰ تصدیق کے منتظر ہے — اس کی تصدیق کریں، دوسرا اندراج نہیں بن سکتا');
  }
  const nowIso = new Date().toISOString();
  try {
    await db.collection('attendanceClaims').insertOne({
      _id: id, id, sessionId, email: user.email, name: user.name || '',
      sessionTitle: session.title || '', code: '***',
      date: nowIso, status: 'تصدیق شدہ', verifiedAt: nowIso,
      source: 'manual', markedBy: req.user.email, markedAt: nowIso,
    });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'already_present', 'اس طالب علم کی حاضری پہلے سے درج ہے');
    throw e;
  }
  await db.collection('users').updateOne(
    { email: user.email },
    { $set: { [`sessionAtts.${sessionId}`]: true, sessionAtt: true } }
  );
  const points = await course.recomputeCoursePoints(db, user.email);
  return res.json({ ok: true, points });
});

// POST /api/course/admin/attendance/manual/undo — reverse a MANUAL mark
// exactly (claim removed, sessionAtts entry removed, points recomputed).
// Code claims are never touched from here (claim.source must be
// 'manual'), mirroring that a verified code claim stands on the
// student's own in-window action. The legacy sessionAtt boolean is left
// as-is — the verify path never unsets it either.
router.post('/admin/attendance/manual/undo', async (req, res) => {
  const { sessionId, userId } = req.body || {};
  if (!sessionId || !userId) return fail(res, 400, 'missing_fields', 'سیشن اور طالب علم درکار ہیں');
  const db = await getDb();
  const user = await db.collection('users').findOne({
    $or: [{ _id: String(userId) }, { email: String(userId).toLowerCase() }],
  });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  const id = `${sessionId}:${user.email}`;
  const claim = await db.collection('attendanceClaims').findOne({ _id: id });
  if (!claim) return fail(res, 404, 'not_found', 'حاضری کا ریکارڈ نہیں ملا');
  if (claim.source !== 'manual') {
    return fail(res, 403, 'not_manual', 'یہ حاضری کوڈ سے درج ہوئی تھی — یہاں سے واپس نہیں ہو سکتی');
  }
  await db.collection('attendanceClaims').deleteOne({ _id: id });
  await db.collection('users').updateOne(
    { email: user.email },
    { $unset: { [`sessionAtts.${sessionId}`]: '' } }
  );
  const points = await course.recomputeCoursePoints(db, user.email);
  return res.json({ ok: true, points });
});

// POST /api/course/admin/seed — (re)run the batch-1 seed. Idempotent.
router.post('/admin/seed', async (req, res) => {
  const db = await getDb();
  const summary = await course.seedCourseBatch(db);
  return res.json({ ok: true, summary });
});

// POST /api/course/admin/releases — run the release engine now (the same
// tick the server runs hourly and at boot).
router.post('/admin/releases', async (req, res) => {
  const db = await getDb();
  const r = await course.runCourseReleases(db);
  return res.json({ ok: true, created: r.created, healed: r.healed || [] });
});

// POST /api/course/admin/notify-form-system — the one-time notice about
// the google-form marks system (Mufti 2026-11-03). Exactly-once per
// student by deterministic notification id (see lib/course.js); safe to
// call again — it then creates nothing.
router.post('/admin/notify-form-system', async (req, res) => {
  const db = await getDb();
  const r = await course.notifyFormSystemOnce(db);
  return res.json({ ok: true, created: r.created, total: r.total });
});

module.exports = router;
