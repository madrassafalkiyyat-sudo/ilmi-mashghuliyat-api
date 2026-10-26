'use strict';
// Own notifications. The old app filtered client-side by email == ;
// the API filters by the JWT identity, so a student can never read
// another student's notifications. Exactly-once is enforced by the
// (email, id) unique index + upsert in the writers.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, fail } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications?unread=1 — own notifications, newest first.
router.get('/', async (req, res) => {
  const db = await getDb();
  const filter = { email: req.user.email };
  if (req.query.unread === '1') filter.read = false;
  const docs = await db.collection('notifications')
    .find(filter).sort({ date: -1 }).limit(200).toArray();
  return res.json({ docs });
});

// GET /api/notifications/unread-count — bell badge number.
router.get('/unread-count', async (req, res) => {
  const db = await getDb();
  const count = await db.collection('notifications')
    .countDocuments({ email: req.user.email, read: false });
  return res.json({ unread: count });
});

// POST /api/notifications/:id/read — mark one own notification read.
router.post('/:id/read', async (req, res) => {
  const db = await getDb();
  await db.collection('notifications').updateOne(
    { email: req.user.email, id: req.params.id },
    { $set: { read: true } }
  );
  return res.json({ ok: true });
});

// POST /api/notifications/read-all — mark all own notifications read.
router.post('/read-all', async (req, res) => {
  const db = await getDb();
  await db.collection('notifications').updateMany(
    { email: req.user.email, read: false }, { $set: { read: true } }
  );
  return res.json({ ok: true });
});

module.exports = router;
