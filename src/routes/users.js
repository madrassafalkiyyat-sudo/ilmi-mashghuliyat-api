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
const { profileSet, topLevelValue, ownDocFields, isSafeId } = require('../lib/validate');

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
function badProfileField(res, field, error) {
  const hint = error === 'unsafe_text' ? ' — اس میں < > " ` جیسے نشانات نہ لکھیں' : '';
  return fail(res, 400, 'bad_profile', `پروفائل کا خانہ «${field}» درست نہیں${hint}`);
}
router.patch('/me/profile', async (req, res) => {
  const body = req.body || {};
  const profile = body.profile;
  let set = {};
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const r = profileSet(profile);
    if (r.error === 'bad_photo') return fail(res, 400, 'bad_photo', 'تصویر درست نہیں — JPG/PNG تصویر دوبارہ منتخب کریں');
    if (r.error) return badProfileField(res, r.field, r.error);
    set = r.set;
  }
  for (const k of TOP_LEVEL_PROFILE_FIELDS) {
    if (body[k] === undefined) continue;
    const r = topLevelValue(body[k]);
    if (r.error) return badProfileField(res, k, r.error);
    set[k] = r.value;
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
  if (typeof password !== 'string' || password.length < 8) return fail(res, 400, 'weak_password', 'پاس ورڈ کم از کم 8 حروف کا ہو');
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
  if (typeof token !== 'string' || token.length > 4096) return fail(res, 400, 'bad_token', 'ٹوکن درست نہیں');
  const db = await getDb();
  // Newest 10 devices per student; re-registering moves a token to the end.
  await db.collection('users').updateOne({ _id: req.user._id }, { $pull: { fcmTokens: token } });
  await db.collection('users').updateOne(
    { _id: req.user._id }, { $push: { fcmTokens: { $each: [token], $slice: -10 } } }
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
// Decision fields (status/position/…) belong to the admin: a student's
// write never sets them, so re-sending a whole doc keeps the admin's
// verdict, and a new transfer/competition entry always starts pending.
// An id owned by another student matches no own doc; the insert then
// collides on _id and is answered 409 by the app's error handler.
const PENDING = 'زیرِ غور';
function ownWriteRoute(coll, prefix, opts) {
  return async (req, res) => {
    const data = req.body && req.body.doc;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
    if (data.id !== undefined && !isSafeId(data.id)) return fail(res, 400, 'bad_id', 'ریکارڈ کی شناخت درست نہیں');
    const r = ownDocFields(data);
    if (r.error === 'too_large') return fail(res, 413, 'too_large', 'ڈیٹا کا سائز حد سے زیادہ ہے');
    if (r.error) return fail(res, 400, 'bad_request', 'ڈیٹا درست نہیں');
    const db = await getDb();
    const id = data.id || `${prefix}${Date.now().toString(36)}`;
    const set = { ...r.fields, _id: id, id, email: req.user.email };
    if (opts.stampDate) set.date = new Date().toISOString();
    const update = { $set: set };
    if (opts.pendingOnInsert) update.$setOnInsert = { status: PENDING };
    await db.collection(coll).updateOne({ _id: id, email: req.user.email }, update, { upsert: true });
    const doc = await db.collection(coll).findOne({ _id: id, email: req.user.email });
    return res.status(201).json({ doc });
  };
}

router.post('/me/drafts', requireApproved, ownWriteRoute('drafts', 'd', {}));
router.post('/me/transfers', requireApproved, ownWriteRoute('transfers', 't', { stampDate: true, pendingOnInsert: true }));
router.post('/me/competitions', requireApproved, ownWriteRoute('competitions', 'c', { stampDate: true, pendingOnInsert: true }));
router.post('/me/messages', requireApproved, ownWriteRoute('messages', 'm', { stampDate: true }));

module.exports = router;
