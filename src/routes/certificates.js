'use strict';
// Certificate wallet + course-final certificate state.
// Per the standing rule, individual classes have NO separate certificate;
// the course-final certificate is issued once, at course end, to students
// with full verified attendance (or an admin grant). Session certificates
// (non-course sessions) appear in the wallet when their claim is verified.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireApproved, fail } = require('../middleware/auth');
const { bookAccessState } = require('../lib/rules');

const router = express.Router();
router.use(requireAuth, requireApproved);

// GET /api/certificates/mine — wallet: verified session certificates +
// course-final state (locked/unlocked + progress counts).
router.get('/mine', async (req, res) => {
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  const claims = await db.collection('attendanceClaims')
    .find({ email: req.user.email, status: 'تصدیق شدہ' }).toArray();
  const courseSessions = await db.collection('courseSessions').find({}).toArray();
  const book = bookAccessState(user, courseSessions, claims);
  const wallet = claims
    .filter((c) => !(courseSessions || []).some((s) => s.sessionId === c.sessionId))
    .map((c) => ({
      sessionId: c.sessionId, sessionTitle: c.sessionTitle,
      verifiedAt: c.verifiedAt, type: 'session',
    }));
  return res.json({
    wallet,
    course: {
      registered: !!user.courseReg,
      done: book.done, total: book.total, ended: book.ended, full: book.full,
      unlocked: book.unlocked,
      finalCertificate: book.unlocked ? 'eligible' : 'locked',
    },
  });
});

// GET /api/certificates/book — the book itself (gated by the same lock).
// The file itself is served from the app's existing asset; the API only
// answers whether this student may open it (and records first unlock).
router.get('/book', async (req, res) => {
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: req.user._id });
  const claims = await db.collection('attendanceClaims')
    .find({ email: req.user.email, status: 'تصدیق شدہ' }).toArray();
  const courseSessions = await db.collection('courseSessions').find({}).toArray();
  const book = bookAccessState(user, courseSessions, claims);
  if (!book.unlocked) {
    return fail(res, 403, 'book_locked', 'کتاب مکمل حاضری + کورس تکمیل پر کھلے گی');
  }
  if (!user.bookUnlockedAt) {
    await db.collection('users').updateOne(
      { _id: user._id }, { $set: { bookUnlockedAt: new Date().toISOString() } }
    );
  }
  return res.json({ unlocked: true, done: book.done, total: book.total });
});

// POST /api/certificates/issue — admin issues a certificate record
// (used for session certificates and the course-final certificate).
router.post('/issue', requireAdmin, async (req, res) => {
  const { email, type, sessionId, title } = req.body || {};
  if (!email || !type) return fail(res, 400, 'missing_fields', 'ای میل اور قسم درکار ہیں');
  const db = await getDb();
  const id = `${type}:${email}:${sessionId || 'course-final'}`;
  await db.collection('certificates').updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id, id, email, type, sessionId: sessionId || null, title: title || '',
        issuedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
  return res.json({ ok: true, id });
});

module.exports = router;
