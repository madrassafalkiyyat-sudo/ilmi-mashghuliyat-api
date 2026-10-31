'use strict';
// Student self-service routes. Identity ALWAYS comes from the JWT —
// req.user is the only source of "who am I". Students can read only their
// own records and can never delete anything (there is no DELETE here).
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireApproved, fail } = require('../middleware/auth');
const { profileMissing } = require('../lib/rules');
const { applyVisionReview } = require('../lib/vision');
const { hashPassword } = require('../auth');
const { stripSecrets, isLite, isDataUri, signature, slimUserPhoto } = require('../lib/slim');

const router = express.Router();
router.use(requireAuth);

// GET /api/users/me — own record (the old onSnapshot(users/uid) listener).
// ?lite=1 swaps the embedded photo for profile.photoSig (see lib/slim);
// profileMissing is always computed on the full record.
router.get('/me', async (req, res) => {
  const u = stripSecrets(req.user);
  const missing = profileMissing(u);
  return res.json({ user: isLite(req) ? slimUserPhoto(u) : u, profileMissing: missing, isAdmin: req.isAdmin });
});

// GET /api/users/me/photo — own photo, fetched by lite clients only when
// profile.photoSig changes.
router.get('/me/photo', async (req, res) => {
  const photo = (req.user.profile && req.user.profile.photo) || '';
  return res.json({ photo, photoSig: isDataUri(photo) ? signature(photo) : '' });
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
      if (['status', 'role', 'email', 'uid', '_id', 'passwordHash', 'photoSig'].includes(k)) continue;
      set[`profile.${k}`] = v;
    }
  }
  for (const k of TOP_LEVEL_PROFILE_FIELDS) {
    if (body[k] !== undefined) set[k] = body[k];
  }
  if (Object.keys(set).length === 0) return fail(res, 400, 'bad_request', 'پروفائل ڈیٹا درکار ہے');
  const db = await getDb();
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: set });
  const fresh = stripSecrets(await db.collection('users').findOne({ _id: req.user._id }));
  return res.json({ user: fresh, profileMissing: profileMissing(fresh) });
});

// POST /api/users/me/vision — vision text submission + auto-review.
// The verdict itself lives in lib/vision.applyVisionReview (the single
// enforcement point, shared with registration + the boot heal): one
// decision per text hash, an admin's incomplete decision record is
// never silently overwritten, approve/incomplete send the old flow's
// deterministic exactly-once notifications. (This replaces the former
// 409 'awaiting_admin_clear' behaviour, which dead-ended every student
// an admin had marked incomplete: nobody ever sent adminCleared. The
// old automation's semantics apply instead — a corrected resubmission
// IS the answer to an incomplete, and it is reviewed on arrival.)
router.post('/me/vision', async (req, res) => {
  const { text } = req.body || {};
  if (!text || String(text).trim().length < 20) {
    return fail(res, 400, 'short_vision', 'وژن کم از کم 20 حروف کا ہو');
  }
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  if (!user) return fail(res, 404, 'not_found', 'صارف موجود نہیں');
  const r = await applyVisionReview(db, user, String(text));
  return res.json({ review: r.review, status: r.status });
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
