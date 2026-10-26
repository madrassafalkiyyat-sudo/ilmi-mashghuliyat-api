'use strict';
// Auth routes. Passwords never leave this file's hashing calls.
// NOTE on migration: Firebase Auth passwords cannot be transferred, so
// accounts created by the migration have NO passwordHash until the student
// sets one (see OPEN-DECISIONS.md). Login without a passwordHash is
// refused with code 'no_password_set' and the client offers the magic-link
// or forgot-password flow instead.
const express = require('express');
const { getDb } = require('../db');
const { hashPassword, checkPassword, signAccessToken, hashToken, newRefreshToken } = require('../auth');
const { fail } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { uid: u._id, email: u.email, name: u.name, status: u.status || 'pending', role: u.role || 'student' };
}

async function issueSession(db, user, res) {
  const refresh = newRefreshToken();
  const expires = new Date(Date.now() + config.refreshExpiresDays * 86400000);
  await db.collection('users').updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { hash: hashToken(refresh), expiresAt: expires.toISOString() } } }
  );
  return res.json({ accessToken: signAccessToken(user), refreshToken: refresh, user: publicUser(user) });
}

// POST /api/auth/register — creates a users doc in status 'pending'.
// The old app hid the login surface before approval; the API mirrors it:
// a pending account receives a token but requireApproved blocks gated
// content until an admin approves.
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'درست ای میل لکھیں');
  if (!password || password.length < 8) return fail(res, 400, 'weak_password', 'پاس ورڈ کم از کم 8 حروف کا ہو');
  try {
    const db = await getDb();
    const norm = String(email).toLowerCase();
    const existing = await db.collection('users').findOne({ email: norm });
    if (existing) return fail(res, 409, 'email_taken', 'یہ ای میل پہلے سے درج ہے');
    const now = new Date().toISOString();
    const doc = {
      _id: `u_${Date.now().toString(36)}`,
      uid: `u_${Date.now().toString(36)}`,
      email: norm, name: name || '', status: 'pending', role: 'student',
      passwordHash: await hashPassword(password),
      regAt: now, profile: {}, refreshTokens: [],
    };
    await db.collection('users').insertOne(doc);
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
  if (!user) return fail(res, 401, 'bad_token', 'ری فریش ٹوکن غلط ہے');
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
    await db.collection('users').updateMany(
      {}, { $pull: { refreshTokens: { hash: hashToken(refreshToken) } } }
    );
  }
  return res.json({ ok: true });
});

// POST /api/auth/forgot-password — always answers OK (no account
// enumeration). Actual delivery needs an email provider (OPEN-DECISIONS.md);
// the token is stored hashed with a 1-hour expiry, never logged.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (email && EMAIL_RE.test(email)) {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email: String(email).toLowerCase() });
    if (user) {
      const token = newRefreshToken();
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { resetTokenHash: hashToken(token), resetExpiresAt: new Date(Date.now() + 3600000).toISOString() } }
      );
      // TODO (provider step): send the reset link via the chosen email
      // provider. The link target is the Pages app with ?reset=<token>.
      // Never print the token to logs.
    }
  }
  return res.json({ ok: true, message: 'اگر یہ ای میل درج ہے تو ری سیٹ لنک بھیج دیا گیا ہے' });
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

// Magic-link login (the migration bridge: works before any password is
// set). Request stores a hashed single-use token; redeeming it issues a
// session and immediately lets the student set a password.
router.post('/magic-link', async (req, res) => {
  const { email } = req.body || {};
  if (email && EMAIL_RE.test(email)) {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email: String(email).toLowerCase() });
    if (user) {
      const token = newRefreshToken();
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { loginTokenHash: hashToken(token), loginExpiresAt: new Date(Date.now() + 3600000).toISOString() } }
      );
      // TODO (provider step): email the ?login=<token> link. Never log it.
    }
  }
  return res.json({ ok: true, message: 'اگر یہ ای میل درج ہے تو لاگ ان لنک بھیج دیا گیا ہے' });
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
