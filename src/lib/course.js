'use strict';
// Idara Sazi course (ادارہ سازی کورس — بیچ 1) classroom system: eligibility,
// batch seeding, the auto-release engine and the points ledger.
//
// Standing rules honoured here:
//  - Eligibility (Mufti 2026-10-30, re-stating 2026-10-20): registration is
//    ONLY for MPhil graduates and PhD students/graduates. The check mirrors
//    the client's alumniStage()/courseEligible() exactly (see below), so
//    client and server can never disagree.
//  - Secret attendance codes live ONLY in sessionSecrets — never in any
//    student-readable document.
//  - Exactly-once: every write below is a deterministic-id upsert; running
//    seed/release any number of times creates nothing twice.
//  - Points: verified course attendance = +10 per session; a graded in-app
//    assignment adds its obtained marks as points; a LATE submission's
//    marks still grade in full but its POINTS are halved (rounded down).
const { notifyOnce } = require('./notify');

// ---------- eligibility ----------
// Canonical eduStatus values (frontend EDU_STATUS_OPTIONS, 2026-10-23) plus
// the two legacy stored values the client still recognises.
const MPHIL_DONE = ['ایم فل مکمل', 'ایم فل مکمل ہے — فی الحال مزید تعلیم جاری نہیں'];
const PHD_DONE = 'پی ایچ ڈی مکمل ہے';

// The synchronous part of the rule (user doc only), identical to the
// client's alumniStage(u) !== 'current' minus the graduates-collection leg:
//   stage 'phd'   -> eduStatus «پی ایچ ڈی مکمل ہے»
//   stage 'mphil' -> eduStatus in MPHIL_DONE, OR degree «پی ایچ ڈی»
//                    (a PhD student is by definition an MPhil graduate)
// Anything else is stage 'current' -> NOT eligible.
function courseEligibleQuick(user) {
  if (!user) return false;
  const st = (user.profile && user.profile.eduStatus) || '';
  if (st === PHD_DONE) return true;
  if (MPHIL_DONE.includes(st)) return true;
  if (user.degree === 'پی ایچ ڈی') return true;
  return false;
}

// Full rule: the graduates collection can also prove graduation (the client
// checks it first in alumniStage). gradLevelOf() on the client: an explicit
// level of «پی ایچ ڈی»/«ایم فل» wins; a non-auto record without a level is a
// self-registered PhD graduate record. Mirrored here.
async function courseEligible(db, user) {
  if (!user) return false;
  if (courseEligibleQuick(user)) return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  const grads = await db.collection('graduates').find({ email }).toArray();
  for (const g of grads) {
    const lv = g.level || '';
    if (lv === 'پی ایچ ڈی' || lv === 'ایم فل') return true;
    if (!g.auto && !lv) return true; // self-registered graduate record (PhD ثبت فارم)
  }
  return false;
}

// ---------- batch 1 plan (all values from real sources) ----------
// Sessions: Mondays 2026-11-02 .. 2027-01-04, 20:00-21:30 Asia/Karachi —
// the published IDARA_BATCH1 schedule. Titles/folders/points come from the
// courseContent collection (book «ادارہ سازی کا فن», categories 1-10).
// Google Form links: inventoried 2026-10-30 from the actual Drive material
// folders (form file ids; students get the /viewform URL). GAPS ARE REAL:
// session 1 has only ONE form, session 7 has NO forms and NO slide
// activity in its courseContent points — the release engine logs these
// and releases what exists; nothing is invented to fill them.
const FORM = (id) => `https://docs.google.com/forms/d/${id}/viewform`;
const BATCH1_SESSIONS = [
  { n: 1, date: '2026-11-02', cat: 1, title: 'شخصیت سے نظام تک کا سفر',
    folderUrl: 'https://drive.google.com/drive/folders/1oQq5UT5WVTfQDVivgn5Pd1dz28Q7Tdz9',
    form1: FORM('1HqpHMVfdVSZewwpGYnWhRdSJTziXsrt3iWqXIRCioNo'), form1Name: 'زمرہ اول سے متعلق سوالات',
    form2: null, form2Name: '',
    activity: 'سرگرمی 1: انفرادی سوچ - آئس برگ آڈٹ' },
  { n: 2, date: '2026-11-09', cat: 2, title: 'سماجی تبدیلی، متعلقہ فریقین اور کمیونٹی کی شمولیت',
    folderUrl: 'https://drive.google.com/drive/folders/1PtcG1B0VwaUZXRgRoKc2kv5uxvX_GBlF',
    form1: FORM('1gixBWbjnXpjYSIoQx9m17vB-i0J1v9aD1KCvMeqxl_M'), form1Name: 'سرگرمی برائے زمرہ 2',
    form2: FORM('1ZzS5QghkoDg5zewQKU4-LBkJIaiwMphee9B8ExVwPhA'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ نمبر 2',
    activity: 'سرگرمی 1: انفرادی مشق - متعلقہ فریقوں کی درجہ بندی' },
  { n: 3, date: '2026-11-16', cat: 3, title: 'قانونی ڈھانچہ، نظامِ کار، اخلاقیات',
    folderUrl: 'https://drive.google.com/drive/folders/1YTUA6WcVNnsE39KCvGg1JW_8hAtHWWWc',
    form1: FORM('1Fnzdvw3M9JgE7Xp1YuuJWDGiVfRAyStCx0pKxOb2Jus'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ نمبر 3',
    form2: FORM('1NChLJkZvfLE0_wRa3w4_9Qz2S3tXnIPRk6OYBFCHHHE'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ نمبر 3',
    activity: 'سرگرمی 1: انفرادی مشق - "کیا آپ میں بانی کی بالادستی والی صفت ہے؟"' },
  { n: 4, date: '2026-11-23', cat: 4, title: 'حکمتِ عملی سے منصوبہ بندی، منصوبے اور تبدیلی کا انتظام',
    folderUrl: 'https://drive.google.com/drive/folders/1iMUVs5GtP5Lpn9DZn4q1U0HVUi_sabcf',
    form1: FORM('1zEt8eW9IBs3YvYTnxxkRZYP0uq8qkkou4PyVdtXZNYg'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 4',
    form2: FORM('1WyoO58oYP6SM2q_sijAfrUyBM4VEEEv5eK6YVI4YLpc'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 4',
    activity: 'سرگرمی 1: انفرادی مشق - SWOT تجزیہ' },
  { n: 5, date: '2026-11-30', cat: 5, title: 'اعلیٰ معیار کے تعلیمی اداروں کی تشکیل',
    folderUrl: 'https://drive.google.com/drive/folders/1taXPV8el1Ke0-lfdwReuyKY727YCykgg',
    form1: FORM('1djAYgeDdaQ5sykHM7ia-L3lu82yZfGRnu54k6yvZQqg'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 5',
    form2: FORM('105r8wyxqhmEuY9xmlltIRBB70QvG51FoVjziNwfQmXU'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 5',
    activity: 'سرگرمی 1: انفرادی مشق - درجہ بندی تعلَم کا استعمال' },
  { n: 6, date: '2026-12-07', cat: 6, title: 'تحقیقی اداروں (تھنک ٹینکس) کا قیام اور علم کا انتظام',
    folderUrl: 'https://drive.google.com/drive/folders/1h5o5qkoecdcP6xqKi_xdRwwQVKFkpg9Z',
    form1: FORM('11OgpJiF4CKvjwGWYaIbKqYlSxrBPD5gUZBobOUgMLME'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 6',
    form2: FORM('1VxdJJ1VRoo7zzSiRq0_IecNnVXfkQ46cy_e6hGeSI2Q'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 6',
    activity: "سرگرمی 1: انفرادی مشق - 'ایگزیکٹو سمری' یا 'پالیسی بریف' لکھنا" },
  { n: 7, date: '2026-12-14', cat: 7, title: 'انسانی سرمایہ، ٹیم سازی، رضاکار اور ادارتی ثقافت',
    folderUrl: 'https://drive.google.com/drive/folders/1_-5ZZDRY79BkJY6GDVWddzRUX65qDTgy',
    form1: null, form1Name: '', form2: null, form2Name: '',
    activity: null }, // GAP: no forms in the folder, no سرگرمی in courseContent points
  { n: 8, date: '2026-12-21', cat: 8, title: 'مالیاتی پائیداری، بجٹ اور جدید اوقاف',
    folderUrl: 'https://drive.google.com/drive/folders/1PjEfU00zLSAdyUq7rkV0Cxod05n8T6Qp',
    form1: FORM('1UsrkZhsDPDKcs5ZDvzcckRqPP0Ts7TP-9n7O6ONm_MA'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 8',
    form2: FORM('1qN3mou23qCkgRIzSudI07EyfyniqTO1MMWA9kAu68nE'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 8',
    activity: 'سرگرمی 1: انفرادی مشق - "ذاتی بمقابلہ ادارہ جاتی آڈٹ"' },
  { n: 9, date: '2026-12-28', cat: 9, title: 'رابطہ عامہ، عوامی اعتماد اور ابلاغی اثر',
    folderUrl: 'https://drive.google.com/drive/folders/1F0Lf-uSbc17PMyRrdn_UtFJgUFFwmkB8',
    form1: FORM('1z4dM6k0ANpFDR1_qi4CzUzTW9NmvT60DmR6SiIhhe-A'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 9',
    form2: FORM('1lGGCedOjcWIxbdkLhImRpjS3kmLIGNjSZzJhL7YdstI'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 9',
    activity: 'سرگرمی 1: انفرادی مشق' }, // source points title is truncated; slides carry the detail
  { n: 10, date: '2027-01-04', cat: 10, title: 'نگرانی و جانچ، محتاط توسیع اور جانشینی',
    folderUrl: 'https://drive.google.com/drive/folders/1eAws0S8-B3ahVFwSg66RXP5r5LDRy4dF',
    form1: FORM('1mR8CbYTnTmnT34_dVhZ3iy5KsIde5RNzDmUiTAxyTWM'), form1Name: 'سرگرمی فارم نمبر 1 — زمرہ 10',
    form2: FORM('1bAWoq0zlbfB8ZOyRAx7KK_VfSmg2-RU6Ion8rIIxXwI'), form2Name: 'سرگرمی فارم نمبر 2 — زمرہ 10',
    activity: 'سرگرمی 1: انفرادی مشق - "امپیکٹ چین بنانا"' },
];

const sessionIdFor = (n) => `idara-b1-s${n}`;
const COURSE_ANNOUNCEMENT_ID = 'idara-batch1-launch';
const ELIGIBILITY_MSG = 'یہ کورس صرف ایم فل فارغ التحصیل اور پی ایچ ڈی طلبہ کے لیے ہے';

// Karachi wall-clock instant for a plan date + day offset at a given hour,
// returned as real epoch ms (Karachi = UTC+5, no DST).
function planInstantMs(dateStr, plusDays, hour) {
  const base = Date.parse(`${dateStr}T00:00:00+05:00`);
  return base + plusDays * 86400000 + hour * 3600000;
}

// The release plan derived from the sessions: form 1 the day AFTER the
// session (Tue 09:00 Karachi), form 2 + the slide activity two days after
// (Wed 09:00 Karachi). Deadlines: the next session's start (Mon 20:00
// Karachi); the last session's items close 2027-01-11 20:00 Karachi.
// Google-Form assignments carry no marks (responses land in the form's own
// sheet, outside the app — the app cannot see who filled them); in-app
// activity assignments carry 20 marks by default (admin-editable).
function releasePlan() {
  const items = [];
  for (const s of BATCH1_SESSIONS) {
    const next = BATCH1_SESSIONS[s.n] || null; // n is 1-based; index n = next
    const deadline = next ? planInstantMs(next.date, 0, 20) : planInstantMs('2027-01-11', 0, 20);
    if (s.form1) items.push({
      id: `asg-b1-f1-s${s.n}`, kind: 'form1', session: s.n, type: 'google-form',
      title: `مشق فارم 1 — کلاس ${s.n}: ${s.form1Name || s.title}`,
      instructions: `کلاس ${s.n} (${s.title}) کی پہلی سرگرمی کا گوگل فارم ہے۔ فارم کھول کر تمام سوالات کے جوابات غور سے دیں — آپ کے جوابات براہِ راست انتظامیہ کے ریکارڈ میں جائیں گے۔`,
      formUrl: s.form1, releaseAtMs: planInstantMs(s.date, 1, 9), deadlineMs: deadline, maxMarks: 0,
    });
    if (s.form2) items.push({
      id: `asg-b1-f2-s${s.n}`, kind: 'form2', session: s.n, type: 'google-form',
      title: `مشق فارم 2 — کلاس ${s.n}: ${s.form2Name || s.title}`,
      instructions: `کلاس ${s.n} (${s.title}) کی دوسری سرگرمی کا گوگل فارم ہے۔ فارم کھول کر تمام سوالات کے جوابات غور سے دیں — آپ کے جوابات براہِ راست انتظامیہ کے ریکارڈ میں جائیں گے۔`,
      formUrl: s.form2, releaseAtMs: planInstantMs(s.date, 2, 9), deadlineMs: deadline, maxMarks: 0,
    });
    if (s.activity) items.push({
      id: `asg-b1-act-s${s.n}`, kind: 'activity', session: s.n, type: 'in-app',
      title: `سلائیڈ سرگرمی — کلاس ${s.n}: ${s.activity}`,
      instructions: `یہ مشق کلاس ${s.n} «${s.title}» کی سلائیڈز میں دی گئی سرگرمی ہے: «${s.activity}»۔\nطریقہ: (۱) پہلے اس کلاس کے مواد کے فولڈر سے سلائیڈز کھول کر یہ سرگرمی والا حصہ غور سے پڑھیں۔ (۲) پھر اپنا کام تحریری صورت میں نیچے والے خانے میں مکمل لکھیں — جتنی تفصیل سلائیڈز میں مانگی گئی ہے، اتنی ہی یہاں دیں۔ (۳) کوئی معاون لنک (دستاویز/فائل کا ربط) ہو تو وہ بھی شامل کر سکتے ہیں۔ جمع کرانے کے بعد انتظامیہ نمبر دے گی اور وہ آپ کو یہیں نظر آئے گا۔`,
      formUrl: '', releaseAtMs: planInstantMs(s.date, 2, 9), deadlineMs: deadline, maxMarks: 20,
    });
  }
  return items;
}

function planGaps() {
  const gaps = [];
  for (const s of BATCH1_SESSIONS) {
    if (!s.form1 && !s.form2) gaps.push(`session ${s.n} (${s.date}): no Google Forms in the material folder — nothing released`);
    else if (!s.form2) gaps.push(`session ${s.n} (${s.date}): only 1 Google Form found — form 2 missing, skipped`);
    if (!s.activity) gaps.push(`session ${s.n} (${s.date}): no slide activity in courseContent points — no in-app activity released`);
  }
  return gaps;
}

// ---------- seeding ----------
// Idempotent: sessions upserted by deterministic id; secret codes are
// $setOnInsert (generated once, then stable — re-running never rotates a
// code a teacher may already plan to announce); the launch announcement's
// audience is narrowed to 'alumni' (the client's audience key whose member
// set is EXACTLY the eligible set: alumniStage !== 'current'); targeted
// notifications go only to eligible APPROVED users, deterministic ids.
async function seedCourseBatch(db) {
  const now = new Date().toISOString();
  let sessions = 0, codes = 0;
  for (const s of BATCH1_SESSIONS) {
    const sid = sessionIdFor(s.n);
    const cc = await db.collection('courseContent').findOne({ _id: `cat-${s.cat}` });
    const doc = {
      _id: sid, id: sid, sessionId: sid,
      title: `ادارہ سازی کورس — کلاس ${s.n}: ${s.title}`,
      sessionDate: s.date, startTime: '20:00', endTime: '21:30',
      when: `${s.date} — رات 8:00 تا 9:30 (پاکستانی وقت)`,
      isCourseSession: true, courseBatch: 'b1', week: s.n, cat: s.cat,
      materialUrl: s.folderUrl,
      points: (cc && cc.points) || [],
      seededAt: now,
    };
    await db.collection('courseSessions').updateOne({ _id: sid }, { $set: doc }, { upsert: true });
    sessions += 1;
    const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
    const r = await db.collection('sessionSecrets').updateOne(
      { sessionId: sid },
      { $setOnInsert: { _id: sid, id: sid, sessionId: sid, code, sessionTitle: doc.title, sample: false, updatedAt: now } },
      { upsert: true }
    );
    if (r.upsertedCount) codes += 1;
  }
  // Target the launch announcement to eligible students only.
  let announcement = 'absent';
  const ann = await db.collection('announcements').findOne({ _id: COURSE_ANNOUNCEMENT_ID });
  if (ann) {
    if (ann.audience !== 'alumni') {
      await db.collection('announcements').updateOne({ _id: ann._id }, { $set: { audience: 'alumni' } });
      announcement = 'retargeted-to-alumni';
    } else announcement = 'already-alumni';
  }
  // Targeted launch notifications — eligible + approved only, exactly once.
  let notified = 0;
  const users = await db.collection('users').find({ status: 'approved' }).toArray();
  for (const u of users) {
    if (!(await courseEligible(db, u))) continue;
    const nid = `course-b1-launch-${u._id}`;
    const sent = await notifyOnce(db, {
      id: nid, email: u.email, kind: 'course', read: false,
      date: now,
      title: '🏛️ ادارہ سازی کورس — بیچ 1: رجسٹریشن کھل گئی ہے',
      body: 'آپ کی اہلیت کے مطابق یہ خصوصی کورس آپ کے لیے کھلا ہے: ہر پیر رات 8:00 تا 9:30 (پاکستانی وقت)، آغاز پیر 2 نومبر 2026 — ٹرینرز: ڈاکٹر مفتی محمد حسن و محترمہ انعم زیدی صاحبہ۔ رجسٹریشن «ادارہ سازی کورس» والے حصے سے کریں۔',
    });
    if (sent) notified += 1;
  }
  const gaps = planGaps();
  for (const g of gaps) console.log('course seed gap:', g);
  return { sessions, codesCreated: codes, announcement, notified, gaps };
}

// ---------- auto-release engine ----------
// Creates every due plan assignment (deterministic id, upsert — catch-up
// safe after Render sleep) and notifies course-REGISTERED students once
// per assignment. Admin-created assignments carry their own releaseAtMs
// and are simply filtered by it on read; this engine only materialises
// the built-in batch plan.
async function runCourseReleases(db, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const created = [];
  const registered = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1 }).toArray();
  for (const item of releasePlan()) {
    if (item.releaseAtMs > now) continue;
    const existing = await db.collection('assignments').findOne({ _id: item.id });
    if (existing) continue;
    const doc = {
      _id: item.id, id: item.id, course: 'idara-b1', auto: true, kind: item.kind,
      title: item.title, instructions: item.instructions, session: item.session,
      type: item.type, formUrl: item.formUrl || '',
      releaseAtMs: item.releaseAtMs, deadlineMs: item.deadlineMs,
      releaseAt: new Date(item.releaseAtMs).toISOString(),
      deadline: new Date(item.deadlineMs).toISOString(),
      maxMarks: item.maxMarks, createdAt: new Date().toISOString(),
    };
    await db.collection('assignments').updateOne({ _id: item.id }, { $setOnInsert: doc }, { upsert: true });
    created.push(item.id);
    for (const u of registered) {
      const nid = `asg-new-${item.id}-${u.email}`;
      await notifyOnce(db, {
        id: nid, email: u.email, kind: 'assignment', read: false,
        date: new Date().toISOString(),
        title: '✍️ نئی مشق — ادارہ سازی کورس',
        body: `${item.title} — «اسائنمنٹس» والے حصے میں کھول کر مکمل کریں۔`,
      });
    }
  }
  if (created.length) console.log('course releases created:', created.join(', '));
  return { created };
}

// ---------- points ledger ----------
// Recomputed from source records every time (verified claims + graded
// submissions), so it can never double-count and any correction upstream
// flows through on the next recompute.
async function recomputeCoursePoints(db, email) {
  const em = String(email || '').trim().toLowerCase();
  const user = await db.collection('users').findOne({ email: em });
  if (!user) return null;
  const courseIds = new Set(
    (await db.collection('courseSessions').find({}).project({ sessionId: 1 }).toArray())
      .map((s) => s.sessionId).filter(Boolean)
  );
  const claims = await db.collection('attendanceClaims')
    .find({ email: em, status: 'تصدیق شدہ' }).toArray();
  const attended = new Set(claims.filter((c) => courseIds.has(c.sessionId)).map((c) => c.sessionId));
  // Admin-entered attendance (user.courseAtt) counts for the record too —
  // the same source the book lock and the attendance sheet use.
  for (const sid of (user.courseAtt || [])) if (courseIds.has(sid)) attended.add(sid);
  const attendanceCount = attended.size;
  const attendancePoints = attendanceCount * 10;
  const subs = await db.collection('assignmentSubmissions').find({ email: em }).toArray();
  let assignmentPoints = 0, gradedCount = 0;
  for (const s of subs) {
    if (typeof s.marks === 'number') {
      gradedCount += 1;
      assignmentPoints += s.late ? Math.floor(s.marks / 2) : s.marks;
    }
  }
  const doc = {
    _id: em, id: em, email: em, name: user.name || '',
    attendanceCount, attendancePoints,
    submittedCount: subs.length, gradedCount, assignmentPoints,
    totalPoints: attendancePoints + assignmentPoints,
    updatedAt: new Date().toISOString(),
  };
  await db.collection('coursePoints').updateOne({ _id: em }, { $set: doc }, { upsert: true });
  return doc;
}

function badgesFor(points, rank) {
  const p = points || {};
  const out = [];
  if ((p.attendanceCount || 0) >= 1) out.push('پہلی حاضری');
  if ((p.attendanceCount || 0) >= 5) out.push('باقاعدہ حاضر');
  if ((p.submittedCount || 0) >= 5) out.push('مشقوں کا ماہر');
  if (rank && rank <= 3 && (p.totalPoints || 0) > 0) out.push('ستارہ طالب علم');
  return out;
}

async function courseLeaderboard(db, limit) {
  const docs = await db.collection('coursePoints').find({}).sort({ totalPoints: -1 }).limit(limit || 10).toArray();
  // Only course-registered students belong on the board.
  const regs = new Set((await db.collection('users').find({ courseReg: true }).project({ email: 1 }).toArray()).map((u) => u.email));
  return docs.filter((d) => regs.has(d.email))
    .map((d, i) => ({ rank: i + 1, name: d.name, totalPoints: d.totalPoints, attendanceCount: d.attendanceCount, submittedCount: d.submittedCount }));
}

module.exports = {
  MPHIL_DONE, PHD_DONE, ELIGIBILITY_MSG,
  courseEligibleQuick, courseEligible,
  BATCH1_SESSIONS, sessionIdFor, releasePlan, planGaps,
  seedCourseBatch, runCourseReleases,
  recomputeCoursePoints, badgesFor, courseLeaderboard,
};
