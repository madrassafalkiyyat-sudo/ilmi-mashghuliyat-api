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
const { notifyOnce } = require('../lib/notify');

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

// POST /api/course/assignments/:id/submit — in-app submission.
// One doc per (assignment, student). Edit is allowed BEFORE the deadline
// and only while ungraded; after the deadline a first submission is still
// accepted but flagged late (points halved at grading — see lib/course).
router.post('/assignments/:id/submit', async (req, res) => {
  const db = await getDb();
  if (!isReg(req)) return fail(res, 403, 'not_registered', 'یہ مشق صرف کورس رجسٹرڈ طلبہ کے لیے ہے');
  const asg = await db.collection('assignments').findOne({ _id: req.params.id });
  if (!asg) return fail(res, 404, 'not_found', 'مشق نہیں ملی');
  if (asg.type !== 'in-app') return fail(res, 400, 'wrong_type', 'یہ مشق گوگل فارم پر مکمل ہوتی ہے — فارم کا بٹن کھولیں');
  if ((asg.releaseAtMs || 0) > Date.now()) return fail(res, 403, 'not_released', 'یہ مشق ابھی جاری نہیں ہوئی');
  const text = String((req.body && req.body.text) || '').trim();
  const link = String((req.body && req.body.link) || '').trim();
  if (!text && !link) return fail(res, 400, 'empty', 'جواب لکھنا ضروری ہے');
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
  await notifyOnce(db, {
    id: nid, email: sub.email, kind: 'grade', read: false,
    date: new Date().toISOString(),
    title: '🏅 مشق کے نمبر لگ گئے — ادارہ سازی کورس',
    body: `«${(asg && asg.title) || 'مشق'}» میں آپ کو ${m}${max ? '/' + max : ''} نمبر ملے۔${sub.late ? ' (تاخیر سے جمع — پوائنٹس نصف شمار ہوئے)' : ''} تفصیل «اسائنمنٹس» میں دیکھیں۔`,
  });
  return res.json({ ok: true, marks: m, points });
});

// GET /api/course/admin/gradebook — one row per registered student:
// per-session attendance, per-assignment marks, totals.
router.get('/admin/gradebook', async (req, res) => {
  const db = await getDb();
  const students = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1, name: 1, courseAtt: 1 }).toArray();
  const sessions = await db.collection('courseSessions').find({}).sort({ sessionDate: 1 }).toArray();
  const claims = await db.collection('attendanceClaims').find({ status: 'تصدیق شدہ' }).toArray();
  const assignments = await db.collection('assignments').find({ type: 'in-app' }).sort({ releaseAtMs: 1 }).toArray();
  const subs = await db.collection('assignmentSubmissions').find({}).toArray();
  const verified = {};
  for (const c of claims) { (verified[c.email] = verified[c.email] || new Set()).add(c.sessionId); }
  const subBy = {};
  for (const s of subs) subBy[`${s.assignmentId}:${s.email}`] = s;
  const rows = students.map((u) => {
    const attIds = new Set([...(verified[u.email] || []), ...((u.courseAtt || []))]);
    const att = sessions.map((s) => attIds.has(s.sessionId));
    const marks = assignments.map((a) => {
      const s = subBy[`${a._id}:${u.email}`];
      if (!s) return null;
      return { marks: s.marks, late: !!s.late, submitted: true };
    });
    const totalMarks = marks.reduce((t, m) => t + (m && typeof m.marks === 'number' ? m.marks : 0), 0);
    return { email: u.email, name: u.name, att, attCount: att.filter(Boolean).length, marks, totalMarks };
  });
  return res.json({
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, sessionDate: s.sessionDate })),
    assignments: assignments.map((a) => ({ id: a.id, title: a.title, maxMarks: a.maxMarks })),
    rows,
  });
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
  return res.json({ ok: true, created: r.created });
});

module.exports = router;
