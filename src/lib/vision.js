'use strict';
// Vision auto-review — the MongoDB-side enforcement of the rules that
// used to run ONLY in the Firestore-bound automation
// (~/workspace/shaaba-app/automation/vision_review.py). That script can
// no longer see new submissions (students live in MongoDB now), so the
// verdict is applied HERE, at submission time, by exactly one function:
//
//   applyVisionReview(db, user, text)
//     - one decision per text: same hash + an existing decision
//       (approve/incomplete/borderline) -> nothing changes.
//     - an admin's 'incomplete' decision record is never silently
//       overwritten by a borderline re-score of a new text.
//     - approve: only a PENDING account moves to 'approved'; any
//       previous incomplete marker is cleared; the welcome notification
//       goes out with the old flow's deterministic id
//       (welcome-approved-<uid>), exactly once.
//     - incomplete (junk / thin): the marker is set
//       {reason:'vision', state:'awaiting', source:'auto'} and the
//       notification goes out as incomplete-auto-<uid>-<hash>,
//       exactly once — the same ids/texts the Python flow used.
//     - borderline: the review is recorded; the human decides.
//   healVisionRecords(db)
//     - boot-time, idempotent: backfills a missing top-level name from
//       profile.name, and applies the verdict to pending students who
//       HAVE a visionSummary but NO visionReview decision yet. Records
//       that already have a verdict or a name are never touched, and
//       students with a human 'awaiting' incomplete are skipped (the
//       Python decide() rule).
const { scoreVision, visionHash } = require('./rules');

const APP_LINK_LINE = 'ایپ کا لنک: https://madrassafalkiyyat-sudo.github.io/ilmi-mashghuliyat/';

function urduDate(d) {
  try { return new Intl.DateTimeFormat('ur-PK').format(d || new Date()); } catch (e) { return ''; }
}

async function notifyOnce(db, doc) {
  await db.collection('notifications').updateOne(
    { email: doc.email, id: doc.id },
    { $setOnInsert: { _id: doc.id, ...doc } },
    { upsert: true }
  );
}

function incompleteReasonText(result) {
  let t = 'وژن کا خلاصہ درست نہیں — خلاصے میں ادارے کے وژن کا اپنا تصور واضح نہیں';
  if (result.junk && result.junkReason) t += ` (${result.junkReason})`;
  t += ` (خودکار جائزہ: اسکور ${result.score}/8`;
  t += result.matched && result.matched.length
    ? ` — ملے گروپ: ${result.matched.join('، ')}`
    : ' — وژن کا کوئی تصور نہیں ملا';
  return t + ')';
}

async function applyVisionReview(db, user, text) {
  const clean = String(text || '');
  const hash = visionHash(clean);
  const prev = user.visionReview || {};
  if (prev.hash === hash && ['approve', 'incomplete', 'borderline'].includes(prev.decision)) {
    return { applied: false, skipped: 'same-hash', review: prev, status: user.status };
  }
  const result = scoreVision(clean);
  const now = new Date();
  // An admin's incomplete decision is a human decision: a borderline
  // re-score of a corrected text must not erase it. (A resolving
  // decision — approve/incomplete on the NEW text — is the student's
  // resubmission being answered, exactly as the old cycle did once the
  // record flipped to 'resubmitted'.)
  if (prev.source === 'admin' && prev.decision === 'incomplete' && result.decision === 'borderline') {
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { visionSummary: clean.slice(0, 4000), visionDate: now.toISOString() } }
    );
    return { applied: false, skipped: 'admin-decision-kept', review: prev, status: user.status };
  }
  const review = {
    decision: result.decision, score: result.score, matched: result.matched,
    hash, at: now.toISOString(), source: 'auto',
    by: 'استاد (خودکار — ایڈمن کی حیثیت سے)',
  };
  const set = {
    visionSummary: clean.slice(0, 4000),
    visionDate: now.toISOString(),
    visionReview: review,
  };
  const uid = user.uid || user._id;
  const activity = Array.isArray(user.activity) ? [...user.activity] : [];

  if (result.decision === 'approve' && user.status === 'pending') {
    set.status = 'approved';
    if (user.incomplete) set.incomplete = null;
    if (user.incompleteReason) set.incompleteReason = '';
    activity.push({
      date: urduDate(now),
      txt: `خودکار — استاد: وژن جائزہ میں منظوری (اسکور ${result.score}/8: ${result.matched.join('، ')})`,
    });
    set.activity = activity;
    await db.collection('users').updateOne({ _id: user._id }, { $set: set });
    await notifyOnce(db, {
      id: `welcome-approved-${uid}`, email: user.email,
      title: '🎉 خوش آمدید — آپ کی رجسٹریشن منظور ہو گئی ہے',
      body: `السلام علیکم ${user.name || ''}! مبارک ہو — آپ کی رجسٹریشن شعبہ علمی مشغولیت میں منظور ہو گئی ہے۔ اب ایپ میں لاگ ان کر کے پہلے اپنا پروفائل مکمل کریں (تصویر و دستاویز سمیت) اور پھر شعبے کے واٹس ایپ گروپ میں شامل ہوں — ایپ ہر قدم خود بتاتی جائے گی۔ ${APP_LINK_LINE}`,
      kind: 'welcome-approved', source: 'auto', date: urduDate(now), read: false,
    });
    return { applied: true, review, status: 'approved' };
  }

  if (result.decision === 'incomplete' && user.status === 'pending') {
    const reasonTxt = incompleteReasonText(result);
    set.incomplete = { reason: 'vision', note: reasonTxt, at: now.toISOString(), state: 'awaiting', source: 'auto' };
    set.incompleteReason = 'vision';
    activity.push({ date: urduDate(now), txt: 'خودکار — استاد: وژن جائزہ میں «نامکمل» — ' + reasonTxt });
    set.activity = activity;
    await db.collection('users').updateOne({ _id: user._id }, { $set: set });
    await notifyOnce(db, {
      id: `incomplete-auto-${uid}-${hash}`, email: user.email,
      title: '📋 آپ کی معلومات نامکمل قرار دی گئی ہیں',
      body: `السلام علیکم ${user.name || ''}! انتظامیہ کے جائزے پر آپ کی معلومات «نامکمل» قرار دی گئی ہیں۔\nوجہ: ${reasonTxt}\nاگلا قدم: ایپ میں داخل ہو کر وژن کا خلاصہ اپنے الفاظ میں درست و مکمل (کم از کم 90 الفاظ) لکھ کر دوبارہ جمع کرائیں — کمی پوری ہوتے ہی آپ کا ریکارڈ دوبارہ جائزے میں آ جائے گا۔`,
      kind: 'incomplete', source: 'auto', date: urduDate(now), read: false,
    });
    return { applied: true, review, status: user.status };
  }

  // Borderline — or a decision for a non-pending account: record the
  // review only. Status, markers and notifications are untouched.
  await db.collection('users').updateOne({ _id: user._id }, { $set: set });
  return { applied: true, review, status: user.status };
}

// Boot-time self-heal (idempotent — safe on every restart):
//  (1) name backfill: top-level name empty/missing AND profile.name is a
//      non-empty string -> copy it up. (Registration records carry the
//      name at top level; this only repairs docs whose name landed
//      under profile.* by another writer.)
//  (2) verdict backfill: PENDING students with a stored visionSummary
//      but no visionReview.decision get the standard verdict applied
//      (which may approve / mark incomplete / record borderline, with
//      the usual exactly-once notifications). Skipped, per the Python
//      decide() rules: sample records, and students whose human
//      'incomplete' decision is still awaiting their correction.
async function healVisionRecords(db) {
  const counts = { namesFilled: 0, reviewed: 0, approved: 0, incomplete: 0, borderline: 0, skipped: 0 };
  const nameCands = await db.collection('users')
    .find({ 'profile.name': { $type: 'string', $ne: '' } }).toArray();
  for (const u of nameCands) {
    const pn = String((u.profile && u.profile.name) || '').trim();
    if (pn && !String(u.name || '').trim()) {
      const r = await db.collection('users').updateOne(
        { _id: u._id, $or: [{ name: { $exists: false } }, { name: '' }, { name: null }] },
        { $set: { name: pn } }
      );
      if (r.modifiedCount) counts.namesFilled += 1;
    }
  }
  const cands = await db.collection('users')
    .find({ status: 'pending', visionSummary: { $type: 'string', $ne: '' } }).toArray();
  for (const u of cands) {
    if (u.visionReview && u.visionReview.decision) { counts.skipped += 1; continue; }
    if (u.sample) { counts.skipped += 1; continue; }
    if (u.incomplete && u.incomplete.state === 'awaiting') { counts.skipped += 1; continue; }
    const r = await applyVisionReview(db, u, u.visionSummary);
    if (r.applied) {
      counts.reviewed += 1;
      if (r.review && r.review.decision === 'approve') counts.approved += 1;
      else if (r.review && r.review.decision === 'incomplete') counts.incomplete += 1;
      else if (r.review && r.review.decision === 'borderline') counts.borderline += 1;
    } else {
      counts.skipped += 1;
    }
  }
  console.log('vision heal:', JSON.stringify(counts));
  return counts;
}

module.exports = { applyVisionReview, healVisionRecords, incompleteReasonText };
