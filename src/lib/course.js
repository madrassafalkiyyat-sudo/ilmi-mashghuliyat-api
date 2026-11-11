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

// ---------- registration gate ----------
// Mufti (2026-11-03, after Session 1): Batch 1 has STARTED, so NEW course
// registrations are CLOSED. The register route checks this BEFORE
// eligibility and refuses newcomers with 'registration_closed'; the
// existing registrants are never disturbed by it. Reopen ONLY on
// Mufti's word for a new batch (flip to true and redeploy).
const COURSE_REG_OPEN = false;

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
    activity: 'سرگرمی 1: انفرادی مشق' }, // points title truncated in source; bab-9 material fixes the topic: the 30-second elevator-pitch intro of one's institution (see ACTIVITY_INSTRUCTIONS[9])
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

// ---------- slide-activity instructions (Mufti 2026-11-05) ----------
// Each activity is explained FULLY in-app — background of the model as
// taught in the session, the concrete task, numbered steps and the exact
// submission shape — grounded in the session material (course book
// chapters / slide decks). The generic "go read the slides in the
// folder" text is gone; releasePlan() falls back to it ONLY for a
// session missing from this map.
const ACTIVITY_INSTRUCTIONS = {
  1: "🧭 پس منظر\nکلاس میں ہم نے «آئس برگ ماڈل» پڑھا: سمندر میں تیرتے برفانی تودے کا صرف دس فیصد حصہ پانی سے باہر نظر آتا ہے، باقی نوے فیصد اندر چھپا ہوتا ہے۔ ادارے کے مسائل بھی ایسے ہی ہوتے ہیں، اور اس ماڈل کے چار درجے ہیں۔ پہلا درجہ «واقعات»: جو نظر آتا ہے، مثلاً مدرسے کا ایک بہترین محقق ناراض ہو کر چلا گیا۔ دوسرا درجہ «رجحانات»: جو بار بار ہوتا ہے، مثلاً پچھلے تین سال میں پانچ اساتذہ چھوڑ چکے ہیں۔ تیسرا درجہ «ساختیاتی نظام»: وہ ڈھانچہ جو یہ رجحان پیدا کرتا ہے، مثلاً ترقی کا کوئی واضح نظام نہیں، تنخواہیں کم ہیں اور فیصلہ سازی میں شوریٰ شامل نہیں۔ چوتھا اور گہرا درجہ «ذہنی سانچے»: وہ سوچ جو اس ڈھانچے کو قائم رکھتی ہے، مثلاً قیادت کی یہ سوچ کہ «دین کا کام پیسوں کے لیے نہیں ہوتا، جانے والے جائیں»۔ اس ماڈل کا سب سے بڑا سبق یہ ہے کہ مسئلہ باہر نہیں، نظام کے اندر ہوتا ہے؛ واقعے کا وقتی علاج جڑ نہیں کاٹتا۔\n🎯 آپ کو کیا کرنا ہے\nاپنے موجودہ مدرسے، دفتر یا ادارے کا سب سے بڑا مسئلہ منتخب کریں اور اسے آئس برگ کے چاروں درجوں سے کھودتے ہوئے ذہنی سانچے تک پہنچیں — یہ آپ کا «آئس برگ آڈٹ» ہے۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ واقعہ: مسئلہ ایک واضح جملے میں لکھیں، جیسا وہ ظاہراً نظر آتا ہے۔\n۲۔ رجحان: لکھیں کہ یہ مسئلہ کب سے اور کتنی بار ہو چکا ہے؛ ممکن ہو تو تعداد یا مثالیں دیں۔\n۳۔ ساختیاتی نظام: وہ قواعد، پالیسیاں اور انتظام لکھیں جو اس رجحان کو پیدا کرتے ہیں — تنخواہ و ترقی کا نظام، ذمہ داریوں کی تقسیم، فیصلہ کون اور کیسے کرتا ہے۔\n۴۔ ذہنی سانچہ: وہ سوچ یا جملہ لکھیں جو عام طور پر کہا جاتا ہے اور جس کی وجہ سے یہ نظام بدلتا نہیں۔\n۵۔ نتیجہ: دو تین سطروں میں لکھیں کہ اصل جڑ کس درجے پر ہے اور اسے بدلنے کا پہلا عملی قدم کیا ہو سکتا ہے۔\n📤 جمع کرانے کی صورت\nاپنا مکمل کام نیچے والے خانے میں انہی پانچ ذیلی عنوانات کے ساتھ لکھیں: واقعہ، رجحان، ساختیاتی نظام، ذہنی سانچہ، نتیجہ۔ ادارے کا اصل نام لکھنا ضروری نہیں، «میرا مدرسہ» یا «میرا دفتر» لکھنا کافی ہے۔ کوئی معاون لنک ہو تو ساتھ دے سکتے ہیں، ورنہ صرف تحریر ہی جمع کرائیں۔",
  2: "🧭 پس منظر\nیہ مشق کلاس 2 کی اسی سلائیڈ کا نچوڑ ہے جس پر یہ سرگرمی آویزاں ہے: «سرگرمی 1: انفرادی مشق - متعلقہ فریقوں کی درجہ بندی»۔ سلائیڈ پر اس کا مقصد یوں لکھا ہے: «عملی طور پر خاکے کا استعمال» — یعنی جو خاکہ کلاس میں پڑھا، اسے اب اپنے ادارے پر لاگو کرنا ہے۔ اسی موضوع («متعلقہ افراد اور اداروں کا باہمی نظام کار») کی سلائیڈ میں شراکت دار (متعلقہ فریق) کی تعریف یہ آئی تھی: ہر وہ شخص، گروہ یا ادارہ جو آپ کے ادارے کی کامیابی سے متاثر ہوتا ہے، یا جس کی وجہ سے آپ کا ادارہ متاثر ہو سکتا ہے۔ اور اسی موضوع کا بنیادی اصول یہ تھا کہ جہاں ادارے کے لیے بیرونی شراکت داروں سے تعلقات ضروری ہیں، وہیں ان تعلقات کا معیاری استعمال اور تنظیم بھی نہایت ضروری ہے — یہ درجہ بندی اسی تنظیم کی پہلی سیڑھی ہے۔ کلاس میں اس سرگرمی کے لیے 10 منٹ مقرر تھے؛ ایپ میں آپ اسے اطمینان سے مکمل کریں۔\n🎯 آپ کو کیا کرنا ہے\nسلائیڈ کے تین مراحل عین اسی ترتیب سے کرنے ہیں: پہلے اپنے ادارے کا انتخاب، پھر اس کے دس متعلقہ فریقوں کی فہرست، اور پھر ان سب کو چار ڈبوں کے خاکے میں ان کے مناسب خانوں میں تقسیم۔ یہ ایک انفرادی مشق ہے۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ ادارے کا انتخاب: اپنے ذہن میں موجود (یا زیرِ تعمیر) ادارے کا نام سب سے اوپر لکھیں۔\n۲۔ متعلقہ فریقوں کی فہرست: ایسے 10 افراد یا اداروں کی فہرست بنائیں جو اس ادارے پر اثر انداز ہو سکتے ہیں۔\n۳۔ درجہ بندی اور تقسیم: 4 ڈبے بنائیں — وہی خاکہ جو کلاس میں پڑھایا گیا (طاقت اور دلچسپی کی بنیاد پر) — اور ہر فریق کو اس کے مناسب خانے میں رکھیں۔\nنوٹ (سلائیڈ کا اپنا نوٹ): یہ ایک انفرادی مشق ہے — اپنے خیالات کو واضح اور منظم انداز میں خاکہ پیش کریں۔\n📤 جمع کرانے کی صورت\nمکمل کام نیچے والے خانے میں پیش کریں: سب سے اوپر اپنے ادارے کا نام، پھر دس فریقوں کی فہرست، اور پھر چار ڈبوں کی تقسیم — کون سا فریق کس خانے میں رکھا۔ چارٹ کی تصویر بنائی ہو تو اس کا لنک بھی ساتھ لگا سکتے ہیں؛ معاون لنک اختیاری ہے۔",
  3: "🧭 پس منظر\nکلاس میں ہم نے «بانی کی بالادستی» کا مسئلہ پڑھا: جب ادارہ ایک ہی شخص کے گرد گھومنے لگے — کلیدی معلومات اور فیصلے صرف اس کے پاس ہوں، شوریٰ محض ربڑ کی مہر بن جائے اور جانشین کی کوئی تیاری نہ ہو — تو ادارہ بانی کی زندگی تک تو چلتا ہے، اس کے بعد بکھر جاتا ہے۔ کلاس میں بتایا گیا کہ بانی کی بالادستی کی سب سے بڑی علامت یہی ہے کہ جانشین تیار نہ کیا جائے۔ یہ صفت اکثر انجانے میں پیدا ہوتی ہے: بانی سمجھتا ہے کہ وہ ادارے کی خدمت کر رہا ہے، حالانکہ اس کا ہر کام خود کرنا ادارے کو اسی پر منحصر کر دیتا ہے۔ اس سرگرمی کا مقصد دوسروں پر تنقید نہیں، ایماندارانہ خود احتسابی ہے — کیونکہ جو رکاوٹ اپنے اندر ہو، اسے پہچاننا ہی اصلاح کی پہلی سیڑھی ہے۔\n🎯 آپ کو کیا کرنا ہے\nنیچے دی گئی پانچ سوالات کی جانچ فہرست پر ایمانداری سے «ہاں» یا «نہیں» میں جواب دیں، ہر جواب کے ساتھ مختصر وضاحت لکھیں، پھر اپنا نتیجہ اور ایک عملی اصلاحی قدم لکھیں۔ اگر آپ خود ادارے کے سربراہ نہیں ہیں تو اپنے ادارے کے بانی یا سربراہ کے طرزِ عمل کو سامنے رکھ کر جواب دیں۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ سوال ۱: کیا ادارے کے کلیدی خفیہ الفاظ اور اہم معلومات صرف سربراہ کے پاس ہیں اور کسی اور سے نہیں بانٹی جاتیں؟\n۲۔ سوال ۲: کیا اہم فیصلے شوریٰ کے اجلاس سے پہلے ہی الگ بیٹھک میں طے ہو جاتے ہیں؟\n۳۔ سوال ۳: کیا کوئی جانشین تیار ہو رہا ہے جسے معلوم ہو کہ سربراہ کے بعد ذمہ داری کس کی ہوگی؟\n۴۔ سوال ۴: کیا شوریٰ کے ارکان سربراہ سے اختلاف کرنے کی ہمت رکھتے ہیں؟\n۵۔ سوال ۵: کیا ادارے کا بینک اکاؤنٹ اور وسائل ذاتی معاملات سے مکمل الگ ہیں؟\n۔ ہر جواب کے ساتھ ایک سطر میں اصل صورتِ حال یا مثال لکھیں — خالی ہاں یا نہیں کافی نہیں۔\n۷۔ نتیجہ: شمار کریں کہ کتنے جوابات خطرے کی نشاندہی کرتے ہیں اور ایک پیراگراف میں اپنا خود احتسابی نتیجہ لکھیں۔\n۸۔ اصلاحی قدم: ایک ایسا عملی قدم لکھیں جو آئندہ ایک ماہ میں اس کمزوری کو کم کرنے کے لیے اٹھایا جا سکے۔\n📤 جمع کرانے کی صورت\nمکمل جوابات نیچے والے خانے میں نمبر وار لکھیں: پانچوں سوالات کے جواب مع وضاحت، پھر «نتیجہ» اور «اصلاحی قدم» کے الگ عنوانات کے ساتھ۔ یہ جواب صرف انتظامیہ دیکھے گی؛ ایمانداری ہی اس مشق کا اصل نمبر ہے۔",
  4: "🧭 پس منظر\nکلاس میں ہم نے تزویراتی منصوبہ بندی کی بنیاد کے طور پر «SWOT تجزیہ» پڑھا۔ اس کے چار خانے ہیں۔ «قوتیں» (Strengths) ادارے کے اندر کی وہ خوبیاں ہیں جو اس کے اپنے اختیار میں ہیں، مثلاً قابل اساتذہ یا عوامی اعتماد۔ «کمزوریاں» (Weaknesses) بھی اندر کی ہیں، مثلاً نظام کی کمی یا وسائل کی تنگی۔ «مواقع» (Opportunities) باہر کے ماحول میں موجود وہ امکانات ہیں جن سے فائدہ اٹھایا جا سکتا ہے، مثلاً نئی ٹیکنالوجی یا بڑھتی ہوئی طلب۔ «خطرات» (Threats) بھی باہر سے آتے ہیں، مثلاً بدلتے قوانین یا مقابلے کے ادارے۔ اندر اور باہر کا یہ فرق سمجھنا ضروری ہے، کیونکہ اندر کی چیز ہم خود بدل سکتے ہیں اور باہر کی چیز کے لیے تیاری کرنی پڑتی ہے۔ یہ تجزیہ اس لیے کیا جاتا ہے کہ ادارہ اندازوں کے بجائے واضح تصویر کی بنیاد پر آگے بڑھے — اکثر ہم وہ بیرونی خطرات نظر انداز کر دیتے ہیں جو آگے چل کر سب سے بڑا مسئلہ بنتے ہیں۔\n🎯 آپ کو کیا کرنا ہے\nاپنے مدرسے، تحقیقی مرکز یا اپنی ذاتی پیشہ وارانہ زندگی میں سے کسی ایک کا مکمل SWOT تجزیہ کریں — ہر خانے میں کم از کم تین نکات وضاحت کے ساتھ۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ سب سے اوپر لکھیں کہ تجزیہ کس کا ہے: ادارے کا نام یا نوعیت، یا «میری پیشہ وارانہ زندگی»۔\n۲۔ قوتیں: کم از کم تین اندرونی خوبیاں لکھیں، ہر ایک کے ساتھ ایک سطر کی دلیل یا مثال۔\n۳۔ کمزوریاں: کم از کم تین اندرونی کمزوریاں ایمانداری سے لکھیں، ہر ایک کے ساتھ اس کا اثر۔\n۴۔ مواقع: کم از کم تین بیرونی امکانات لکھیں جن سے ابھی فائدہ نہیں اٹھایا جا رہا۔\n۵۔ خطرات: کم از کم تین بیرونی خطرات لکھیں جو آئندہ چند سال میں اثر ڈال سکتے ہیں۔\n۔ نتیجہ: دو تین سطروں میں لکھیں کہ سب سے بڑی قوت کون سی ہے جس پر آگے کی تعمیر ہو سکتی ہے اور سب سے سنگین خطرہ کون سا ہے جس سے پہلے بچاؤ کرنا ہے۔\n📤 جمع کرانے کی صورت\nمکمل تجزیہ نیچے والے خانے میں چاروں عنوانات (قوتیں، کمزوریاں، مواقع، خطرات) الگ الگ لکھ کر اور آخر میں «نتیجہ» دے کر جمع کرائیں۔ معاون لنک اختیاری ہے؛ اصل کام یہی تحریر ہے۔",
  5: "🧭 پس منظر\nکلاس میں ہم نے «درجہ بندیِ تعلّم» (Bloom's Taxonomy) پڑھی — سیکھنے کی یہ سیڑھی ادنیٰ سطح سے اعلیٰ سطح کی طرف جاتی ہے۔ پہلی سطح «یاد رکھنا» ہے: تعریف یا فہرست رٹنا۔ دوسری «سمجھنا»: بات اپنے الفاظ میں بیان کرنا۔ تیسری «اطلاق کرنا»: اصول کو کسی نئی صورتِ حال پر لگانا۔ چوتھی «تجزیہ کرنا»: چیز کو حصوں میں توڑ کر ان کا باہمی تعلق دیکھنا۔ پانچویں «جانچنا»: دلائل پرکھ کر فیصلہ کرنا۔ اور آخری و اعلیٰ ترین «تخلیق کرنا»: بالکل نیا ماڈل یا حل پیش کرنا۔ ہمارے امتحانوں کی سب سے بڑی کمزوری یہ ہے کہ سوالات پہلی دو سطحوں پر اٹک جاتے ہیں، اس لیے طالب علم رٹا لگا کر پاس ہو جاتا ہے مگر سوچنا نہیں سیکھتا۔ استاد اگر سوال کی سطح بدل دے تو طالب علم کا دماغ خودبخود جانچا جاتا ہے — اسی لیے یہ مشق سوال بنانے کی ہے، حل کرنے کی نہیں۔\n🎯 آپ کو کیا کرنا ہے\nعام سطح کا دیا گیا سوال «وضو کے کتنے فرائض ہیں؟» دراصل «یاد رکھنا» کی سطح کا ہے۔ اسی موضوع (وضو) پر درجہ بندی کی اوپر والی تین سطحوں — اطلاق، تجزیہ اور تخلیق — کے تین نئے سوالات بنائیں۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ پہلے ایک سطر میں لکھیں کہ اصل سوال کس سطح کا ہے اور کیوں۔\n۲۔ اطلاق کا سوال: وضو کے اصول کو کسی نئی عملی صورتِ حال پر لگانے والا سوال بنائیں، مثلاً ایسی کیفیت پیش کریں جس میں طالب علم کو اصول استعمال کر کے حکم تک پہنچنا پڑے۔\n۳۔ تجزیے کا سوال: ایسا سوال بنائیں جس میں طالب علم کو اجزا الگ الگ کر کے یا دو صورتوں کا موازنہ کر کے وجہ تک پہنچنا پڑے۔\n۴۔ تخلیق کا سوال: ایسا سوال بنائیں جس میں طالب علم کو کوئی نیا خاکہ، ترتیب یا حل خود پیش کرنا پڑے۔\n۵۔ ہر سوال کے نیچے ایک سطر میں لکھیں کہ یہ سوال اسی سطح کا کیوں ہے — سوال پڑھنے والا رٹے سے جواب نہ دے سکے، یہی آپ کی کامیابی کی پہچان ہے۔\n📤 جمع کرانے کی صورت\nنیچے والے خانے میں پہلے اصل سوال کی سطح کی نشاندہی، پھر تینوں نئے سوالات نمبر وار ان کی سطح کے عنوان اور ایک سطری جواز کے ساتھ لکھ کر جمع کرائیں۔",
  6: "🧭 پس منظر\nکلاس میں ہم نے پڑھا کہ تحقیقی ادارے کا اصل امتحان یہ نہیں کہ وہ کتنا لکھتا ہے، بلکہ یہ ہے کہ اس کی بات فیصلہ ساز تک پہنچتی اور عمل میں بدلتی ہے یا نہیں۔ «پالیسی بریف» اسی مقصد کا اوزار ہے: طویل اور پیچیدہ تحریر کو ایک فیصلہ ساز افسر کے لیے اتنا مختصر اور واضح کر دینا کہ وہ چند لمحوں میں بات سمجھ کر فیصلہ کر سکے۔ اس مشق میں بریف کا سانچہ تین سوالات پر کھڑا ہے: مسئلہ کیا ہے؟ کیا ہونا چاہیے؟ اور کیسے ہوگا؟ اچھی پالیسی بریف کی پہچان یہ ہے کہ اس میں مشکل علمی زبان کے بجائے سادہ پالیسی زبان ہو، اور ہر جملہ اگلے جملے کی زمین ہموار کرے — پہلا جملہ مسئلہ اور اس کی سنگینی بتائے، دوسرا واضح تجویز دے، تیسرا اس تجویز پر عمل کا راستہ دکھائے۔\n🎯 آپ کو کیا کرنا ہے\nکسی مشہور دینی یا سماجی مسئلے — مثلاً مدارس کی رجسٹریشن یا جہیز کی رسم — کو منتخب کریں اور کسی حکومتی افسر کے لیے صرف تین جملوں کی پالیسی بریف لکھیں۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ سب سے اوپر بریف کا مختصر عنوان لکھیں اور ایک سطر میں لکھیں کہ یہ بریف کس قسم کے فیصلہ ساز کے لیے ہے۔\n۲۔ جملہ اول — مسئلہ کیا ہے: مسئلہ اور اس کے اصل نقصان یا اثر کو ایک ہی جملے میں واضح کریں۔\n۳۔ جملہ دوم — کیا ہونا چاہیے: اپنی ایک واضح تجویز پیش کریں؛ مبہم خواہش نہیں، قابلِ فیصلہ تجویز۔\n۴۔ جملہ سوم — کیسے ہوگا: عمل کا راستہ بتائیں — کون کرے گا، کس ذریعے سے ہوگا، پہلا قدم کیا ہوگا۔\n۵۔ آخر میں تینوں جملے دوبارہ پڑھیں: کیا کسی جملے میں غیر ضروری اصطلاح یا اضافی بات ہے؟ ہو تو حذف کر دیں — اختصار ہی اس مشق کا نمبر ہے۔\n📤 جمع کرانے کی صورت\nنیچے والے خانے میں عنوان اور مخاطب کی سطر کے ساتھ اپنی تین جملوں کی مکمل پالیسی بریف لکھ کر جمع کرائیں۔ بریف سے الگ کوئی تمہید یا وضاحت نہ لکھیں۔",
  8: "🧭 پس منظر\nکلاس میں ہم نے «مالیاتی شفافیت، آڈٹ اور اندرونی مالی کنٹرول» پڑھا اور ساتھ «مفادات کے ٹکراؤ» کا مسئلہ بھی: جب ذاتی اور ادارہ جاتی مفاد و وسائل آپس میں گڈمڈ ہو جائیں تو ادارے کی ساکھ اور بقا دونوں خطرے میں پڑ جاتی ہیں۔ بہت سے اداروں میں بے ایمانی نہیں ہوتی، مگر نظام نہیں ہوتا — ادارے کا پیسہ اور ذاتی پیسہ ایک ہی جیب یا ایک ہی اکاؤنٹ سے چلتا ہے، خرچ کی منظوری کا کوئی مرحلہ نہیں ہوتا، اور ریکارڈ نامکمل رہتا ہے۔ کل کو سوال اٹھے تو نیک نیتی کے باوجود جواب دینا مشکل ہو جاتا ہے۔ اسی لیے یہ آڈٹ دوسروں کا نہیں، اپنے نظام کا ہے: مقصد یہ جاننا ہے کہ آپ کے موجودہ نظام میں شفافیت کی کمی کہاں کہاں ہے، تاکہ اسے الزام لگنے سے پہلے دور کیا جا سکے۔\n🎯 آپ کو کیا کرنا ہے\nنیچے دی گئی چیک لسٹ کے پانچ سوالات پر اپنے ادارے کی اصل صورتِ حال کے مطابق ایمانداری سے «ہاں» یا «نہیں» جواب دیں، پھر کمیوں کی فہرست اور ان کی اصلاح کا پہلا قدم لکھیں۔ اگر آپ کسی ادارے کے مالی امور سے براہِ راست وابستہ نہیں تو اپنے مشاہدے کے مطابق اپنے ادارے کی صورتِ حال لکھیں۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ سوال ۱: کیا ادارے کا بینک اکاؤنٹ ذاتی اکاؤنٹ سے مکمل الگ ہے؟\n۲۔ سوال ۲: کیا ادارے کی گاڑی یا دیگر وسائل ذاتی کاموں میں استعمال نہیں ہوتے؟\n۳۔ سوال ۳: کیا کوئی بھی بڑا خرچ کرنے سے پہلے بورڈ یا شوریٰ سے منظوری لی جاتی ہے؟\n۴۔ سوال ۴: کیا تمام آمد و خرچ کی رسیدیں اور ریکارڈ باقاعدہ محفوظ رکھا جاتا ہے؟\n۵۔ سوال ۵: کیا ادارے کے حسابات کا باقاعدہ جائزہ یا آڈٹ ہوتا ہے؟\n۔ ہر جواب کے ساتھ ایک سطر میں موجودہ عملی صورتِ حال لکھیں۔\n۷۔ کمیاں: جن سوالات کا جواب «نہیں» ہے، انہیں الگ فہرست میں لکھیں — یہی آپ کی شفافیت کی کمزوریاں ہیں۔\n۸۔ اصلاح: ہر کمی کے سامنے ایک پہلا عملی قدم اور اس کے لیے مناسب مدت لکھیں۔\n📤 جمع کرانے کی صورت\nمکمل آڈٹ نیچے والے خانے میں لکھیں: پانچوں جوابات مع صورتِ حال، پھر «کمیاں» اور «اصلاحی اقدامات» کے عنوانات کے ساتھ۔ یہ جواب صرف انتظامیہ دیکھے گی۔",
  9: "🧭 پس منظر\nکلاس کا موضوع «رابطہ عامہ، عوامی اعتماد اور مواصلاتی اثر» تھا۔ اسی باب کی اس سرگرمی کا مقصد ہے: ادارے کا تعارف صرف تیس سیکنڈ میں کروانا۔ صورت یہ فرض کی گئی ہے کہ آپ ایک لفٹ میں کسی بڑے مخیر شخص یا وزیر کے ساتھ ہیں اور منزل آنے تک آپ کے پاس صرف تیس سیکنڈ — یعنی صرف تین جملے — ہیں۔ سامنے والا آپ کے ادارے کو نہیں جانتا، اس کے پاس وقت نہیں، اور وہ مشکل علمی یا فقہی اصطلاحات سے قائل نہیں ہوگا۔ اچھے تعارف کی پہچان یہ ہے کہ وہ مسئلہ بھی بتا دے، آپ کا کام بھی سمجھا دے اور سننے والے کے دل میں اگلی ملاقات کی خواہش بھی پیدا کر دے۔ یہی مختصر تعارف بعد میں ہر جگہ کام آتا ہے — کسی مجلس میں، کسی دفتر میں، کسی ممکن معاونت کار کے سامنے۔ علماء کے لیے سب سے بڑی مشق یہی ہے کہ گہری بات کو سادہ اور اثر انگیز زبان میں کہنا سیکھیں۔\n🎯 آپ کو کیا کرنا ہے\nاپنے ریسرچ سینٹر، مدرسے یا ادارے کا تین جملوں پر مشتمل ایسا تحریری تعارف تیار کریں جو تیس سیکنڈ میں بولا جا سکے اور سننے والے کو دلچسپی لینے پر مجبور کر دے۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ جملہ اول — مسئلہ: وہ ضرورت یا مسئلہ بتائیں جس پر آپ کا ادارہ کام کرتا ہے؛ بات اتنی سادہ ہو کہ غیر متعلق شخص بھی فوراً سمجھ جائے۔\n۲۔ جملہ دوم — آپ کا کام: بتائیں آپ کا ادارہ اس مسئلے پر کیا کرتا ہے اور اس کا انداز دوسروں سے کس بات میں مختلف یا بہتر ہے۔\n۳۔ جملہ سوم — اثر اور دعوت: بتائیں اس کام کا نتیجہ کیا نکل رہا ہے یا نکلے گا، اور آخر میں سامنے والے کے لیے کوئی نرم دعوت رکھیں، مثلاً ادارہ دیکھنے یا اگلی نشست میں تفصیل سننے کی۔\n۴۔ خود جانچ: پورا تعارف اونچی آواز میں پڑھ کر وقت نوٹ کریں — تیس سیکنڈ سے لمبا ہو تو جملے چھوٹے کریں؛ کوئی مشکل اصطلاح ہو تو اسے عام فہم لفظ سے بدل دیں۔\n📤 جمع کرانے کی صورت\nنیچے والے خانے میں پہلے ایک سطر میں لکھیں کہ یہ تعارف کس قسم کے سامع کے لیے ہے (مخیر شخص، وزیر یا عام معزز مہمان)، پھر اپنے تینوں جملے لکھ کر جمع کرائیں۔ تین جملوں سے زائد تمہید یا وضاحت نہ لکھیں۔",
  10: "🧭 پس منظر\nکلاس میں ہم نے «نگرانی و جانچ» کے تحت یہ سیکھا کہ کسی پروجیکٹ کی اصل قدر اس کے دعوؤں سے نہیں، اس کی زنجیرِ اثر کی مضبوطی سے جانچی جاتی ہے۔ یہ زنجیر «امپیکٹ چین» کہلاتی ہے اور اس کے پانچ کالم ہیں۔ «ان پٹ» وہ وسائل ہیں جو لگائے جاتے ہیں — رقم، اساتذہ، وقت، جگہ۔ «سرگرمیاں» وہ کام ہیں جو ان وسائل سے کیے جاتے ہیں — کلاسیں، ورکشاپس، مطبوعات۔ «آؤٹ پٹ» فوری پیداوار ہے جو گنی جا سکتی ہے — کتنے طلبہ پڑھے، کتنے کورس مکمل ہوئے۔ «آؤٹ کم» اس سے اگلا درجہ ہے: شرکاء میں واقع ہونے والی اصل تبدیلی — مہارت بڑھی، رویہ بدلا، عمل شروع ہوا۔ اور «امپیکٹ» سب سے آخری اور دیرپا اثر ہے جو معاشرے یا ادارے کی سطح پر ظاہر ہوتا ہے۔ اس مشق کا مقصد «آؤٹ پٹ اور امپیکٹ کا فرق» سمجھنا ہے، کیونکہ اکثر ادارے آؤٹ پٹ کے اعداد کو ہی اثر سمجھ کر مطمئن ہو جاتے ہیں، حالانکہ اصل تبدیلی اس سے کہیں آگے ہوتی ہے۔\n🎯 آپ کو کیا کرنا ہے\nاپنے کسی ایک تعلیمی پروجیکٹ کا انتخاب کریں اور اس کے لیے پانچ کالموں (ان پٹ، سرگرمیاں، آؤٹ پٹ، آؤٹ کم، امپیکٹ) پر مشتمل مکمل امپیکٹ چین بنائیں۔\n✍️ کیسے کرنا ہے — مرحلہ وار\n۱۔ سب سے اوپر پروجیکٹ کا نام اور ایک سطر میں اس کا مقصد لکھیں۔\n۲۔ ان پٹ: اس پروجیکٹ میں لگنے والے اصل وسائل لکھیں — رقم، افراد، وقت اور سہولتیں۔\n۳۔ سرگرمیاں: وہ کام لکھیں جو ان وسائل سے انجام پاتے ہیں۔\n۴۔ آؤٹ پٹ: گنی جا سکنے والی فوری پیداوار اعداد کے ساتھ لکھیں۔\n۵۔ آؤٹ کم: شرکاء میں ہونے والی وہ تبدیلی لکھیں جو آؤٹ پٹ کے بعد ظاہر ہوتی ہے۔\n۔ امپیکٹ: طویل مدت میں ادارے یا معاشرے پر پڑنے والا دیرپا اثر لکھیں۔\n۷۔ آخری جانچ: ہر کالم کو پچھلے کالم سے جوڑ کر پڑھیں — ہر اگلا کالم پچھلے کا فطری نتیجہ ہونا چاہیے، اور آؤٹ پٹ کو امپیکٹ نہ لکھا گیا ہو۔\n📤 جمع کرانے کی صورت\nمکمل چین نیچے والے خانے میں پانچوں عنوانات الگ الگ لکھ کر جمع کرائیں؛ ہر کالم کے نیچے اس کے نکات واضح ہوں۔ معاون لنک اختیاری ہے۔",
};

// The release plan derived from the sessions (all 09:00 Karachi):
// form 1 the day AFTER the session (Tue, +1), form 2 on Thursday (+3)
// and the slide activity on Saturday (+5) — Mufti 2026-11-05 (form 2 and
// the activity moved from Wednesday so students get breathing room).
// Deadlines UNCHANGED: the next session's start (Mon 20:00 Karachi);
// the last session's items close 2027-01-11 20:00 Karachi.
// Google-Form assignments carry 10 marks (Mufti 2026-11-03): the answers
// themselves land in the form's own sheet, but the student CLAIMS the
// submission in-app (formClaim) and the admin grades it against the sheet
// answers and the class material — so the app holds the claim, the marks
// and the feedback. In-app activity assignments carry 20 marks by default
// (admin-editable).
function releasePlan() {
  const items = [];
  for (const s of BATCH1_SESSIONS) {
    const next = BATCH1_SESSIONS[s.n] || null; // n is 1-based; index n = next
    const deadline = next ? planInstantMs(next.date, 0, 20) : planInstantMs('2027-01-11', 0, 20);
    if (s.form1) items.push({
      id: `asg-b1-f1-s${s.n}`, kind: 'form1', session: s.n, type: 'google-form',
      title: `مشق فارم 1 — کلاس ${s.n}: ${s.form1Name || s.title}`,
      instructions: `کلاس ${s.n} (${s.title}) کی پہلی سرگرمی کا گوگل فارم ہے۔ فارم کھول کر تمام سوالات کے جوابات غور سے دیں — آپ کے جوابات براہِ راست انتظامیہ کے ریکارڈ میں جائیں گے۔`,
      formUrl: s.form1, releaseAtMs: planInstantMs(s.date, 1, 9), deadlineMs: deadline, maxMarks: 10,
    });
    if (s.form2) items.push({
      id: `asg-b1-f2-s${s.n}`, kind: 'form2', session: s.n, type: 'google-form',
      title: `مشق فارم 2 — کلاس ${s.n}: ${s.form2Name || s.title}`,
      instructions: `کلاس ${s.n} (${s.title}) کی دوسری سرگرمی کا گوگل فارم ہے۔ فارم کھول کر تمام سوالات کے جوابات غور سے دیں — آپ کے جوابات براہِ راست انتظامیہ کے ریکارڈ میں جائیں گے۔`,
      formUrl: s.form2, releaseAtMs: planInstantMs(s.date, 3, 9), deadlineMs: deadline, maxMarks: 10,
    });
    if (s.activity) items.push({
      id: `asg-b1-act-s${s.n}`, kind: 'activity', session: s.n, type: 'in-app',
      title: `سلائیڈ سرگرمی — کلاس ${s.n}: ${s.activity}`,
      instructions: ACTIVITY_INSTRUCTIONS[s.n] || `یہ مشق کلاس ${s.n} «${s.title}» کی سرگرمی ہے: «${s.activity}»۔ اپنا کام تحریری صورت میں نیچے والے خانے میں مکمل لکھیں؛ کوئی معاون لنک ہو تو وہ بھی شامل کر سکتے ہیں۔ جمع کرانے کے بعد انتظامیہ نمبر دے گی اور وہ آپ کو یہیں نظر آئے گا۔`,
      formUrl: '', releaseAtMs: planInstantMs(s.date, 5, 9), deadlineMs: deadline, maxMarks: 20,
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
      // Class 2 only (2026-11-09): attendance force-open for the whole
      // Karachi day — Mufti's order after the window confusion in class.
      ...(s.n === 2 ? { attForceOpen: '2026-11-09' } : {}),
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
    const r = await db.collection('notifications').updateOne(
      { email: u.email, id: nid },
      {
        $setOnInsert: {
          _id: nid, id: nid, email: u.email, kind: 'course', read: false,
          date: now,
          title: '🏛️ ادارہ سازی کورس — بیچ 1: رجسٹریشن کھل گئی ہے',
          body: 'آپ کی اہلیت کے مطابق یہ خصوصی کورس آپ کے لیے کھلا ہے: ہر پیر رات 8:00 تا 9:30 (پاکستانی وقت)، آغاز پیر 2 نومبر 2026 — ٹرینرز: ڈاکٹر مفتی محمد حسن و محترمہ انعم زیدی صاحبہ۔ رجسٹریشن «ادارہ سازی کورس» والے حصے سے کریں۔',
        },
      },
      { upsert: true }
    );
    if (r.upsertedCount) notified += 1;
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
  const healed = [];
  const registered = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1 }).toArray();
  for (const item of releasePlan()) {
    if (item.releaseAtMs > now) continue;
    const existing = await db.collection('assignments').findOne({ _id: item.id });
    if (existing) {
      // Heal (Mufti 2026-11-03): plan google-form assignments created before
      // forms carried marks still store maxMarks 0 — lift ONLY that field
      // to the plan value so grading/clamping works on live assignments.
      // Titles, times and every other field stay exactly as stored;
      // assignments whose id is not in the plan are never reached here.
      if (item.type === 'google-form' && existing.type === 'google-form'
        && (existing.maxMarks === 0 || existing.maxMarks === undefined || existing.maxMarks === null)) {
        await db.collection('assignments').updateOne(
          { _id: item.id }, { $set: { maxMarks: item.maxMarks } }
        );
        healed.push(item.id);
      }
      continue;
    }
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
      await db.collection('notifications').updateOne(
        { email: u.email, id: nid },
        {
          $setOnInsert: {
            _id: nid, id: nid, email: u.email, kind: 'assignment', read: false,
            date: new Date().toISOString(),
            title: '✍️ نئی مشق — ادارہ سازی کورس',
            body: `${item.title} — «اسائنمنٹس» والے حصے میں کھول کر مکمل کریں۔`,
          },
        },
        { upsert: true }
      );
    }
  }
  if (created.length) console.log('course releases created:', created.join(', '));
  if (healed.length) console.log('course releases healed (form maxMarks):', healed.join(', '));
  return { created, healed };
}

// ---------- one-time notice: the google-form marks system (2026-11-03) ----------
// Exactly-once by construction: the notification id is deterministic
// (`form-system-2026-11-03-<email>`) and the write is a $setOnInsert
// upsert — the same pattern as every other course notification — so
// calling this any number of times notifies each registered student
// exactly once, ever.
const FORM_SYSTEM_NOTICE = {
  kind: 'assignment',
  title: '✍️ فارم مشقوں کا نیا نظام — ادارہ سازی کورس',
  body: 'اب ہر گوگل فارم مشق کے بھی ایپ میں نمبر ملیں گے (کل 10)۔ طریقہ: (۱) فارم کھول کر جوابات جمع کرائیں؛ (۲) واپس ایپ کے «اسائنمنٹس» میں اسی مشق پر «میں نے فارم جمع کرا دیا ہے» دبائیں۔ انتظامیہ فارم شیٹ سے آپ کے جوابات کلاس کے مواد کے مطابق پرکھ کر نمبر دے گی — نمبر اور رائے آپ کو یہیں «میرے نمبرات» میں نظر آئیں گے۔ جو طلبہ کلاس 1 کا فارم بھر چکے ہیں وہ اس کا اندراج بھی ابھی کر لیں۔',
};
async function notifyFormSystemOnce(db) {
  const now = new Date().toISOString();
  const registered = await db.collection('users')
    .find({ courseReg: true, status: 'approved' }).project({ email: 1 }).toArray();
  let created = 0;
  for (const u of registered) {
    const nid = `form-system-2026-11-03-${u.email}`;
    const r = await db.collection('notifications').updateOne(
      { email: u.email, id: nid },
      {
        $setOnInsert: {
          _id: nid, id: nid, email: u.email, kind: FORM_SYSTEM_NOTICE.kind, read: false,
          date: now, title: FORM_SYSTEM_NOTICE.title, body: FORM_SYSTEM_NOTICE.body,
        },
      },
      { upsert: true }
    );
    if (r.upsertedCount) created += 1;
  }
  return { created, total: registered.length };
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
  // Admin-entered attendance counts for the record too — the same union
  // every surface uses (attStateFor): users.courseAtt (array) AND
  // users.sessionAtts (per-session map, the form this API writes).
  for (const sid of (user.courseAtt || [])) if (courseIds.has(sid)) attended.add(sid);
  const attMap = user.sessionAtts || {};
  if (attMap && typeof attMap === 'object') {
    for (const [sid, v] of Object.entries(attMap)) if (v && courseIds.has(sid)) attended.add(sid);
  }
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

// ---------- ONE attendance rule for every surface (Mufti 2026-11-03) ----------
// A student is حاضر for a session iff a VERIFIED claim exists OR an
// admin-entered record exists on the user doc (users.sessionAtts map /
// users.courseAtt array — written by the manual-mark endpoint and the
// legacy admin tool). An unverified code claim is its OWN visible state
// ('pending' — «تصدیق باقی»), never silently absent and never counted
// present. The source tag travels with the tick: a verified claim keeps
// its own tag ('manual' claim doc vs plain code claim); presence that
// only a user-doc record proves is an admin entry by construction.
// Every admin surface (attendance section, gradebook, student list/PDF,
// points) derives from this one function so they can never diverge.
function attStateFor(user, sid, claim) {
  if (claim && claim.status === 'تصدیق شدہ') {
    return { state: 'present', source: claim.source === 'manual' ? 'manual' : 'code' };
  }
  const u = user || {};
  const fromUser = !!((u.sessionAtts && u.sessionAtts[sid])
    || (Array.isArray(u.courseAtt) && u.courseAtt.includes(sid)));
  if (fromUser) return { state: 'present', source: 'manual' };
  if (claim && claim.status !== 'مسترد') return { state: 'pending', source: 'code' };
  return { state: 'none', source: null };
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
  COURSE_REG_OPEN,
  MPHIL_DONE, PHD_DONE, ELIGIBILITY_MSG,
  courseEligibleQuick, courseEligible,
  BATCH1_SESSIONS, sessionIdFor, releasePlan, planGaps, ACTIVITY_INSTRUCTIONS,
  seedCourseBatch, runCourseReleases, notifyFormSystemOnce, FORM_SYSTEM_NOTICE,
  recomputeCoursePoints, badgesFor, courseLeaderboard, attStateFor,
};
