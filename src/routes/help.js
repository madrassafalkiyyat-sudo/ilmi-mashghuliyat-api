'use strict';
// Muse help — Layer 2: in-app AI assistant (Google Gemini).
// The student never leaves the app and never sees a key: the browser
// posts the question (+ optional screenshot/PDF) here, and this route
// forwards it to Gemini with the app's own grounded data as context.
// The API key is read ONLY from process.env.GEMINI_API_KEY (Render env)
// — it is never stored in code, logged, or returned to the client.
// If the key is absent the route answers an honest 501 (the same
// pattern as the email_not_configured 501 in routes/auth.js) instead of
// pretending the assistant works.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyAccessToken } = require('../auth');
const { fail, requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_QUESTION_CHARS = 2000;
const MAX_ATTACHMENT_BYTES = Math.floor(4.5 * 1024 * 1024); // decoded, all attachments together
const MAX_CONTEXT_CHARS = 6000; // serialized context JSON cap (grounding data, not prose)
const UPSTREAM_TIMEOUT_MS = 30000;

/* ---------- optional auth ----------
   A valid Bearer JWT makes the caller a "student" (higher quota).
   A missing OR invalid token is NOT an error — the caller is simply
   treated as public with the lower quota. Never 401 here: the help
   centre is also used from the public admissions hub. */
function optionalAuth(req, res, next) {
  req.helpUserId = null;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      if (payload && payload.sub) req.helpUserId = String(payload.sub);
    } catch (e) { /* invalid/expired token → public caller */ }
  }
  return next();
}

/* ---------- rate limit ----------
   Per-day quotas, in-memory store (express-rate-limit default): the
   counts reset whenever the service redeploys/restarts — acceptable
   for abuse prevention on a free-tier deployment. Students (valid
   JWT) get 40/day keyed by user id; the public gets 8/day keyed by
   IP. Runs AFTER optionalAuth so the key/limit can see the identity. */
const helpLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: (req) => (req.helpUserId ? 40 : 8),
  keyGenerator: (req) => (req.helpUserId ? 'u:' + req.helpUserId : 'ip:' + req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => fail(res, 429, 'rate_limited', 'آج کے سوالات کی حد پوری ہو گئی ہے — براہ کرم کل دوبارہ کوشش کریں'),
});

/* ---------- system prompt (Urdu-first, grounding rules) ---------- */
const SYSTEM_PROMPT = [
  'آپ «Muse» ہیں — «مدرسہ یونیورسٹیز سٹڈیز» ایپ کے اندر موجود مددگار۔ آپ مدارس کے فضلاء و فاضلات کو یونیورسٹی داخلوں، فارم بھرنے اور انٹری ٹیسٹ کی تیاری میں مدد دیتے ہیں۔',
  'قواعد:',
  '1) جواب اسی زبان میں دیں جس میں سوال پوچھا گیا ہے؛ طے شدہ زبان اردو ہے۔ اسکرین شاٹ یا PDF کی زبان بھی جواب کی زبان طے کر سکتی ہے۔',
  '2) یونیورسٹی سے متعلق حقائق (فیس، تاریخیں، اہلیت، انٹری ٹیسٹ، لنکس) صرف نیچے «ایپ کا ڈیٹا» میں دی گئی معلومات سے بتائیں۔ جو بات اس ڈیٹا میں موجود نہ ہو، صاف کہیں کہ یہ معلومات ایپ میں موجود نہیں اور طالب علم کو یونیورسٹی کی آفیشل ویب سائٹ دیکھنے کا کہیں۔ فیس، تاریخ، آخری تاریخ یا لنک کبھی خود سے ایجاد نہ کریں۔',
  '3) فارم بھرنے کی مدد ہو تو ہر خانے کے سامنے الگ بتائیں کہ اس میں کیا لکھنا ہے۔',
  '4) اسکرین شاٹ ملے تو پہلے بتائیں کہ اس میں کیا نظر آ رہا ہے، پھر بتائیں کہ طالب علم اگلا قدم کیا کرے۔',
  '5) جواب مختصر، مرحلہ وار اور سادہ اردو میں دیں؛ جہاں ضرورت ہو انگریزی اصطلاح بریکٹ میں لکھیں۔',
  '6) آپ کا دائرہ تعلیمی داخلے، فارم، انٹری ٹیسٹ اور اسی ایپ کا استعمال ہے — اس سے باہر کے سوال پر نرمی سے یہی واضح کر دیں۔',
].join('\n');

/* ---------- attachment parsing ----------
   Accepts a data-URI ("data:image/png;base64,....") or raw base64.
   Returns { mime, data } or null when malformed / wrong type. */
function parseAttachment(raw, kind) {
  if (raw == null) return null;
  if (typeof raw !== 'string' || !raw.trim()) return 'bad';
  let mime = kind === 'pdf' ? 'application/pdf' : 'image/png';
  let data = raw.trim();
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    if (comma < 0) return 'bad';
    const meta = data.slice(5, comma);
    const m = meta.match(/^([^;]+)/);
    if (m && m[1]) mime = m[1].trim().toLowerCase();
    data = data.slice(comma + 1);
  }
  data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/=_-]+$/.test(data)) return 'bad';
  if (kind === 'pdf') {
    if (mime !== 'application/pdf') return 'bad';
  } else if (!mime.startsWith('image/')) {
    return 'bad';
  }
  return { mime, data };
}

function decodedBytes(b64) {
  // Exact decoded length without materialising a huge buffer twice.
  let len = b64.length;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.floor((len * 3) / 4) - pad;
}

/* ---------- Gemini call with model fallback ----------
   Candidates (env GEMINI_MODEL first): gemini-3.5-flash-lite leads
   (measured 2026-10-30: gemini-3.8-flash is overloaded — 503s and
   hangs pushed answers past 100s; the lite model answers the same
   grounded questions in seconds). gemini-2.5-flash is "not found"
   for this key's project.
   So: a 404 moves to the next candidate; a 429/5xx/timeout retries
   the same model once, then moves on; any other HTTP error stops.
   An overall deadline caps the whole chain. Upstream bodies and the
   key are never forwarded to the client. */
async function callGemini(apiKey, parts, opts) {
  const o = opts || {};
  const primary = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const candidates = [];
  [primary, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'].forEach((m) => {
    if (m && !candidates.includes(m)) candidates.push(m);
  });
  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: typeof o.temperature === 'number' ? o.temperature : 0.3,
      maxOutputTokens: typeof o.maxOutputTokens === 'number' ? o.maxOutputTokens : 1024,
    },
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 90000;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() > deadline) { console.error('help: overall deadline exceeded'); return null; }
      let resp;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
        try {
          resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body,
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.error(`help: Gemini request failed (model ${model}, attempt ${attempt + 1}):`, e && e.message);
        if (attempt === 0) { await sleep(1500); continue; }
        break;
      }
      if (resp.status === 404) {
        console.error(`help: model ${model} not found, trying next candidate`);
        break;
      }
      if (resp.status === 429 || resp.status >= 500) {
        console.error(`help: Gemini HTTP ${resp.status} (model ${model}, attempt ${attempt + 1})`);
        if (attempt === 0) { await sleep(1500); continue; }
        break;
      }
      if (!resp.ok) {
        console.error(`help: Gemini HTTP ${resp.status} (model ${model})`);
        return null;
      }
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        console.error('help: Gemini response was not JSON');
        return null;
      }
      const out = data && data.candidates && data.candidates[0] && data.candidates[0].content;
      const texts = out && Array.isArray(out.parts)
        ? out.parts.map((pt) => (pt && typeof pt.text === 'string' ? pt.text : '')).filter(Boolean)
        : [];
      const answer = texts.join('\n').trim();
      if (answer) return answer;
      console.error(`help: empty answer (model ${model})`);
      break;
    }
  }
  return null;
}

/* ---------- POST /api/help/ask ---------- */
router.post('/ask', optionalAuth, helpLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail(res, 501, 'ai_not_configured', 'AI مدد ابھی فعال نہیں ہے — فی الحال «فارم رہنمائی» اور مدد مرکز کے باقی حصے استعمال کریں');
  }
  const body = req.body || {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return fail(res, 400, 'bad_question', 'اپنا سوال لکھ کر بھیجیں');
  if (question.length > MAX_QUESTION_CHARS) {
    return fail(res, 400, 'bad_question', 'سوال بہت لمبا ہے — 2000 حروف سے کم رکھیں');
  }

  const img = parseAttachment(body.imageBase64, 'image');
  const pdf = parseAttachment(body.pdfBase64, 'pdf');
  if (img === 'bad' || pdf === 'bad') {
    return fail(res, 400, 'bad_attachment', 'منسلک فائل درست نہیں — تصویر یا PDF دوبارہ لگا کر بھیجیں');
  }
  const totalBytes = (img ? decodedBytes(img.data) : 0) + (pdf ? decodedBytes(pdf.data) : 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    return fail(res, 413, 'payload_too_large', 'منسلک فائل بہت بڑی ہے — کل سائز ساڑھے چار MB سے کم رکھیں');
  }

  // Grounding context: whatever the client sent (section, the selected
  // university's app-data fields, the student's own basic profile) is
  // passed to the model clearly delimited and size-capped.
  let contextJson = '';
  if (body.context && typeof body.context === 'object' && !Array.isArray(body.context)) {
    try { contextJson = JSON.stringify(body.context); } catch (e) { contextJson = ''; }
    if (contextJson.length > MAX_CONTEXT_CHARS) contextJson = contextJson.slice(0, MAX_CONTEXT_CHARS);
  }

  const parts = [{
    text: SYSTEM_PROMPT
      + '\n\n=== ایپ کا ڈیٹا (سیاق) ===\n' + (contextJson || '{}')
      + '\n\n=== طالب علم کا سوال ===\n' + question,
  }];
  if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  if (pdf) parts.push({ inline_data: { mime_type: pdf.mime, data: pdf.data } });

  const answer = await callGemini(apiKey, parts);
  if (!answer) {
    return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
  }
  return res.json({ ok: true, answer });
});

/* ================================================================
   PART A — Conference abstract builder (Mufti's order 2026-10-30)
   POST /api/help/abstract/themes  -> exactly 3 theme proposals
   POST /api/help/abstract/write   -> title + abstract + keywords
   Unlike /ask these REQUIRE a valid JWT (logged-in students only,
   enforced by the same requireAuth the rest of the API uses) and have
   their own per-user daily bucket: 30 requests/day across BOTH
   endpoints (themes + write share one counter, keyed by user id).
   Validation runs BEFORE the API-key check so clients (and tests)
   get the honest 400 for malformed input even when no key is set.
   ================================================================ */
const abstractLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => 'abs:' + (req.user && req.user._id ? req.user._id : req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => fail(res, 429, 'rate_limited', 'آج کے ایبسٹریکٹ کی حد پوری ہو گئی ہے — براہ کرم کل دوبارہ کوشش کریں'),
});

const ABS_LANGS = {
  en: 'English',
  ar: 'Arabic (العربية)',
  ur: 'Urdu (اردو)',
};
const MAX_ADTEXT_CHARS = 6000;
const MAX_THEME_CHARS = 300;
const MAX_FIELD_CHARS = 500;

function absStr(v, cap) {
  return typeof v === 'string' ? v.trim().slice(0, cap) : '';
}

function absConference(body) {
  const c = body && typeof body.conference === 'object' && body.conference !== null ? body.conference : {};
  const conf = {
    title: absStr(c.title, MAX_FIELD_CHARS),
    details: absStr(c.details, 2500),
    deadline: absStr(c.deadline, 200),
    link: absStr(c.link, 500),
  };
  let confJson = '';
  try { confJson = JSON.stringify(conf); } catch (e) { confJson = ''; }
  if (confJson.length > MAX_CONTEXT_CHARS) confJson = confJson.slice(0, MAX_CONTEXT_CHARS);
  return { conf, confJson };
}

// Models sometimes wrap JSON in ``` fences or add a line of prose;
// take the outermost bracketed span and parse that.
function looseJson(text, open, close) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const a = s.indexOf(open);
  const b = s.lastIndexOf(close);
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

router.post('/abstract/themes', requireAuth, abstractLimiter, async (req, res) => {
  const body = req.body || {};
  const language = absStr(body.language, 10);
  if (!ABS_LANGS[language]) {
    return fail(res, 400, 'bad_language', 'زبان منتخب کریں — English، العربية یا اردو');
  }
  const topic = absStr(body.topic, MAX_FIELD_CHARS);
  const area = absStr(body.area, MAX_FIELD_CHARS);
  const adText = absStr(body.adText, MAX_ADTEXT_CHARS + 1);
  if (adText.length > MAX_ADTEXT_CHARS) {
    return fail(res, 400, 'bad_adtext', 'اشتہار کا متن بہت لمبا ہے — 6000 حروف سے کم رکھیں');
  }
  const img = parseAttachment(body.imageBase64, 'image');
  if (img === 'bad') {
    return fail(res, 400, 'bad_attachment', 'منسلک تصویر درست نہیں — دوبارہ لگا کر بھیجیں');
  }
  if (img && decodedBytes(img.data) > MAX_ATTACHMENT_BYTES) {
    return fail(res, 413, 'payload_too_large', 'منسلک تصویر بہت بڑی ہے — سائز 4 MB سے کم رکھیں');
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail(res, 501, 'ai_not_configured', 'AI مدد ابھی فعال نہیں ہے — بعد میں دوبارہ کوشش کریں');
  }
  const { confJson } = absConference(body);
  const prompt = [
    'You are an academic research advisor for madrasa graduates (ulama) applying to academic conferences.',
    `Propose EXACTLY 3 DISTINCT, specific research themes for a conference paper, in ${ABS_LANGS[language]}.`,
    'Ground every theme ONLY in the conference information and the student context below. Each theme must be realistically researchable by this student and aligned with the conference.',
    'Do NOT invent the student\'s name, results, data or references. Do not repeat the same idea in different words.',
    'Respond with ONLY a JSON array of exactly 3 objects, each {"title": "...", "angle": "..."} — angle is ONE line explaining the research angle. No prose outside the JSON.',
    '',
    '=== Conference information (JSON) ===',
    confJson || '{}',
    '',
    '=== Student context ===',
    'Research area: ' + (area || '(not given)'),
    'Topic of interest: ' + (topic || '(not given)'),
    adText ? '\n=== Call for papers / additional text supplied by the student ===\n' + adText : '',
  ].join('\n');
  const parts = [{ text: prompt }];
  if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  const answer = await callGemini(apiKey, parts, { maxOutputTokens: 700, temperature: 0.5 });
  if (!answer) {
    return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
  }
  const parsed = looseJson(answer, '[', ']');
  const themes = Array.isArray(parsed)
    ? parsed.filter((t) => t && typeof t.title === 'string' && t.title.trim())
        .slice(0, 3)
        .map((t) => ({ title: t.title.trim().slice(0, MAX_THEME_CHARS), angle: typeof t.angle === 'string' ? t.angle.trim().slice(0, MAX_THEME_CHARS) : '' }))
    : [];
  if (themes.length !== 3) {
    console.error('help/abstract/themes: could not parse 3 themes from upstream answer');
    return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
  }
  return res.json({ ok: true, themes });
});

router.post('/abstract/write', requireAuth, abstractLimiter, async (req, res) => {
  const body = req.body || {};
  const language = absStr(body.language, 10);
  if (!ABS_LANGS[language]) {
    return fail(res, 400, 'bad_language', 'زبان منتخب کریں — English، العربية یا اردو');
  }
  const theme = absStr(body.theme, MAX_THEME_CHARS + 1);
  if (!theme) {
    return fail(res, 400, 'bad_theme', 'پہلے کوئی تھیم منتخب کریں');
  }
  if (theme.length > MAX_THEME_CHARS) {
    return fail(res, 400, 'bad_theme', 'تھیم بہت لمبی ہے — 300 حروف سے کم رکھیں');
  }
  const topic = absStr(body.topic, MAX_FIELD_CHARS);
  const area = absStr(body.area, MAX_FIELD_CHARS);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail(res, 501, 'ai_not_configured', 'AI مدد ابھی فعال نہیں ہے — بعد میں دوبارہ کوشش کریں');
  }
  const { confJson } = absConference(body);
  const prompt = [
    'You are an academic writing assistant for madrasa graduates (ulama).',
    `Write a formal academic conference ABSTRACT in ${ABS_LANGS[language]} on the selected theme below.`,
    'Length: about 250–350 words. Structure, in flowing prose (no headings): background/context, the problem or gap, objectives, methodology, and the expected contribution.',
    'Ground the abstract ONLY in the conference information and student context below. NEVER invent the student\'s name, findings, results, data, statistics or citations, and do NOT include a reference list.',
    'If the context is thin, write at proposal level — aims, questions and method — instead of fabricating findings.',
    'Respond with ONLY a JSON object {"title": "...", "abstract": "...", "keywords": ["...", "..."]} with 3–6 keywords. No prose outside the JSON.',
    '',
    '=== Selected theme ===',
    theme,
    '',
    '=== Conference information (JSON) ===',
    confJson || '{}',
    '',
    '=== Student context ===',
    'Research area: ' + (area || '(not given)'),
    'Topic of interest: ' + (topic || '(not given)'),
  ].join('\n');
  const answer = await callGemini(apiKey, [{ text: prompt }], { maxOutputTokens: 2000, temperature: 0.4 });
  if (!answer) {
    return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
  }
  const parsed = looseJson(answer, '{', '}');
  if (!parsed || typeof parsed.abstract !== 'string' || !parsed.abstract.trim()) {
    console.error('help/abstract/write: could not parse abstract from upstream answer');
    return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
  }
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 6).map((k) => k.trim().slice(0, 80))
    : [];
  return res.json({
    ok: true,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, MAX_THEME_CHARS) : theme,
    abstract: parsed.abstract.trim().slice(0, 6000),
    keywords,
  });
});

module.exports = router;
