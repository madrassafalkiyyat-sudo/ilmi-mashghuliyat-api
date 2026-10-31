'use strict';
// Admin routes. Admin identity is proven ONLY by the admins collection
// (requireAdmin checks it per request); a users doc alone never grants
// admin rights. Approval order mirrors the old admin list: pending first
// (newest first), then approved, then rejected.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, fail } = require('../middleware/auth');
const { scoreVision } = require('../lib/rules');
const { stripSecrets, isLite, isDataUri, signature, slimUserPhoto, slimSessionPoster } = require('../lib/slim');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function page(req) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  return { limit, cursor: req.query.cursor || null };
}

// GET /api/admin/users?status=pending|approved|rejected (default: all,
// pending first newest-first, then approved, then rejected).
router.get('/users', async (req, res) => {
  const db = await getDb();
  const { limit, cursor } = page(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (cursor) filter._id = { $lt: cursor };
  const docs = await db.collection('users')
    .find(filter).sort({ _id: -1 }).limit(limit).toArray();
  // Pending-first ordering when no status filter is given.
  if (!req.query.status) {
    const order = { pending: 0, approved: 1, rejected: 2 };
    docs.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  }
  const nextCursor = docs.length ? docs[docs.length - 1]._id : null;
  const lite = isLite(req);
  const out = docs.map((d) => (lite ? slimUserPhoto(stripSecrets(d)) : stripSecrets(d)));
  return res.json({ docs: out, nextCursor });
});

// GET /api/admin/users/photos?ids=a,b,c — full photos for the users whose
// photoSig (from ?lite=1) the client has not cached yet. At most 50 ids.
router.get('/users/photos', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return fail(res, 400, 'missing_fields', 'شناخت درکار ہے');
  if (ids.length > 50) return fail(res, 400, 'too_many', 'ایک وقت میں زیادہ سے زیادہ 50');
  const db = await getDb();
  const docs = await db.collection('users')
    .find({ _id: { $in: ids } }, { projection: { 'profile.photo': 1 } }).toArray();
  const photos = {};
  for (const d of docs) {
    const photo = (d.profile && d.profile.photo) || '';
    photos[d._id] = { photo, photoSig: isDataUri(photo) ? signature(photo) : '' };
  }
  return res.json({ photos });
});

// GET /api/admin/users/search?q= — by name or WhatsApp number (normalised:
// digits only, so +92/0 prefixes match).
router.get('/users/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, 'missing_fields', 'تلاش کا لفظ درکار ہے');
  const digits = q.replace(/\D/g, '');
  const db = await getDb();
  const docs = await db.collection('users').find({
    $or: [
      { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { 'profile.whatsapp': { $regex: digits, $options: 'i' } },
    ],
  }).limit(50).toArray();
  return res.json({ docs: docs.map(stripSecrets) });
});

// POST /api/admin/users/:id/approve|reject|incomplete — the three admin
// decisions. 'incomplete' records the reason; the notification is created
// with a deterministic id so a retry cannot duplicate it.
// INCOMPLETE KEEPS STATUS: the old app kept an 'incomplete' student at
// status 'pending' with a separate incomplete marker object ({reason,
// note, at, state:'awaiting'}) — the UI reads u.incomplete.reason/state
// and routes on status !== 'approved'. Overwriting status to the literal
// string 'incomplete' would drop the student from the pending filter and
// lose the reason, so incomplete NEVER changes status here.
async function decide(req, res, status) {
  const db = await getDb();
  const id = req.params.id;
  const reason = (req.body && req.body.reason) || '';
  const note = (req.body && req.body.note) || '';
  const user = await db.collection('users').findOne({ _id: id });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  const update = { $set: {} };
  if (status === 'incomplete') {
    update.$set.incomplete = { reason, note, at: new Date().toISOString(), state: 'awaiting' };
    update.$set.incompleteReason = reason;
    update.$set.visionReview = {
      ...(user.visionReview || {}), decision: 'incomplete', source: 'admin',
      at: new Date().toISOString(), reason,
    };
  } else {
    update.$set.status = status;
    update.$set.incomplete = false;
  }
  await db.collection('users').updateOne({ _id: id }, update);
  // Exactly-once notification for the decision.
  const notifId = `${status}-${id}`;
  await db.collection('notifications').updateOne(
    { email: user.email, id: notifId },
    {
      $setOnInsert: {
        _id: notifId, id: notifId, email: user.email,
        title: status === 'approved' ? 'منظوری' : status === 'rejected' ? 'مسترد' : 'نامکمل',
        body: reason || '', date: new Date().toISOString(), read: false, kind: 'decision',
      },
    },
    { upsert: true }
  );
  // For incomplete the stored status is unchanged (still pending) — report
  // that, not the decision name, so API clients never see a phantom status.
  return res.json({ ok: true, status: status === 'incomplete' ? user.status : status });
}

router.post('/users/:id/approve', (req, res) => decide(req, res, 'approved'));
router.post('/users/:id/reject', (req, res) => decide(req, res, 'rejected'));
router.post('/users/:id/incomplete', (req, res) => decide(req, res, 'incomplete'));

// POST /api/admin/users/:id/clear-incomplete — admin accepts the student's
// fix (UI: adminResolveIncomplete). Clears the marker; status untouched.
router.post('/users/:id/clear-incomplete', async (req, res) => {
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.params.id });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  await db.collection('users').updateOne(
    { _id: req.params.id },
    { $set: { incomplete: null, incompleteReason: '' } }
  );
  return res.json({ ok: true });
});

// POST /api/admin/notify — admin-side notification fan-out (the UI's
// pushNotification/notifyAllApproved/notifyDecision calls). Admin-only,
// upserted by (email, id) so a retry cannot duplicate. This is the bridge
// target for admin-context notification writes; student-context writes
// stay server-owned and are never accepted from the client.
router.post('/notify', async (req, res) => {
  const doc = (req.body && req.body.doc) || {};
  if (!doc.email || !doc.title) return fail(res, 400, 'bad_request', 'ای میل اور عنوان درکار ہیں');
  const db = await getDb();
  const id = doc.id || `n${Date.now().toString(36)}`;
  await db.collection('notifications').updateOne(
    { email: String(doc.email).toLowerCase(), id },
    {
      $setOnInsert: {
        _id: id, id, email: String(doc.email).toLowerCase(),
        title: doc.title, body: doc.body || '', kind: doc.kind || 'general',
        date: doc.date || new Date().toISOString(), read: false,
      },
    },
    { upsert: true }
  );
  return res.json({ ok: true, id });
});

// POST /api/admin/users/:id/book-grant — admin book exception
// (user.bookAccess = true). Mirrors the old individual-exception action.
router.post('/users/:id/book-grant', async (req, res) => {
  const db = await getDb();
  const give = !!(req.body && req.body.give);
  await db.collection('users').updateOne(
    { _id: req.params.id },
    { $set: { bookAccess: give, bookUnlockedAt: give ? new Date().toISOString() : null } }
  );
  return res.json({ ok: true, bookAccess: give });
});

// POST /api/admin/vision-review — admin re-scores a vision (used when a
// student resubmits after 'incomplete'). Human decisions are final here.
router.post('/vision-review', async (req, res) => {
  const { userId, decision, reason } = req.body || {};
  if (!userId || !['approve', 'incomplete', 'borderline'].includes(decision)) {
    return fail(res, 400, 'bad_request', 'درست فیصلہ درکار ہے');
  }
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: userId });
  if (!user) return fail(res, 404, 'not_found', 'طالب علم نہیں ملا');
  const update = {
    $set: {
      visionReview: {
        ...(user.visionReview || {}), decision, source: 'admin',
        at: new Date().toISOString(), reason: reason || '',
      },
    },
  };
  if (decision === 'approve' && user.status === 'pending') update.$set.status = 'approved';
  if (decision === 'incomplete') update.$set.incomplete = true;
  await db.collection('users').updateOne({ _id: userId }, update);
  return res.json({ ok: true, decision });
});

// GET /api/admin/settings/session — the live session doc (settings/session).
router.get('/settings/session', async (req, res) => {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: 'session' });
  return res.json({ session: (isLite(req) ? slimSessionPoster(doc) : doc) || null });
});

// GET /api/admin/migration — migration overview for the admin (counts
// only — no password hashes or tokens are ever returned).
// migrated = users doc has a passwordHash; pendingMigration = migrated
// doc without one (student has not re-registered yet); flags = emails
// that hit the duplicate-email branch of /re-register.
router.get('/migration', async (req, res) => {
  const db = await getDb();
  const total = await db.collection('users').countDocuments({});
  const migrated = await db.collection('users').countDocuments({ passwordHash: { $exists: true, $ne: null } });
  const byStatus = await db.collection('users').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const flags = await db.collection('migrationFlags').find({}).toArray();
  return res.json({
    total,
    migrated,
    pendingMigration: total - migrated,
    byStatus: Object.fromEntries(byStatus.map((r) => [r._id || 'unknown', r.count])),
    flags,
  });
});

// Admin list views (FRONTEND-MAP §5): read-only lists for collections the
// admin console needs beyond /content. sessionSecrets is deliberately
// NOT here — it has its own route below so the code path is explicit.
const ADMIN_LISTABLE = ['sessionArchive', 'counselLogs', 'messages', 'sessionAttendees', 'competitions', 'transfers', 'starRequests', 'courseSessions', 'courses', 'starTeam', 'certificates', 'mailQueue', 'starRecommendations', 'attendanceClaims', 'dashboardData'];
router.get('/lists/:collection', async (req, res) => {
  const coll = req.params.collection;
  if (!ADMIN_LISTABLE.includes(coll)) return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں');
  const db = await getDb();
  const { limit, cursor } = page(req);
  const filter = {};
  if (cursor) filter._id = { $lt: cursor };
  const docs = await db.collection(coll).find(filter).sort({ _id: -1 }).limit(limit).toArray();
  return res.json({ docs, nextCursor: docs.length ? docs[docs.length - 1]._id : null });
});

// Admin upsert for the same lists (e.g. manual roster rows, counsel logs).
// mailQueue is read-only history: writes to it are refused. users,
// notifications, admins and sessionSecrets are never written through here.
router.post('/lists/:collection', async (req, res) => {
  const coll = req.params.collection;
  if (!ADMIN_LISTABLE.includes(coll) || coll === 'mailQueue') {
    return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں یا صرف پڑھنے کے لیے ہے');
  }
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `x${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id };
  await db.collection(coll).updateOne({ _id: id }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

// DELETE /api/admin/lists/:collection/:id — admin deletes one raw dashboard
// entry (the dashboard itself is never edited; only raw entries are added
// or removed here, and the dashboards rebuild from the remaining data).
// Same router-level auth as every other admin route (requireAuth +
// requireAdmin); mailQueue stays read-only like on POST.
router.delete('/lists/:collection/:id', async (req, res) => {
  const coll = req.params.collection;
  if (!ADMIN_LISTABLE.includes(coll) || coll === 'mailQueue') {
    return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں یا صرف پڑھنے کے لیے ہے');
  }
  const db = await getDb();
  await db.collection(coll).deleteOne({ _id: req.params.id });
  return res.json({ ok: true });
});

// GET /api/admin/secrets — attendance secret codes, ADMIN ONLY.
// Students have no route to this collection anywhere in the API.
router.get('/secrets', async (req, res) => {
  const db = await getDb();
  const docs = await db.collection('sessionSecrets').find({}).toArray();
  return res.json({ docs });
});

// POST /api/admin/secrets — admin sets/rotates a session's secret code
// (the only write path for codes; students can never reach this route).
router.post('/secrets', async (req, res) => {
  const { sessionId, code } = req.body || {};
  if (!sessionId || !code) return fail(res, 400, 'missing_fields', 'سیشن اور کوڈ درکار ہیں');
  const db = await getDb();
  await db.collection('sessionSecrets').updateOne(
    { sessionId },
    { $set: { sessionId, code: String(code).trim(), updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
  return res.json({ ok: true, sessionId });
});

// PUT /api/admin/settings/session — publish/update the live session.
router.put('/settings/session', async (req, res) => {
  const db = await getDb();
  const data = req.body && req.body.session;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'سیشن ڈیٹا درکار ہے');
  // posterSig is a lite-mode response field, never stored.
  const { posterSig, _id, ...session } = data;
  await db.collection('settings').updateOne(
    { _id: 'session' }, { $set: session }, { upsert: true }
  );
  return res.json({ ok: true });
});

module.exports = router;
