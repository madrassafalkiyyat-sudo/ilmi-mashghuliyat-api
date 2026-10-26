'use strict';
// Server-side business rules, ported from the current app + automation.
// Every rule that used to run in the browser (or in a Python job) now has
// ONE enforcement point here, so a tampered client cannot bypass it.

// ---------- text normalisation (Urdu/Arabic variants) ----------
// Mirrors the Python vision scorer: ی/ک variants collapse before matching.
function normalizeText(s) {
  return String(s || '')
    .replace(/[يى]/g, 'ی')
    .replace(/[كک]/g, 'ک')
    .replace(/ۃ/g, 'ت')
    .replace(/ؤ/g, 'و')
    .replace(/إ|أ|آ/g, 'ا')
    .replace(/[^\u0600-\u06FF0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- vision auto-review ----------
// 8 concept groups, ported verbatim from automation/vision_review.py.
// Approve: >= 3 groups matched AND at least one core (topical) group.
// Incomplete (junk): <= 1 group matched AND no institution group.
// Anything else: borderline — stays with the human (admin), never auto-set.
const CONCEPTS = [
  ['فضلاء و طلبہ', ['فضلا', 'فاضلات', 'فاضل', 'طلبا', 'علما', 'عالمات']],
  ['یونیورسٹی تحقیق', ['یونیورسٹی', 'تحقیق', 'پی ایچ ڈی', 'ایم فل', 'اعلی تعلیم']],
  ['ادارہ سازی', ['ادارہ ساز', 'ادارے', 'ادارہ', 'قائم', 'تعمیر', 'فکری']],
  ['مفت تربیت', ['مفت', 'بلا معاوضہ', 'تربیت', 'کورس', 'ورکشاپ']],
  ['تمام مکاتب فکر', ['مکاتب فکر', 'تمام مکاتب', 'ہر مکتب']],
  ['مشن و وژن', ['پانچ ہزار', '5000', 'ویژن 2035', 'دس سالہ', 'ویژن']],
  ['علمی انقلاب و خدمت', ['انقلاب', 'خدمت', 'امت', 'معاشرہ', 'قوم', 'ملک']],
  ['ادارہ حوالہ', ['مدرسہ ڈاٹ پی کے', 'مدرسہ', 'علمی مشغولیت', 'شعبہ']],
];
const CORE_GROUPS = new Set(['یونیورسٹی تحقیق', 'ادارہ سازی', 'مشن و وژن', 'ادارہ حوالہ', 'مفت تربیت']);
const JUNK_MARKERS = ['ہاہاہا', 'ھھھ', 'hahaha', 'lol'];

function scoreVision(text) {
  const norm = normalizeText(text);
  const matched = CONCEPTS.filter(([, kws]) => kws.some((k) => norm.includes(normalizeText(k)))).map(([name]) => name);
  const topical = matched.some((g) => CORE_GROUPS.has(g));
  const institution = matched.includes('ادارہ حوالہ');
  const junk = JUNK_MARKERS.some((m) => norm.includes(m));
  let decision = 'borderline';
  if (!junk && matched.length >= 3 && topical) decision = 'approve';
  else if (matched.length <= 1 && !institution) decision = 'incomplete';
  return { score: matched.length, matched, topical, institution, junk, decision };
}

// A human "incomplete" decision is NEVER overridden by a later auto-review.
// The caller must check user.visionReview.decision === 'incomplete' first
// and skip scoring when it is set by a human (source === 'admin').
function visionHash(text) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

// ---------- profile gate ----------
// Required for every student: document (docName), LinkedIn, Google Scholar,
// university, madrasa, degree, WhatsApp. Photo is mandatory for men only
// (gender === 'مرد'); women are never required to upload a photo, and
// women's photos are never shown publicly (spotlights/star lists).
//
// FIELD LOCATIONS (verified against the 2026-10-26 export): the migrated
// docs store uni/madrasa/degree/dept/mobile/country at TOP LEVEL, while
// docName/linkedin/scholar/whatsapp/photo/gender/eduStatus live under
// `profile`. This function therefore accepts the WHOLE user doc and
// checks both places (top level first, then profile) — checking only
// `profile` would falsely report every migrated student incomplete.
function profileMissing(user) {
  const u = user || {};
  const p = u.profile || {};
  const miss = [];
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const pick = (...vals) => vals.find((v) => has(v));
  if (!has(pick(p.docName))) miss.push('document');
  if (!has(pick(p.linkedin))) miss.push('linkedin');
  if (!has(pick(p.scholar))) miss.push('scholar');
  if (!has(pick(u.uni, p.uni))) miss.push('uni');
  if (!has(pick(u.madrasa, p.madrasa))) miss.push('madrasa');
  if (!has(pick(u.degree, p.degree))) miss.push('degree');
  if (!has(pick(p.whatsapp, u.mobile))) miss.push('whatsapp');
  if (pick(p.gender) === 'مرد' && !has(pick(p.photo))) miss.push('photo');
  return miss;
}

// ---------- attendance window (Asia/Karachi — the fixed rule) ----------
// The old client parsed sessionDate+startTime in device-local time, which
// closed windows ~1.5h early for SGT devices. The server always parses in
// Asia/Karachi and adds the 30-minute grace after endTime.
function karachiParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}

function karachiNowMs() {
  // Convert "now" into a wall-clock reading in Asia/Karachi, then treat
  // that reading as UTC ms so it compares directly with session wall times.
  const p = karachiParts(new Date());
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

function attendanceWindow(session) {
  const d = (session && session.sessionDate) || '';
  if (!d) return { open: true, msg: '' };
  const now = karachiNowMs();
  const start = session.startTime
    ? Date.parse(`${d}T${session.startTime}:00Z`)
    : Date.parse(`${d}T00:00:00Z`);
  let end;
  if (session.endTime) end = Date.parse(`${d}T${session.endTime}:00Z`) + 30 * 60000;
  else end = Date.parse(`${d}T23:59:59Z`);
  if (now < start) return { open: false, msg: 'حاضری کا وقت ابھی شروع نہیں ہوا' };
  if (now > end) return { open: false, msg: 'حاضری کا وقت ختم ہو چکا ہے' };
  return { open: true, msg: '' };
}

// Per-session attendance lives in `users.sessionAtts` (map, the form
// this API writes) AND in verified attendanceClaims; either one counts.
// Migrated docs carry legacy `users.sessionAtt` as a BOOLEAN (registered
// for the then-current session) — a boolean names no session, so it is
// ignored for per-session counts (never crashed on: Object.entries(true)
// would be empty anyway). A legacy MAP form, if ever present, is read too.
function courseAttendedIds(user, verifiedClaims) {
  const ids = new Set();
  const att = user.sessionAtt || {};
  if (att && typeof att === 'object') {
    for (const [sid, v] of Object.entries(att)) if (v) ids.add(sid);
  }
  const attMap = user.sessionAtts || {};
  if (attMap && typeof attMap === 'object') {
    for (const [sid, v] of Object.entries(attMap)) if (v) ids.add(sid);
  }
  for (const c of verifiedClaims || []) {
    if (c.status === 'تصدیق شدہ' && c.sessionId) ids.add(c.sessionId);
  }
  return ids;
}

// ---------- book lock ----------
// Unlocked by admin grant (user.bookAccess) OR by: course registration AND
// verified attendance in ALL registered course sessions AND the course
// period ended (last session date passed). Mirrors bookAccessState().
function bookAccessState(user, courseSessions, verifiedClaims) {
  const reg = (courseSessions || []).filter((s) => s && s.sessionId);
  const total = reg.length;
  const att = courseAttendedIds(user, verifiedClaims);
  const done = reg.filter((r) => att.has(r.sessionId)).length;
  const dates = reg.map((r) => r.sessionDate || '').filter(Boolean).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : '';
  const ended = !!(total && lastDate && karachiNowMs() > Date.parse(`${lastDate}T23:59:59Z`));
  const full = !!(total && done >= total);
  return {
    total, done, ended, full,
    unlocked: !!(user.bookAccess || (user.courseReg && full && ended)),
  };
}

// ---------- roles ----------
// Admin identity comes ONLY from the admins collection (by email).
// A users doc with role 'admin' is never trusted on its own.
async function isAdmin(db, email) {
  if (!email) return false;
  const doc = await db.collection('admins').findOne({ _id: String(email).toLowerCase() });
  return !!doc;
}

function publicStudentView(user) {
  // What any approved student may see of another student: never photos of
  // women, never mobile/WhatsApp/email internals beyond display needs.
  const p = user.profile || {};
  const out = {
    name: user.name, uni: user.uni, degree: user.degree,
    eduStatus: p.eduStatus || null, dept: user.dept || null,
  };
  if (p.gender === 'مرد' && p.photo) out.photo = p.photo;
  return out;
}

module.exports = {
  normalizeText, scoreVision, visionHash,
  profileMissing, attendanceWindow, karachiNowMs,
  courseAttendedIds, bookAccessState, isAdmin, publicStudentView,
};
