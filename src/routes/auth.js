'use strict';
// Auth routes. Passwords never leave this file's hashing calls.
// NOTE on migration: Firebase Auth passwords cannot be transferred, so
// accounts created by the migration have NO passwordHash until the student
// sets one (see OPEN-DECISIONS.md). Login without a passwordHash is
// refused with code 'no_password_set' and the client offers the magic-link
// or forgot-password flow instead.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { hashPassword, checkPassword, signAccessToken, hashToken, newRefreshToken } = require('../auth');
const { fail } = require('../middleware/auth');
const { applyVisionReview } = require('../lib/vision');
const config = require('../config');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { uid: u._id, email: u.email, name: u.name, status: u.status || 'pending', role: u.role || 'student' };
}

async function issueSession(db, user, res, extra) {
  const refresh = newRefreshToken();
  const expires = new Date(Date.now() + config.refreshExpiresDays * 86400000);
  await db.collection('users').updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { hash: hashToken(refresh), expiresAt: expires.toISOString() } } }
  );
  return res.json({ accessToken: signAccessToken(user), refreshToken: refresh, user: publicUser(user), ...(extra || {}) });
}

// Admin WITHOUT a users doc: the identity requireAuth already understands —
// the access token carries sub 'admin:<email>' + the email, and
// requireAuth resolves it against the admins collection alone. Refresh
// hashes live on the admins doc itself (a users.updateOne would match
// nothing); /refresh and /logout look there too.
function syntheticAdminUser(adminDoc) {
  const email = String(adminDoc._id).toLowerCase();
  return { _id: `admin:${email}`, email, name: adminDoc.name || email, status: 'approved', role: 'admin' };
}

async function issueAdminOnlySession(db, adminDoc, res) {
  const user = syntheticAdminUser(adminDoc);
  const refresh = newRefreshToken();
  const expires = new Date(Date.now() + config.refreshExpiresDays * 86400000);
  await db.collection('admins').updateOne(
    { _id: user.email },
    { $push: { refreshTokens: { hash: hashToken(refresh), expiresAt: expires.toISOString() } } }
  );
  return res.json({ accessToken: signAccessToken(user), refreshToken: refresh, user: publicUser(user), isAdmin: true });
}

// POST /api/auth/register — creates a users doc in status 'pending'.
// The old app hid the login surface before approval; the API mirrors it:
// a pending account receives a token but requireApproved blocks gated
// content until an admin approves.
//
// The registration form's fields (name, mobile, degree, dept, madrasa,
// uni, country, admissionRoute) are stored at top level — the same
// shape the admin panel reads. Until 2026-10-30 the client never sent
// them and this route never stored them, so new students appeared in
// the admin list with NO name and NO vision summary (Mufti's report).
// A visionSummary sent with the registration is reviewed HERE, at
// submission time (lib/vision.applyVisionReview): a clearly matching
// summary auto-approves the account, junk marks it incomplete — the
// rules the Firestore-bound automation used to apply within 30 min.
router.post('/register', async (req, res) => {
  const body = req.body || {};
  const { email, password } = body;
  if (!email || !EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'درست ای میل لکھیں');
  if (!password || password.length < 8) return fail(res, 400, 'weak_password', 'پاس ورڈ کم از کم 8 حروف کا ہو');
  try {
    const db = await getDb();
    const norm = String(email).toLowerCase();
    const existing = await db.collection('users').findOne({ email: norm });
    if (existing) return fail(res, 409, 'email_taken', 'یہ ای میل پہلے سے درج ہے');
    const now = new Date().toISOString();
    const str = (v, cap) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : undefined);
    const doc = {
      _id: `u_${Date.now().toString(36)}`,
      uid: `u_${Date.now().toString(36)}`,
      email: norm, name: str(body.name, 120) || '', status: 'pending', role: 'student',
      passwordHash: await hashPassword(password),
      regAt: now, profile: {}, refreshTokens: [],
    };
    for (const k of ['mobile', 'degree', 'dept', 'madrasa', 'uni', 'country', 'admissionRoute']) {
      const v = str(body[k], 200);
      if (v !== undefined) doc[k] = v;
    }
    await db.collection('users').insertOne(doc);
    const visionText = typeof body.visionSummary === 'string' ? body.visionSummary.trim() : '';
    if (visionText.length >= 20) {
      await applyVisionReview(db, doc, visionText);
      const fresh = await db.collection('users').findOne({ _id: doc._id });
      return res.status(201).json({ user: publicUser(fresh || doc), message: 'درخواست موصول — انتظامیہ کی منظوری کے بعد رسائی کھلے گی' });
    }
    return res.status(201).json({ user: publicUser(doc), message: 'درخواست موصول — انتظامیہ کی منظوری کے بعد رسائی کھلے گی' });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'email_taken', 'یہ ای میل پہلے سے درج ہے');
    return fail(res, 500, 'server_error', 'سرور کی خرابی');
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'missing_fields', 'ای میل اور پاس ورڈ درکار ہیں');
  const db = await getDb();
  const user = await db.collection('users').findOne({ email: String(email).toLowerCase() });
  if (!user) return fail(res, 401, 'bad_credentials', 'ای میل یا پاس ورڈ غلط ہے');
  if (!user.passwordHash) {
    // Migrated account without a password yet. NEVER say "wrong password":
    // the account simply has no password — the student must re-register
    // with this same registered email (see POST /re-register below).
    return fail(res, 403, 'no_password_set', 'اس کھاتے کا پاس ورڈ ابھی نہیں بنا — پہلی بار نئی ایپ میں لاگ ان کے لیے اپنی رجسٹرڈ ای میل سے دوبارہ رجسٹریشن کریں');
  }
  if (!(await checkPassword(password, user.passwordHash))) {
    return fail(res, 401, 'bad_credentials', 'ای میل یا پاس ورڈ غلط ہے');
  }
  return issueSession(db, user, res);
});

// POST /api/auth/admin-login — PASSWORDLESS admin entry (Mufti, 2026-10-30:
// «ایڈمن کو تو ڈائریکٹ ای میل ڈالتے ہی ایپ کھل جانی چاہیے»). An admin who
// types only their Gmail gets a full session — no password, no code —
// because admins stuck on a forgotten password were delaying student
// approvals. The ONLY source of truth is the server-side admins
// collection (docs keyed by _id = lowercase email, same lookup isAdmin()
// and requireAuth use); nothing about the list is ever returned.
//   - admin WITH a users doc → the ordinary session for that doc (same
//     tokens as password login), flagged isAdmin. Works even when the doc
//     has no passwordHash or is still 'pending' — the exact stuck case.
//   - admin WITHOUT a users doc → the synthetic admin identity (see
//     issueAdminOnlySession above).
//   - anyone else → the same generic bad-credentials failure as a wrong
//     password; the response never confirms or denies list membership
//     beyond what the flow itself shows, and never lists admins.
// Students are untouched: their login still requires the password.
// Stricter per-route limiter ON TOP of the global /api/auth limiter in
// app.js — guessing admin emails is the only attack this opens.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => fail(res, 429, 'too_many_requests', 'بہت زیادہ کوششیں ہو گئی ہیں — کچھ دیر بعد دوبارہ کوشش کریں'),
});
router.post('/admin-login', adminLoginLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const log = (result) => console.log(`admin-login email=${email || '(empty)'} result=${result} ip=${req.ip || ''}`);
  if (!email) { log('missing_email'); return fail(res, 400, 'missing_fields', 'ای میل درکار ہے'); }
  try {
    const db = await getDb();
    const adminDoc = EMAIL_RE.test(email) ? await db.collection('admins').findOne({ _id: email }) : null;
    if (!adminDoc) { log('rejected'); return fail(res, 403, 'bad_credentials', 'ای میل یا پاس ورڈ غلط ہے'); }
    const user = await db.collection('users').findOne({ email });
    if (user) { log('ok_users_doc'); return issueSession(db, user, res, { isAdmin: true }); }
    log('ok_admin_only');
    return issueAdminOnlySession(db, adminDoc, res);
  } catch (e) {
    log('server_error');
    return fail(res, 500, 'server_error', 'سرور کی خرابی');
  }
});

// POST /api/auth/re-register — THE decided password-migration flow.
// Migrated users docs have NO passwordHash (Firebase passwords cannot
// move). A student submits their REGISTERED email + a new password:
//   - exactly one doc matches AND it has no password yet → set the hash,
//     mark migrated, keep status untouched (approved stays approved and
//     can log in immediately; pending stays pending for admin approval).
//   - exactly one doc matches AND it already has a password → refuse
//     (never overwrite an existing password on an email-only claim —
//     that would let anyone knowing an email hijack the account).
//     The client then offers the normal login screen.
//   - no doc matches → create a normal new registration (status pending).
//   - multiple docs share the email → refuse + flag for admin resolution
//     (unique index normally prevents this; the branch is defensive).
router.post('/re-register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'درست ای میل لکھیں');
  if (!password || password.length < 8) return fail(res, 400, 'weak_password', 'پاس ورڈ کم از کم 8 حروف کا ہو');
  try {
    const db = await getDb();
    const norm = String(email).toLowerCase();
    const matches = await db.collection('users').find({ email: norm }).toArray();
    if (matches.length > 1) {
      await db.collection('migrationFlags').updateOne(
        { email: norm },
        { $set: { email: norm, reason: 'duplicate_email', at: new Date().toISOString() } },
        { upsert: true }
      );
      return fail(res, 409, 'duplicate_email', 'یہ ای میل ایک سے زیادہ ریکارڈز میں ہے — انتظامیہ سے رابطہ کریں');
    }
    if (matches.length === 1) {
      const user = matches[0];
      if (user.passwordHash) {
        return res.json({ outcome: 'already_migrated', status: user.status || 'pending', message: 'اس ای میل کا پاس ورڈ پہلے سے بنا ہوا ہے — سیدھا لاگ ان کریں' });
      }
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(password), migratedAt: new Date().toISOString(), migratedVia: 're-register' } }
      );
      return res.json({ outcome: 'migrated', status: user.status || 'pending', message: user.status === 'approved' ? 'پاس ورڈ بن گیا — اب لاگ ان کریں' : 'پاس ورڈ بن گیا — منظوری کے بعد رسائی کھلے گی' });
    }
    const now = new Date().toISOString();
    const doc = {
      _id: `u_${Date.now().toString(36)}`,
      uid: `u_${Date.now().toString(36)}`,
      email: norm, name: name || '', status: 'pending', role: 'student',
      passwordHash: await hashPassword(password),
      regAt: now, profile: {}, refreshTokens: [],
    };
    await db.collection('users').insertOne(doc);
    return res.status(201).json({ outcome: 'new_registration', status: 'pending', message: 'درخواست موصول — انتظامیہ کی منظوری کے بعد رسائی کھلے گی' });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'email_taken', 'یہ ای میل پہلے سے درج ہے');
    return fail(res, 500, 'server_error', 'سرور کی خرابی');
  }
});

// POST /api/auth/refresh — rotates the refresh token (old hash revoked).
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return fail(res, 400, 'missing_fields', 'ری فریش ٹوکن درکار ہے');
  const db = await getDb();
  const hash = hashToken(refreshToken);
  const user = await db.collection('users').findOne({ 'refreshTokens.hash': hash });
  if (!user) {
    // Admin without a users doc: their refresh hashes live on the admins
    // doc (see /admin-login). Rotate exactly as for users — old hash
    // revoked first, then a fresh pair.
    const adminDoc = await db.collection('admins').findOne({ 'refreshTokens.hash': hash });
    if (!adminDoc) return fail(res, 401, 'bad_token', 'ری فریش ٹوکن غلط ہے');
    const aEntry = (adminDoc.refreshTokens || []).find((t) => t.hash === hash);
    if (!aEntry || new Date(aEntry.expiresAt) < new Date()) {
      return fail(res, 401, 'bad_token', 'ری فریش ٹوکن ختم ہو گیا ہے');
    }
    await db.collection('admins').updateOne(
      { _id: adminDoc._id }, { $pull: { refreshTokens: { hash } } }
    );
    return issueAdminOnlySession(db, adminDoc, res);
  }
  const entry = (user.refreshTokens || []).find((t) => t.hash === hash);
  if (!entry || new Date(entry.expiresAt) < new Date()) {
    return fail(res, 401, 'bad_token', 'ری فریش ٹوکن ختم ہو گیا ہے');
  }
  await db.collection('users').updateOne(
    { _id: user._id }, { $pull: { refreshTokens: { hash } } }
  );
  return issueSession(db, user, res);
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    const db = await getDb();
    const hash = hashToken(refreshToken);
    await db.collection('users').updateMany(
      {}, { $pull: { refreshTokens: { hash } } }
    );
    // Admin-only sessions keep their hashes on the admins doc (see
    // /admin-login) — revoke there too so logout really ends the session.
    await db.collection('admins').updateMany(
      {}, { $pull: { refreshTokens: { hash } } }
    );
  }
  return res.json({ ok: true });
});

// POST /api/auth/forgot-password — HONEST ERROR (2026-10-29): no email
// provider is wired, so no link is ever sent. The old code answered OK and
// stored a token, which made clients display a false "link sent" message —
// the exact complaint behind the login crisis. Passwords are now set via the
// re-register panel on the login screen, never via email.
router.post('/forgot-password', async (req, res) => {
  return fail(res, 501, 'email_not_configured', 'ای میل لنک کا راستہ بند ہے — لاگ ان اسکرین پر سنہری بٹن «پہلی بار نئی ایپ میں لاگ ان کریں» سے نیا پاس ورڈ بنائیں');
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) return fail(res, 400, 'bad_request', 'ٹوکن اور نیا پاس ورڈ درکار ہیں');
  const db = await getDb();
  const user = await db.collection('users').findOne({ resetTokenHash: hashToken(token) });
  if (!user || !user.resetExpiresAt || new Date(user.resetExpiresAt) < new Date()) {
    return fail(res, 400, 'bad_token', 'لنک غلط یا ختم شدہ ہے');
  }
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(password) }, $unset: { resetTokenHash: '', resetExpiresAt: '' } }
  );
  return res.json({ ok: true, message: 'پاس ورڈ بدل گیا ہے' });
});

// Magic-link login — HONEST ERROR (2026-10-29): same reason as
// forgot-password above. No email provider is wired, so no link is sent and
// no token is stored. Admins sign in passwordlessly via /admin-login
// (Gmail only — Mufti, 2026-10-30); the admin flag comes from the admins
// collection, not from any link.
router.post('/magic-link', async (req, res) => {
  return fail(res, 501, 'email_not_configured', 'ای میل لنک کا راستہ بند ہے — لاگ ان اسکرین پر اپنی ایڈمن ای میل + نیا پاس ورڈ سے داخل ہوں (پہلی بار سنہری بٹن سے پاس ورڈ بنائیں)');
});

router.post('/magic-redeem', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return fail(res, 400, 'missing_fields', 'لنک ٹوکن درکار ہے');
  const db = await getDb();
  const user = await db.collection('users').findOne({ loginTokenHash: hashToken(token) });
  if (!user || !user.loginExpiresAt || new Date(user.loginExpiresAt) < new Date()) {
    return fail(res, 400, 'bad_token', 'لنک غلط یا ختم شدہ ہے');
  }
  await db.collection('users').updateOne(
    { _id: user._id }, { $unset: { loginTokenHash: '', loginExpiresAt: '' } }
  );
  return issueSession(db, user, res);
});

module.exports = router;
