'use strict';
// Student self-service routes. Identity ALWAYS comes from the JWT —
// req.user is the only source of "who am I". Students can read only their
// own records and can never delete anything (there is no DELETE here).
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireApproved, fail } = require('../middleware/auth');
const { profileMissing, scoreVision, visionHash } = require('../lib/rules');
const { hashPassword } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/users/me — own record (the old onSnapshot(users/uid) listener).
router.get('/me', async (req, res) => {
  const u = { ...req.user };
  delete u.passwordHash;
  delete u.refreshTokens;
  delete u.resetTokenHash;
  delete u.loginTokenHash;
  return res.json({ user: u, profileMissing: profileMissing(u), isAdmin: req.isAdmin });
});

// PATCH /api/users/me/profile — own profile only. Accepts BOTH shapes the
// app has used: a `profile` object (merged into profile.*) and whitelisted
// top-level fields (name/uni/madrasa/degree/dept/mobile/country — the
// migrated docs store these at top level). status/role/email/uid/_id and
// any password material are NEVER client-settable here; vision goes
// through /me/vision, registration through /attendance/register.
const TOP_LEVEL_PROFILE_FIELDS = ['name', 'uni', 'madrasa', 'degree', 'dept', 'mobile', 'country'];
router.patch('/me/profile', async (req, res) => {
  const body = req.body || {};
  const profile = body.profile;
  const set = {};
  if (profile && typeof profile === 'object') {
    for (const [k, v] of Object.entries(profile)) {
      if (['status', 'role', 'email', 'uid', '_id', 'passwordHash'].includes(k)) continue;
      set[`profile.${k}`] = v;
    }
  }
  for (const k of TOP_LEVEL_PROFILE_FIELDS) {
    if (body[k] !== undefined) set[k] = body[k];
  }
  if (Object.keys(set).length === 0) return fail(res, 400, 'bad_request', 'پروفائل ڈیٹا درکار ہے');
  const db = await getDb();
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: set });
  const fresh = await db.collection('users').findOne({ _id: req.user._id });
  return res.json({ user: fresh, profileMissing: profileMissing(fresh) });
});

// POST /api/users/me/vision — vision text submission + auto-review.
// Human 'incomplete' is never overridden: if visionReview.decision is
// 'incomplete' with source 'admin', scoring is skipped and the record is
// left for the student's corrected resubmission (which an admin clears).
router.post('/me/vision', async (req, res) => {
  const { text } = req.body || {};
  if (!text || String(text).trim().length < 20) {
    return fail(res, 400, 'short_vision', 'وژن کم از کم 20 حروف کا ہو');
  }
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  const prev = user.visionReview || {};
  if (prev.decision === 'incomplete' && prev.source === 'admin' && !req.body.adminCleared) {
    return fail(res, 409, 'awaiting_admin_clear', 'پچھلا فیصلہ انتظامیہ کے پاس ہے');
  }
  const result = scoreVision(text);
  const review = {
    at: new Date().toISOString(), by: 'auto', source: 'auto',
    hash: visionHash(text), score: result.score, matched: result.matched,
    decision: result.decision,
  };
  const update = {
    $set: { visionSummary: String(text).slice(0, 4000), visionDate: review.at, visionReview: review },
  };
  // Auto-approve ONLY moves a pending account to approved; it never
  // approves a rejected account and never touches admin decisions.
  if (result.decision === 'approve' && user.status === 'pending') {
    update.$set.status = 'approved';
  }
  await db.collection('users').updateOne({ _id: user._id }, update);
  return res.json({ review, status: update.$set.status || user.status });
});

// POST /api/users/me/password — set/change own password (logged-in only).
router.post('/me/password', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return fail(res, 400, 'weak_password', 'پاس ورڈ کم از کم 8 حروف کا ہو');
  const db = await getDb();
  await db.collection('users').updateOne(
    { _id: req.user._id }, { $set: { passwordHash: await hashPassword(password) } }
  );
  return res.json({ ok: true });
});

// POST /api/users/me/push-token — FCM/web-push token re-registration.
// Tokens are stored on the own user doc only (old field: fcmTokens).
router.post('/me/push-token', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return fail(res, 400, 'missing_fields', 'ٹوکن درکار ہے');
  const db = await getDb();
  await db.collection('users').updateOne(
    { _id: req.user._id }, { $addToSet: { fcmTokens: token } }
  );
  return res.json({ ok: true, saved: true });
});

// Own records (each replaces a client-side subMine email== query):
// drafts, achievements, attendanceClaims, competitions entries, transfers,
// starRequests, messages, notifications are served from their own routes
// or from /api/users/me/* below; all filter by the JWT identity.
router.get('/me/drafts', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('drafts').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

router.get('/me/achievements', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('achievements').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

// Own-only reads for the remaining subMine collections (FRONTEND-MAP §5).
// Every query is forced to the JWT email — a client-supplied email is
// never trusted.
router.get('/me/competitions', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('competitions').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

router.get('/me/transfers', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('transfers').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

router.get('/me/messages', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('messages').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

router.get('/me/star-requests', requireApproved, async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('starRequests').find({ email: req.user.email }).toArray();
  return res.json({ docs });
});

// Own writes (replacing the old persistColl upserts for student-owned
// collections). The server stamps the JWT email onto every document;
// students still cannot delete anything (no DELETE route here).
router.post('/me/drafts', requireApproved, async (req, res) => {
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `d${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id, email: req.user.email };
  await db.collection('drafts').updateOne({ _id: id, email: req.user.email }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

router.post('/me/transfers', requireApproved, async (req, res) => {
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `t${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id, email: req.user.email, date: new Date().toISOString() };
  await db.collection('transfers').updateOne({ _id: id, email: req.user.email }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

router.post('/me/competitions', requireApproved, async (req, res) => {
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `c${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id, email: req.user.email, date: new Date().toISOString() };
  await db.collection('competitions').updateOne({ _id: id, email: req.user.email }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

router.post('/me/messages', requireApproved, async (req, res) => {
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `m${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id, email: req.user.email, date: new Date().toISOString() };
  await db.collection('messages').updateOne({ _id: id, email: req.user.email }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

module.exports = router;
