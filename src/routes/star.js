'use strict';
// Star Team: public member list (men's photos only, per the standing
// rule), recommendations, and student requests. Monthly recommendation
// counting (top 10) is computed from the recommendations collection.
const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireApproved, fail } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireApproved);

// GET /api/star/members — active members, public-safe view.
// Full member docs are returned (starNo/status/sessions included — the
// old app showed them), EXCEPT photos: a photo is served only when the
// member record itself declares a male gender; otherwise it is stripped.
// (Women's photos are never exposed; unknown gender defaults to hidden.)
router.get('/members', async (req, res) => {
  const db = await getDb();
  const members = await db.collection('starTeam')
    .find({ $or: [{ status: 'active' }, { status: { $exists: false } }] }).toArray();
  const safe = members.map((m) => {
    const out = { ...m };
    const gender = m.gender || (m.profile && m.profile.gender);
    if (gender !== 'مرد') delete out.photo;
    if (out.profile && gender !== 'مرد') delete out.profile.photo;
    return out;
  });
  return res.json({ members: safe });
});

// GET /api/star/top?month=YYYY-MM — top 10 recommenders of the month.
router.get('/top', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const db = await getDb();
  const rows = await db.collection('starRecommendations').aggregate([
    { $match: { month } },
    { $group: { _id: '$email', count: { $sum: 1 }, name: { $first: '$name' } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
  return res.json({ month, top: rows });
});

// POST /api/star/recommend — an approved student recommends a peer.
// Target: monthly >= 30 recommendations overall; this endpoint only
// records one recommendation (targets are enforced by admin review).
router.post('/recommend', async (req, res) => {
  const { targetEmail, note } = req.body || {};
  if (!targetEmail) return fail(res, 400, 'missing_fields', 'جس کی سفارش ہے اس کی ای میل درکار ہے');
  const db = await getDb();
  const month = new Date().toISOString().slice(0, 7);
  const id = `${month}:${req.user.email}:${String(targetEmail).toLowerCase()}`;
  await db.collection('starRecommendations').updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id, month, fromEmail: req.user.email, fromName: req.user.name,
        email: String(targetEmail).toLowerCase(), note: note || '',
        date: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
  return res.json({ ok: true });
});

// POST /api/star/request — student applies to join the Star Team.
router.post('/request', async (req, res) => {
  const db = await getDb();
  const id = `${req.user.email}`;
  await db.collection('starRequests').updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id, email: req.user.email, name: req.user.name,
        date: new Date().toISOString(), status: 'pending',
      },
    },
    { upsert: true }
  );
  return res.json({ ok: true });
});

module.exports = router;
