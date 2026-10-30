'use strict';
// Public/approved content: announcements, news, jobs, publications,
// journals, courseContent, graduates, spotlights. Reads are open to
// approved students (and admins); writes are admin-only. Expired items
// (expiresAt in the past) are never returned to students — the old app
// relied on a nightly purge, the API enforces expiry on read as well.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireApproved, fail } = require('../middleware/auth');
const { isExpiredGuardedDoc } = require('../lib/expiry');

const router = express.Router();
router.use(requireAuth, requireApproved);

const READABLE = ['announcements', 'news', 'jobs', 'publications', 'journals', 'courseContent', 'graduates', 'spotlights', 'courses', 'sessionAttendees'];

function notExpiredFilter() {
  const now = new Date().toISOString();
  return { $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gte: now } }] };
}

function page(req) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  return { limit, cursor: req.query.cursor || null };
}

// GET /api/content/:collection — list (approved students + admins).
router.get('/:collection', async (req, res) => {
  const coll = req.params.collection;
  if (!READABLE.includes(coll)) return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں');
  const db = await getDb();
  const { limit, cursor } = page(req);
  const filter = notExpiredFilter();
  if (cursor) filter._id = { $lt: cursor };
  let docs = await db.collection(coll).find(filter).sort({ _id: -1 }).limit(limit).toArray();
  // Expiry guard (Mufti, 2026-10-31): کانفرنسز/سکالرشپس whose own
  // deadline text has fully passed are hidden from STUDENTS even when
  // expiresAt is missing or misleading — see lib/expiry.js for the
  // conservative rule (latest parsed date governs; no date → visible).
  // Admins keep seeing everything, exactly as before.
  if (coll === 'news' && !req.isAdmin) {
    const before = docs.length;
    docs = docs.filter((d) => !isExpiredGuardedDoc(d));
    const hidden = before - docs.length;
    if (hidden > 0) console.log(`content-guard: hid ${hidden} expired conference/scholarship news item(s) from student feed`);
  }
  return res.json({ docs, nextCursor: docs.length ? docs[docs.length - 1]._id : null });
});

// GET /api/content/:collection/:id — single item.
router.get('/:collection/:id', async (req, res) => {
  const coll = req.params.collection;
  if (!READABLE.includes(coll)) return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں');
  const db = await getDb();
  const doc = await db.collection(coll).findOne({ _id: req.params.id });
  if (!doc) return fail(res, 404, 'not_found', 'شے نہیں ملی');
  // Same guard on the direct link (e.g. from an old notification):
  // students get the ordinary not-found; admins still open the item.
  if (coll === 'news' && !req.isAdmin && isExpiredGuardedDoc(doc)) {
    return fail(res, 404, 'not_found', 'شے نہیں ملی');
  }
  return res.json({ doc });
});

// Admin writes (create/update/delete). Students have no write route here.
router.post('/:collection', requireAdmin, async (req, res) => {
  const coll = req.params.collection;
  if (!READABLE.includes(coll)) return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں');
  const data = req.body && req.body.doc;
  if (!data || typeof data !== 'object') return fail(res, 400, 'bad_request', 'ڈیٹا درکار ہے');
  const db = await getDb();
  const id = data.id || `x${Date.now().toString(36)}`;
  const doc = { ...data, _id: id, id };
  await db.collection(coll).updateOne({ _id: id }, { $set: doc }, { upsert: true });
  return res.status(201).json({ doc });
});

router.delete('/:collection/:id', requireAdmin, async (req, res) => {
  const coll = req.params.collection;
  if (!READABLE.includes(coll)) return fail(res, 404, 'not_found', 'یہ مجموعہ موجود نہیں');
  const db = await getDb();
  await db.collection(coll).deleteOne({ _id: req.params.id });
  return res.json({ ok: true });
});

module.exports = router;
