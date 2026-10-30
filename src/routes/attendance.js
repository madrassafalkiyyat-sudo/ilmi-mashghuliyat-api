'use strict';
// Sessions, registration, secret-code attendance claims, verification.
// SECURITY: sessionSecrets are NEVER returned to students. The claim
// endpoint compares the submitted code server-side and only answers
// "correct/incorrect" — a wrong code reveals nothing about the real one.
// Claim window is enforced in Asia/Karachi (see lib/rules).
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireApproved, fail } = require('../middleware/auth');
const { attendanceWindow } = require('../lib/rules');

const router = express.Router();
router.use(requireAuth, requireApproved);

// GET /api/attendance/sessions — course sessions + live session roster.
// Students see session metadata WITHOUT secret codes. The live session
// doc (settings/session) is included sanitised: any key mentioning a
// code or secret is stripped before it leaves the server.
function sanitiseLiveSession(doc) {
  if (!doc) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (/secret|code|passcode/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

router.get('/sessions', async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('courseSessions').find({}).sort({ sessionDate: 1 }).toArray();
  const safe = docs.map(({ ...d }) => d);
  const live = await db.collection('settings').findOne({ _id: 'session' });
  return res.json({ sessions: safe, liveSession: sanitiseLiveSession(live) });
});

// GET /api/attendance/mine — own claims + own session registrations.
// Both the legacy boolean flags (migrated docs) and the per-session maps
// (written by this API) are returned so old and new clients agree.
router.get('/mine', async (req, res) => {
  const db = await getDb();
  const claims = await db.collection('attendanceClaims').find({ email: req.user.email }).toArray();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  return res.json({
    claims,
    sessionReg: user.sessionReg || false,
    sessionRegs: user.sessionRegs || {},
    sessionAtt: user.sessionAtt || false,
    sessionAtts: user.sessionAtts || {},
  });
});

// POST /api/attendance/course-register — Idara Sazi course registration
// (UI: course-register view sets user.courseReg). The bridge routes the
// UI's courseReg write here; without it the book/course-final gates,
// which require courseReg, could never open from the UI.
// ELIGIBILITY (Mufti 2026-10-30): only MPhil graduates and PhD students/
// graduates may register — enforced HERE server-side (lib/course mirrors
// the client's alumniStage rule), so a tampered client cannot register
// an ineligible student. The client's own gate shows the same message.
router.post('/course-register', async (req, res) => {
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  const courseLib = require('../lib/course');
  if (!(await courseLib.courseEligible(db, user))) {
    return fail(res, 403, 'not_eligible', courseLib.ELIGIBILITY_MSG);
  }
  const set = { courseReg: true };
  if (!user.courseRegAt) set.courseRegAt = new Date().toISOString();
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: set });
  return res.json({ ok: true, courseReg: true });
});

// POST /api/attendance/register — register for a session (before it ends).
// Writes BOTH shapes: the per-session map (sessionRegs.<id>) for precise
// tracking, and the legacy boolean (sessionReg=true) that migrated docs
// already carry — never a dotted write onto the legacy boolean itself,
// which would crash MongoDB ("cannot create field in element").
router.post('/register', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return fail(res, 400, 'missing_fields', 'سیشن درکار ہے');
  const db = await getDb();
  const session = await db.collection('courseSessions').findOne({ sessionId })
    || await db.collection('settings').findOne({ _id: 'session' });
  if (!session) return fail(res, 404, 'not_found', 'سیشن نہیں ملا');
  await db.collection('users').updateOne(
    { _id: req.user._id },
    { $set: { [`sessionRegs.${sessionId}`]: true, sessionReg: true } }
  );
  return res.json({ ok: true, sessionId });
});

// POST /api/attendance/claim — submit a secret code for a session.
// Enforces: registered for this session (per-session map OR the legacy
// boolean — parity with the old UI, which required registration first),
// window open, code correct, one claim per student per session
// (unique index backs this). Wrong codes reveal nothing.
router.post('/claim', async (req, res) => {
  const { sessionId, code } = req.body || {};
  if (!sessionId || !code) return fail(res, 400, 'missing_fields', 'سیشن اور کوڈ درکار ہیں');
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  const session = await db.collection('courseSessions').findOne({ sessionId });
  // Registration: the per-session map OR the legacy boolean. For a COURSE
  // session, course registration itself is the registration (a registered
  // course student is enrolled in every class of the batch).
  const registered = (user.sessionRegs && user.sessionRegs[sessionId]) || user.sessionReg === true
    || !!(session && user.courseReg);
  if (!registered) return fail(res, 403, 'not_registered', 'پہلے سیشن میں رجسٹریشن کریں، پھر حاضری درج ہوگی');
  const live = !session && await db.collection('settings').findOne({ _id: 'session' });
  const target = session || live;
  if (!target) return fail(res, 404, 'not_found', 'سیشن نہیں ملا');
  const window = attendanceWindow(target);
  if (!window.open) return fail(res, 403, 'window_closed', window.msg);
  const secret = await db.collection('sessionSecrets').findOne({ sessionId });
  if (!secret || String(secret.code) !== String(code).trim()) {
    return fail(res, 403, 'bad_code', 'کوڈ غلط ہے');
  }
  const id = `${sessionId}:${req.user.email}`;
  try {
    await db.collection('attendanceClaims').insertOne({
      _id: id, id, sessionId, email: req.user.email, name: req.user.name,
      sessionTitle: target.title || '', code: '***',
      date: new Date().toISOString(), status: 'زیرِ جائزہ',
    });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'already_claimed', 'اس سیشن کی حاضری پہلے درج ہو چکی ہے');
    throw e;
  }
  return res.json({ ok: true, status: 'زیرِ جائزہ' });
});

// ---- admin: verification + roster ----
// POST /api/attendance/verify — admin verifies a claim (or marks it
// manually verified). Verifying also sets users.sessionAtt for the
// student, so book/course progress updates from either path.
router.post('/verify', requireAdmin, async (req, res) => {
  const { claimId, verified } = req.body || {};
  if (!claimId) return fail(res, 400, 'missing_fields', 'کلیم درکار ہے');
  const db = await getDb();
  const claim = await db.collection('attendanceClaims').findOne({ _id: claimId });
  if (!claim) return fail(res, 404, 'not_found', 'کلیم نہیں ملا');
  const status = verified === false ? 'مسترد' : 'تصدیق شدہ';
  await db.collection('attendanceClaims').updateOne(
    { _id: claimId }, { $set: { status, verifiedAt: new Date().toISOString() } }
  );
  if (status === 'تصدیق شدہ') {
    // Per-session map (sessionAtts) + legacy boolean (sessionAtt) — never
    // a dotted write onto the legacy boolean, which would crash MongoDB
    // for every migrated doc (their sessionAtt is `true`, not a map).
    await db.collection('users').updateOne(
      { email: claim.email },
      { $set: { [`sessionAtts.${claim.sessionId}`]: true, sessionAtt: true } }
    );
    // Session-certificate wallet card (UI: renderCert) lights on
    // user.certIssued — but ONLY for non-course sessions. Course classes
    // have no individual certificate (course-final only, standing rule),
    // so course sessions must never set it.
    const isCourse = await db.collection('courseSessions').findOne({ sessionId: claim.sessionId });
    if (!isCourse) {
      await db.collection('users').updateOne(
        { email: claim.email }, { $set: { certIssued: true } }
      );
    } else {
      // Course points ledger: a verified course attendance is +10 points
      // (recomputed from source, exactly-once by construction).
      try { await require('../lib/course').recomputeCoursePoints(db, claim.email); } catch (e) { console.error('course points recompute failed:', e && e.message); }
    }
  }
  return res.json({ ok: true, status });
});

// GET /api/attendance/roster/:sessionId — admin roster (registered +
// claimed + verified). Attendee names come from users + claims.
router.get('/roster/:sessionId', requireAdmin, async (req, res) => {
  const db = await getDb();
  const sid = req.params.sessionId;
  const claims = await db.collection('attendanceClaims').find({ sessionId: sid }).toArray();
  // Per-session registrations live in sessionRegs (this API's map).
  // The legacy sessionReg boolean names no session, so it cannot
  // attribute a migrated user to this roster and is not used here.
  const registered = await db.collection('users')
    .find({ [`sessionRegs.${sid}`]: true }).project({ name: 1, email: 1 }).toArray();
  return res.json({ sessionId: sid, claims, registered });
});

module.exports = router;
