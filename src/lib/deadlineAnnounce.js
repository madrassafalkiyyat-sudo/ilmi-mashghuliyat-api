'use strict';
// «⏰ آخری موقع» — deadline announcements, revived INSIDE the new
// (MongoDB) system. Mufti approved 2026-11-03: the home announcements
// strip had gone empty because the series was fed by the Firestore-era
// automation (shaaba-app/automation/deadline_announce.py, now paused)
// and nothing wrote announcements into MongoDB.
//
// Rules mirrored faithfully from deadline_announce.py + the expired
// announcement docs it produced (Firestore export 2026-10-26):
//   - source: the `news` collection; categories ONLY
//     {سکالرشپس، کانفرنسز، داخلے و ایونٹس}; sample items excluded;
//   - the item's `expiresAt` must strictly parse as an ISO date
//     (the old P._parse_date semantics: first 10 chars, real date) —
//     anything else is SKIPPED, never guessed;
//   - window: deadline 0..7 days from today (Asia/Karachi);
//   - one announcement per item, deterministic id `deadline-<newsId>`,
//     upserted — re-runs never duplicate;
//   - title «⏰ آخری موقع: <item title>»;
//     body «<item title>» کی آخری تاریخ <اردو تاریخ> ہے — <باقی دن>۔
//     + the standing pointer to «خبریں و اسکالرشپس» / «قریبی آخری تاریخیں»;
//   - from «انتظامیہ», audience 'all', auto: true,
//     linkType/linkId/newsId point back at the source item;
//   - the announcement expires at the item's own deadline.
//
// Two deliberate, disclosed adaptations to the new system:
//   1. expiresAt is stored as the END of the deadline day in Karachi
//      (`<date>T18:59:59.999Z`). The old store used the bare date, but
//      the new API's read filter compares full ISO strings against the
//      current instant, so a bare date would drop the announcement on
//      its final day — the «آج آخری دن ہے» day, the most important one.
//      The date part (all the client's notExpired() reads) is unchanged.
//   2. The days-left wording is refreshed by the daily upsert (original
//      createdAt preserved). The old engine created once and never
//      updated (its docs' wording matches their creation date exactly);
//      the countdown text is part of the format, so it is kept truthful.
//
// Placement: server.js's existing boot + hourly tick family (the same
// one that runs the course release engine), guarded to one effective
// pass per Karachi date; the upserts are idempotent, so a restart or a
// manual trigger (POST /api/admin/deadline-announcements/run) is safe.

const { karachiToday } = require('./expiry');

const CATS = new Set(['سکالرشپس', 'کانفرنسز', 'داخلے و ایونٹس']);
const WINDOW_DAYS = 7;
const PREFIX = 'deadline-';

const URDU_MONTHS = {
  1: 'جنوری', 2: 'فروری', 3: 'مارچ', 4: 'اپریل', 5: 'مئی', 6: 'جون',
  7: 'جولائی', 8: 'اگست', 9: 'ستمبر', 10: 'اکتوبر', 11: 'نومبر', 12: 'دسمبر',
};

function urDigits(x) {
  return String(x).replace(/[0-9]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[Number(c)]);
}

// Strict ISO calendar date from the first 10 chars (old _parse_date).
// Returns 'YYYY-MM-DD' or null — never a guess.
function parseISODateStrict(s) {
  if (s === null || s === undefined) return null;
  const head = String(s).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return head;
}

function daysBetween(fromYmd, toYmd) {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// «۵ نومبر ۲۰۲۶» — the old M.urdu_date format.
function urduDate(ymd) {
  const [, mo, d] = ymd.split('-').map(Number);
  const y = ymd.slice(0, 4);
  return `${urDigits(d)} ${URDU_MONTHS[mo]} ${urDigits(y)}`;
}

function daysLeftText(left) {
  if (left === 0) return 'آج آخری دن ہے';
  if (left === 1) return 'کل آخری دن ہے';
  return `صرف ${urDigits(left)} دن باقی ہیں`;
}

// End of the deadline day in Karachi, as a UTC instant (adaptation 1).
function karachiEndOfDay(ymd) {
  return `${ymd}T18:59:59.999Z`;
}

function announcementDoc(n, expiryYmd, runDate) {
  const newsId = n.id || n._id;
  const left = daysBetween(runDate, expiryYmd);
  const title = n.title || '';
  return {
    _id: `${PREFIX}${newsId}`,
    id: `${PREFIX}${newsId}`,
    title: `⏰ آخری موقع: ${title}`,
    body: (`«${title}» کی آخری تاریخ ${urduDate(expiryYmd)} ہے — ${daysLeftText(left)}۔ `
      + 'تفصیل و اپلائی کا مکمل طریقہ ایپ کے حصے «خبریں و اسکالرشپس» میں دیکھیں '
      + 'اور ہوم کے «قریبی آخری تاریخیں» میں بھی یہ اندراج موجود ہے۔'),
    from: 'انتظامیہ',
    sample: false,
    audience: 'all',
    auto: true,
    newsId,
    linkType: 'news',
    linkId: newsId,
    expiresAt: karachiEndOfDay(expiryYmd),
    createdAt: runDate,
  };
}

// Pure planner (mirrors the old plan_announcements' selection logic).
// Returns { docs, skippedUnparseable: [{id, title, expiresAt}], counts }.
function planDeadlineAnnouncements(newsDocs, runDate) {
  const docs = [];
  const skippedUnparseable = [];
  let inCats = 0, outOfWindow = 0;
  for (const n of newsDocs || []) {
    if (n.sample) continue;
    if (!CATS.has(String(n.cat || '').trim())) continue;
    inCats += 1;
    const newsId = n.id || n._id;
    if (!newsId) continue;
    const ex = parseISODateStrict(n.expiresAt);
    if (ex === null) {
      if (n.expiresAt !== null && n.expiresAt !== undefined && String(n.expiresAt).trim() !== '') {
        skippedUnparseable.push({ id: newsId, title: n.title || '', expiresAt: n.expiresAt });
      }
      continue;
    }
    const left = daysBetween(runDate, ex);
    if (left < 0 || left > WINDOW_DAYS) { outOfWindow += 1; continue; }
    docs.push(announcementDoc(n, ex, runDate));
  }
  return { docs, skippedUnparseable, counts: { inCats, outOfWindow } };
}

let lastRunDate = null;

// One daily pass. Safe to call hourly / at boot / manually: the date
// guard makes repeats within a Karachi date no-ops (unless forced),
// and every write is a deterministic-id upsert.
async function runDeadlineAnnouncements(db, opts) {
  const force = !!(opts && opts.force);
  const today = karachiToday();
  if (!force && lastRunDate === today) {
    return { ok: true, runDate: today, skippedRun: 'already-ran-today', created: 0, refreshed: 0 };
  }
  const news = await db.collection('news').find({}).toArray();
  const plan = planDeadlineAnnouncements(news, today);
  let created = 0, refreshed = 0;
  for (const doc of plan.docs) {
    const { createdAt, ...mutable } = doc;
    const r = await db.collection('announcements').updateOne(
      { _id: doc._id },
      { $set: mutable, $setOnInsert: { createdAt } },
      { upsert: true }
    );
    if (r.upsertedCount) created += 1; else refreshed += 1;
  }
  lastRunDate = today;
  const summary = {
    ok: true,
    runDate: today,
    created,
    refreshed,
    live: plan.docs.map((d) => ({ id: d.id, title: d.title, expiresAt: d.expiresAt })),
    skippedUnparseable: plan.skippedUnparseable,
    counts: plan.counts,
  };
  console.log(`deadline-announce: ${today} — created ${created}, refreshed ${refreshed}, `
    + `unparseable-skipped ${plan.skippedUnparseable.length}`);
  return summary;
}

module.exports = {
  runDeadlineAnnouncements,
  planDeadlineAnnouncements,
  parseISODateStrict,
  CATS,
  WINDOW_DAYS,
};
