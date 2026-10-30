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
// Incomplete: junk (markers / repetition), or <= 1 group matched AND no
// institution group. Anything else: borderline — stays with the human.
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

// Faithful port of the Python scorer's normalize_ur: NFKD, strip
// tanwin/diacritics, collapse ي/ك/ة variants, drop ZWNJ/ZWJ, fold Urdu
// and Arabic-Indic digits to Latin, punctuation -> space.
function normalizeVision(s) {
  let t = String(s || '').normalize('NFKD');
  t = t.replace(/[\u064B-\u0652\u0670]/g, '');
  t = t.replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9').replace(/\u0629/g, '\u06C1');
  t = t.replace(/[\u200C\u200D]/g, '');
  t = t.replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
  t = t.replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
  t = t.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function scoreVision(text) {
  const norm = normalizeVision(text);
  const padded = ' ' + norm + ' ';
  const words = norm ? norm.split(' ') : [];
  const matched = [];
  for (const [name, kws] of CONCEPTS) {
    for (const kw of kws) {
      const nkw = normalizeVision(kw);
      if (nkw && (padded.includes(' ' + nkw + ' ') || norm.startsWith(nkw + ' ')
        || norm.endsWith(' ' + nkw) || words.includes(nkw))) {
        matched.push(name);
        break;
      }
    }
  }
  const topical = matched.some((g) => CORE_GROUPS.has(g));
  const institution = matched.includes('ادارہ حوالہ');
  // Junk detection — identical to the Python + in-app scorers: a single
  // word dominating (>35%), a near-duplicate text (unique ratio <25%),
  // or an explicit junk marker.
  let junk = false;
  let junkReason = '';
  if (words.length) {
    const freq = {};
    let most = 0;
    for (const w of words) { freq[w] = (freq[w] || 0) + 1; if (freq[w] > most) most = freq[w]; }
    if (most / words.length > 0.35) { junk = true; junkReason = 'ایک ہی لفظ کی تکرار'; }
    else if (Object.keys(freq).length / words.length < 0.25) { junk = true; junkReason = 'نقلی/دہرائی ہوئی عبارت'; }
  }
  if (!junk) {
    for (const m of JUNK_MARKERS) {
      if (norm.includes(normalizeVision(m))) { junk = true; junkReason = 'مذاق/فضول الفاظ'; break; }
    }
  }
  // Decision order mirrors Python decide(): junk first, then approve,
  // then the thin-text incomplete, else borderline for the human.
  let decision = 'borderline';
  if (junk) decision = 'incomplete';
  else if (matched.length >= 3 && topical) decision = 'approve';
  else if (matched.length <= 1 && !institution) decision = 'incomplete';
  return { score: matched.length, matched, topical, institution, junk, junkReason, words: words.length, decision };
}

// Same hash the Python automation used (sha1 of the trimmed raw text,
// first 10 hex chars) — one decision per text, and the deterministic
// incomplete-notification id (incomplete-auto-<uid>-<hash>) matches the
// old flow's documented format exactly.
function visionHash(text) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 10);
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
  normalizeText, normalizeVision, scoreVision, visionHash,
  profileMissing, attendanceWindow, karachiNowMs,
  courseAttendedIds, bookAccessState, isAdmin, publicStudentView,
};
