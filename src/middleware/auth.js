'use strict';
// JWT authentication + role gates. Every protected route uses requireAuth;
// role gates are additive and must never be bypassed by client input.
const { verifyAccessToken } = require('../auth');
const { getDb } = require('../db');
const { isAdmin } = require('../lib/rules');

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail(res, 401, 'no_token', 'لاگ ان درکار ہے');
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (e) {
    return fail(res, 401, 'bad_token', 'سیشن ختم ہو گیا ہے، دوبارہ لاگ ان کریں');
  }
  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ _id: payload.sub });
    if (user) {
      req.user = user;
      req.auth = payload;
      req.isAdmin = await isAdmin(db, user.email || payload.email);
      return next();
    }
    // Admin without a users doc (staff email-link path in the old app):
    // identity comes from the admins collection alone. The synthetic
    // record is marked so own-data routes (which filter by email) still
    // behave, and it can never gain student-only state.
    const adminDoc = await db.collection('admins').findOne({ _id: String(payload.email || '').toLowerCase() });
    if (adminDoc) {
      req.user = { _id: `admin:${payload.email}`, email: payload.email, name: payload.email, status: 'approved', role: 'admin', adminOnly: true };
      req.auth = payload;
      req.isAdmin = true;
      return next();
    }
    return fail(res, 401, 'no_user', 'صارف موجود نہیں');
  } catch (e) {
    return fail(res, 500, 'server_error', 'سرور کی خرابی');
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return fail(res, 403, 'admin_only', 'یہ عمل صرف انتظامیہ کے لیے ہے');
  return next();
}

// Gated content (news, jobs, courses, spotlights, …) is visible only to
// approved students and admins — never to pending/rejected accounts.
function requireApproved(req, res, next) {
  if (req.isAdmin) return next();
  if (req.user && req.user.status === 'approved') return next();
  return fail(res, 403, 'not_approved', 'منظوری کے بعد یہ حصہ کھلے گا');
}

module.exports = { requireAuth, requireAdmin, requireApproved, fail };
