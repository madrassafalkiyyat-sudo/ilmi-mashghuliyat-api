'use strict';
// Expiry guard for conference + scholarship news (Mufti, 2026-10-31:
// expired کانفرنسز/سکالرشپس were still visible in the app).
//
// The content route already filters on the stored `expiresAt` field, but
// that field is unreliable as the ONLY signal: some docs carry no
// expiresAt, others carry the event date rather than the application
// deadline. This module reads the item's own DEADLINE (the text students
// see, plus deadlineText/expiresAt) and decides conservatively:
//
//   expired  <=>  at least one definite date can be parsed
//                 AND the LATEST parsed date is before today
//                 (Asia/Karachi, the app's canonical timezone).
//
// Consequences, all deliberate:
//   - multi-round items (e.g. HEC Knowledge Corridor: a passed Oct 2026
//     round + a live Mar 2027 round) stay visible — the latest date
//     governs;
//   - items with no parseable date stay visible (never hide on a guess);
//   - only the two named categories are judged — jobs/courses/other
//     news are out of scope for this guard.

const GUARD_CATS = ['کانفرنسز', 'سکالرشپس'];

const URDU_MONTHS = {
  'جنوری': 1, 'فروری': 2, 'مارچ': 3, 'اپریل': 4, 'مئی': 5, 'جون': 6,
  'جولائی': 7, 'اگست': 8, 'ستمبر': 9, 'اکتوبر': 10, 'نومبر': 11, 'دسمبر': 12,
};
const EN_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeDigits(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

function ymd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// All definite dates mentioned in a text, as 'YYYY-MM-DD' strings.
function extractDates(text) {
  const t = normalizeDigits(text);
  const out = [];
  let m;
  const iso = /(\d{4})-(\d{2})-(\d{2})/g;
  while ((m = iso.exec(t))) { const v = ymd(m[1], m[2], m[3]); if (v) out.push(v); }
  const ur = /(\d{1,2})\s*(جنوری|فروری|مارچ|اپریل|مئی|جون|جولائی|اگست|ستمبر|اکتوبر|نومبر|دسمبر)\s*(\d{4})/g;
  while ((m = ur.exec(t))) { const v = ymd(m[3], URDU_MONTHS[m[2]], m[1]); if (v) out.push(v); }
  const enDmy = /(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*(\d{4})/gi;
  while ((m = enDmy.exec(t))) { const v = ymd(m[3], EN_MONTHS[m[2].toLowerCase()], m[1]); if (v) out.push(v); }
  const enMdy = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/gi;
  while ((m = enMdy.exec(t))) { const v = ymd(m[3], EN_MONTHS[m[1].toLowerCase()], m[2]); if (v) out.push(v); }
  return out;
}

function karachiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

// True only when the doc is in a guarded category AND every date that
// can be read from its deadline fields lies before Karachi today.
function isExpiredGuardedDoc(doc, today) {
  if (!doc || !GUARD_CATS.includes(doc.cat)) return false;
  const t = today || karachiToday();
  const dates = [];
  for (const f of ['deadline', 'deadlineText', 'expiresAt']) {
    if (typeof doc[f] === 'string') dates.push(...extractDates(doc[f]));
  }
  if (!dates.length) return false;
  const latest = dates.sort()[dates.length - 1];
  return latest < t;
}

module.exports = { GUARD_CATS, extractDates, karachiToday, isExpiredGuardedDoc };
