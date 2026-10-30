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

/* ================================================================
   PART F — Guided form filling (Mufti, 2026-10-31)
   POST /api/help/formfill {link?, imageBase64?, note?}
   JWT REQUIRED (the answer sheet is built from the student's own
   record). The endpoint NEVER submits anything anywhere and never
   asks for external credentials: it reads the form's fields (from
   the page HTML, or from a screenshot via Gemini vision), maps each
   field to an answer taken ONLY from the student's own users doc
   (+ values the student typed in `note`), and returns the ordered
   answer sheet. A field the record cannot answer stays null — the
   client shows «آپ کے پروفائل میں موجود نہیں — یہ خانہ خود بھریں».
   ================================================================ */
const formfillLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => 'ff:' + (req.user && req.user._id ? req.user._id : req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => fail(res, 429, 'rate_limited', 'آج کے فارم کی حد پوری ہو گئی ہے — براہ کرم کل دوبارہ کوشش کریں'),
});

const MAX_FORM_FIELDS = 60;

/* --- link safety: http(s) only; loopback/private hosts blocked
   (SSRF hygiene for a server-side fetch). Tests opt in explicitly
   with ALLOW_LOCAL_FORM_FETCH=1 so fixtures can live on 127.0.0.1. */
function formUrlAllowed(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return process.env.ALLOW_LOCAL_FORM_FETCH === '1';
  }
  return true;
}

async function fetchFormPage(link) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    // resp.url is the FINAL URL after redirects — forms.gle short links
    // resolve to their docs.google.com/forms target here (Part 7).
    return { html: text.slice(0, 1500000), headers: resp.headers, finalUrl: resp.url || link }; // ~1.5MB cap
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Can this page be shown inside the app's <iframe> at all? Decided from
   the FINAL response headers (after redirects): X-Frame-Options DENY /
   SAMEORIGIN, or a CSP frame-ancestors directive that does not wildcard-
   allow framing, mean the browser would show its own raw error document
   («refused to connect») — the client must render our friendly blocked
   panel instead and never create the iframe (Mufti, 2026-10-31, AIOU). */
function frameEmbeddable(headers) {
  if (!headers || typeof headers.get !== 'function') return true;
  const xfo = String(headers.get('x-frame-options') || '').toUpperCase();
  if (/\bDENY\b/.test(xfo) || /\bSAMEORIGIN\b/.test(xfo)) return false;
  const csp = String(headers.get('content-security-policy') || '');
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m && !m[1].includes('*')) return false;
  return true;
}

function htmlText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferKind(tagType, label) {
  const t = String(tagType || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (t === 'password') return 'password';
  if (t === 'file') return 'file';
  if (t === 'email' || /e-?mail|ای میل/.test(l)) return 'email';
  if (t === 'tel' || /whats ?app|واٹس ایپ|mobile|phone|موبائل|فون|رابطہ/.test(l)) return 'phone';
  if (t === 'date' || /date of birth|تاریخ پیدائش|پیدائش کی تاریخ/.test(l)) return 'date';
  if (t === 'number') return 'number';
  if (t === 'checkbox' || t === 'radio' || t === 'select') return 'choice';
  if (t === 'textarea') return 'paragraph';
  return 'text';
}

/* Google Forms pages carry their questions in an embedded
   FB_PUBLIC_LOAD_DATA_ array. Walk it defensively: a question item
   is an array whose [0] is a numeric id, [1] the title string, [3] a
   numeric type code and [4] the answer-part list; each part's [0] is
   the question's entry.<id> — the key Google's prefilled links use
   (Part 7). A node only counts as a question when it carries at
   least one numeric entry id (section headers etc. carry none and
   are skipped). Returns [] when the shape is absent. */
function extractGoogleFormFields(html) {
  const marker = html.indexOf('FB_PUBLIC_LOAD_DATA_');
  if (marker < 0) return [];
  const start = html.indexOf('[', marker);
  if (start < 0) return [];
  // Bracket-balance scan for the array literal (strings may hold ]).
  let depth = 0; let inStr = false; let esc = false; let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  let data;
  try { data = JSON.parse(html.slice(start, end + 1)); } catch (e) { return []; }
  const typeKind = { 0: 'text', 1: 'paragraph', 2: 'choice', 3: 'choice', 4: 'checkbox', 5: 'choice', 6: 'grid', 7: 'file', 9: 'date', 10: 'time' };
  // Types a prefilled link can actually carry. File uploads (7) and
  // grids (6) can never be prefilled — they stay manual by design.
  const prefillTypes = new Set([0, 1, 2, 3, 4, 5, 9, 10]);
  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'string' && typeof node[3] === 'number' && Array.isArray(node[4]) && node[1].trim()) {
      const gType = node[3];
      const parts = node[4].filter((p) => Array.isArray(p) && typeof p[0] === 'number');
      if (!parts.length) return; // not an answerable question (header…)
      parts.forEach((part, pi) => {
        const entryId = part[0];
        if (seen.has(entryId)) return;
        seen.add(entryId);
        const rawOpts = Array.isArray(part[1]) ? part[1] : [];
        const options = rawOpts.map((o) => (Array.isArray(o) ? String(o[0] || '').trim() : '')).filter(Boolean);
        out.push({
          label: node[1].trim(),
          kind: typeKind[gType] || 'text',
          entryId,
          gType,
          options,
          // A multi-part question (grid rows) shares one title across
          // several entry ids; only single-part questions prefill.
          prefillCapable: parts.length === 1 && prefillTypes.has(gType),
        });
        void pi;
      });
      return; // do not descend into a question's own sub-arrays
    }
    for (const child of node) walk(child);
  })(data);
  return out;
}

/* The canonical public base of a Google Form (…/viewform, no query):
   prefilled links are built on it. An /edit authoring URL is turned
   into its public /viewform twin; anything else keeps origin+path. */
function googleFormBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  let path = u.pathname.replace(/\/edit\/?$/, '/viewform');
  return u.origin + path;
}

/* One field → its prefilled-link parameters. Mirrors the frontend
   builder (ffPrefillParams) — keep the two in step. Returns [] when
   the value cannot travel: no entry id, not prefill-capable, empty
   answer, a dropdown/scale value outside the offered options, or a
   date/time that is not in a clean, parseable shape. */
function googlePrefillParams(f) {
  if (!f || f.entryId == null || !f.prefillCapable) return [];
  const v = f.answer == null ? '' : String(f.answer).trim();
  if (!v) return [];
  const key = 'entry.' + f.entryId;
  if (f.kind === 'date') {
    let y, mo, d;
    let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
      if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    }
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return [];
    return [[key + '_year', String(y)], [key + '_month', String(mo)], [key + '_day', String(d)]];
  }
  if (f.kind === 'time') {
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return [];
    return [[key + '_hour', String(+m[1])], [key + '_minute', String(+m[2])]];
  }
  if (f.kind === 'checkbox') {
    const opts = Array.isArray(f.options) ? f.options : [];
    const vals = v.split(/\s*[,،\n]\s*/).map((x) => x.trim()).filter(Boolean);
    const pairs = [];
    const other = [];
    for (const val of vals) {
      if (!opts.length || opts.includes(val)) pairs.push([key, val]);
      else other.push(val);
    }
    if (other.length) {
      pairs.push([key, '__other_option__']);
      pairs.push([key + '.other_option_response', other.join(', ')]);
    }
    return pairs;
  }
  if (f.kind === 'choice') {
    const opts = Array.isArray(f.options) ? f.options : [];
    if (opts.length && !opts.includes(v)) {
      // Radio questions accept Google's "Other" response; dropdowns
      // and scales do not — those stay for the student to pick.
      if (f.gType === 2) return [[key, '__other_option__'], [key + '.other_option_response', v]];
      return [];
    }
    return [[key, v]];
  }
  return [[key, v]];
}

function buildGooglePrefillUrl(base, fields) {
  if (!base) return null;
  const pairs = [['usp', 'pp_url']];
  for (const f of fields || []) pairs.push(...googlePrefillParams(f));
  if (pairs.length === 1) return null; // nothing can travel — no fake prefill
  return base + '?' + pairs.map(([k, val]) => encodeURIComponent(k) + '=' + encodeURIComponent(val)).join('&');
}

/* Generic HTML forms: labels + controls in document order. */
function extractGenericFormFields(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const labelsByFor = {};
  let m;
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  while ((m = labelRe.exec(cleaned))) {
    const forM = m[1].match(/for\s*=\s*["']([^"']+)["']/i);
    const txt = htmlText(m[2]);
    if (forM && txt) labelsByFor[forM[1]] = txt;
  }
  // Document spans covered by a <form>…</form> (for the real-form
  // preference rule below).
  const formSpans = [];
  {
    const formRe = /<form\b[^>]*>|<\/form\s*>/gi;
    let fm, openAt = -1;
    while ((fm = formRe.exec(cleaned))) {
      if (fm[0].charAt(1) === '/') { if (openAt >= 0) { formSpans.push([openAt, fm.index]); openAt = -1; } }
      else if (openAt < 0) openAt = fm.index;
    }
    if (openAt >= 0) formSpans.push([openAt, cleaned.length]);
  }
  const fields = [];
  const ctrlRe = /<(input|textarea|select)\b([^>]*)>/gi;
  while ((m = ctrlRe.exec(cleaned))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const attr = (name) => {
      const am = attrs.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
      return am ? am[1].trim() : '';
    };
    const type = attr('type').toLowerCase() || (tag === 'input' ? 'text' : tag);
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    /* Extraction hygiene (Mufti, 2026-10-31): page CHROME is not form
       content. A site «Search» box was once extracted and the ask loop
       demanded «خانہ «Search» کے لیے معلومات لکھیں». Rules:
         – type=search inputs are chrome, always.
         – a field whose label/name/placeholder mentions search/تلاش or
           a newsletter/subscribe box is chrome.
         – real-form preference (applied after collection): when some
           <form> holds ≥3 fillable fields, fields OUTSIDE any <form>
           are dropped; formless pages keep everything. Login pages
           (tiny sets) are unaffected — they are handled by loginFirst,
           never by the fill loop. */
    if (type === 'search') continue;
    const id = attr('id');
    let label = (id && labelsByFor[id]) || attr('placeholder') || attr('aria-label') || attr('name') || '';
    if (!label) {
      // Wrapping <label>…<input></label>: look backwards for an open label.
      const before = cleaned.slice(Math.max(0, m.index - 400), m.index);
      const open = before.lastIndexOf('<label');
      if (open >= 0 && before.indexOf('</label>', open) < 0) label = htmlText(before.slice(open));
    }
    label = htmlText(label).slice(0, 200);
    if (!label) continue;
    const chromeProbe = `${label} ${attr('name')} ${attr('placeholder')} ${attr('aria-label')}`;
    if (/search|تلاش|newsletter|subscribe/i.test(chromeProbe)) continue;
    const inForm = formSpans.some(([a, b]) => m.index > a && m.index < b);
    fields.push({ label, kind: inferKind(type, label), _f: inForm ? 1 : 0, _pos: m.index });
    if (fields.length >= MAX_FORM_FIELDS) break;
  }
  // Dedup consecutive identical labels (radio groups share one question).
  const deduped = fields.filter((f, i) => i === 0 || f.label !== fields[i - 1].label);
  // Real-form preference: the largest single <form>'s field count.
  let maxInOneForm = 0;
  for (const [a, b] of formSpans) {
    const c = deduped.filter((f) => f._pos > a && f._pos < b).length;
    if (c > maxInOneForm) maxInOneForm = c;
  }
  const kept = maxInOneForm >= 3 ? deduped.filter((f) => f._f === 1) : deduped;
  return kept.map(({ label, kind }) => ({ label, kind }));
}

/* Login-page recognition (Mufti, 2026-10-31): the AIOU link students
   open is the portal's LOGIN page — its «fields» are just user id +
   password. Such a page is not a fillable form: the session must lead
   with the login step (door attached), never present credential fields
   as fillable. Signal: a password-type (or password-labelled) field in
   a TINY field set — a long application form that happens to include
   an account-password field is not a login page. */
function isPasswordField(f) {
  return !!f && (f.kind === 'password' || /password|پاس ورڈ/i.test(String(f.label || '')));
}
function detectLoginPage(fields) {
  const fs = fields || [];
  if (!fs.length || fs.length > 5) return false;
  return fs.some(isPasswordField);
}

function extractFormFields(html) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = htmlText(titleM ? titleM[1] : (h1M ? h1M[1] : '')).slice(0, 200);
  let fields = extractGoogleFormFields(html);
  const provider = fields.length ? 'google' : 'generic';
  if (!fields.length) fields = extractGenericFormFields(html);
  return { title, fields: fields.slice(0, MAX_FORM_FIELDS), provider };
}

/* The student's own basics — top-level record fields first, then the
   profile object (the app stores them in both places across eras). */
function formProfile(user) {
  const u = user || {};
  const p = u.profile && typeof u.profile === 'object' ? u.profile : {};
  const pick = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
  };
  const prof = {
    name: pick(u.name, p.name),
    email: pick(u.email),
    mobile: pick(u.mobile, p.mobile, p.whatsapp, u.whatsapp),
    whatsapp: pick(p.whatsapp, u.whatsapp, u.mobile, p.mobile),
    degree: pick(u.degree, p.degree),
    dept: pick(u.dept, p.dept),
    madrasa: pick(u.madrasa, p.madrasa),
    university: pick(u.uni, p.uni, p.university),
    country: pick(u.country, p.country),
    admissionRoute: pick(u.admissionRoute, p.admissionRoute),
    linkedin: pick(p.linkedin, u.linkedin),
    scholar: pick(p.scholar, u.scholar),
    cnic: pick(p.cnic, u.cnic),
    fatherName: pick(p.fatherName, u.fatherName),
    dob: pick(p.dob, p.dateOfBirth, u.dob),
    address: pick(p.address, u.address),
    semester: pick(p.semester, u.semester),
    roll: pick(p.rollNumber, p.roll, u.rollNumber),
  };
  for (const k of Object.keys(prof)) if (!prof[k]) delete prof[k];
  return prof;
}

/* Rule-based field → profile mapping. Order matters: specific
   patterns (father, CNIC, WhatsApp) run before generic ones (name,
   phone, university). A field with no confident rule — or whose
   profile value is absent — stays null. NEVER invent a value. */
const FORM_RULES = [
  [/cnic|شناختی کارڈ|national id/i, 'cnic'],
  [/father|والد/i, 'fatherName'],
  [/date of birth|dob|تاریخ پیدائش|پیدائش/i, 'dob'],
  [/e-?mail|ای میل/i, 'email'],
  [/whats ?app|واٹس ایپ/i, 'whatsapp'],
  [/linkedin|لنکڈن/i, 'linkedin'],
  [/google scholar|scholar profile|سکالر/i, 'scholar'],
  [/mobile|phone|contact|موبائل|رابطہ|فون/i, 'mobile'],
  [/address|پتہ|رہائش/i, 'address'],
  [/country|ملک/i, 'country'],
  [/madrasa|مدرسہ|مدرسے/i, 'madrasa'],
  [/semester|سمسٹر/i, 'semester'],
  [/roll|رول نمبر/i, 'roll'],
  [/department|شعبہ|discipline|field of study/i, 'dept'],
  [/degree|ڈگری|program|پروگرام/i, 'degree'],
  [/universit|یونیورسٹی|institution|ادارے کا نام/i, 'university'],
  [/admission route|داخلے کا راستہ/i, 'admissionRoute'],
  [/full name|your name|name|نام/i, 'name'],
];

function mapFieldsRule(fields, profile) {
  return (fields || []).map((f) => {
    // Spread keeps extraction metadata (Google entryId/gType/options/
    // prefillCapable) attached to the mapped field — Part 7 needs it.
    if (f.kind === 'file') return { ...f, answer: null, source: null };
    if (isPasswordField(f)) return { ...f, kind: 'password', answer: null, source: null }; // credentials are NEVER mapped or filled
    const label = String(f.label || '');
    for (const [re, key] of FORM_RULES) {
      if (re.test(label)) {
        const v = profile[key];
        return { ...f, answer: v ? v : null, source: v ? 'profile' : null };
      }
    }
    return { ...f, answer: null, source: null };
  });
}

/* AI refinement for fields the rules could not answer — ONLY when a
   Gemini key exists, and mechanically honesty-checked: an answer is
   accepted solely if it is a VERBATIM value from the student's
   profile or a verbatim phrase from the student's own note. Anything
   else the model returns is discarded and the field stays null. */
async function refineWithAi(mapped, profile, note, apiKey) {
  if (!apiKey) return mapped;
  const open = mapped.filter((f) => f.answer == null && f.kind !== 'file' && f.kind !== 'password');
  if (!open.length) return mapped;
  const prompt = [
    'You match online-form fields to a student\'s own data. STRICT RULES:',
    '- Answer a field ONLY by copying a value VERBATIM from the PROFILE values below, or a phrase VERBATIM from the student NOTE below.',
    '- If neither contains the answer, return null for that field. NEVER invent, guess, reformat or combine values.',
    'Respond with ONLY a JSON array [{"label": "...", "answer": "..." or null}] for exactly the FIELDS listed.',
    '',
    'PROFILE (JSON): ' + JSON.stringify(profile),
    'NOTE: ' + (note || '(none)'),
    'FIELDS: ' + JSON.stringify(open.map((f) => f.label)),
  ].join('\n');
  const ans = await callGemini(apiKey, [{ text: prompt }], { maxOutputTokens: 900, temperature: 0.1 });
  const parsed = looseJson(ans, '[', ']');
  if (!Array.isArray(parsed)) return mapped;
  const profileValues = new Set(Object.values(profile));
  const byLabel = new Map(parsed.filter((x) => x && typeof x.label === 'string').map((x) => [x.label, x.answer]));
  return mapped.map((f) => {
    if (f.answer != null || !byLabel.has(f.label)) return f;
    const a = byLabel.get(f.label);
    if (typeof a !== 'string' || !a.trim() || a.length > 300) return f;
    const v = a.trim();
    if (profileValues.has(v)) return { ...f, answer: v, source: 'profile' };
    if (note && note.includes(v)) return { ...f, answer: v, source: 'note' };
    return f;
  });
}

router.post('/formfill', requireAuth, formfillLimiter, async (req, res) => {
  const body = req.body || {};
  const link = absStr(body.link, 1000);
  const note = absStr(body.note, 1000);
  const img = parseAttachment(body.imageBase64, 'image');
  if (img === 'bad') {
    return fail(res, 400, 'bad_attachment', 'منسلک تصویر درست نہیں — دوبارہ لگا کر بھیجیں');
  }
  if (!link && !img) {
    return fail(res, 400, 'formfill_needs_input', 'فارم کا لنک یا اس کا اسکرین شاٹ — دونوں میں سے ایک درکار ہے');
  }
  if (img && decodedBytes(img.data) > MAX_ATTACHMENT_BYTES) {
    return fail(res, 413, 'payload_too_large', 'منسلک تصویر بہت بڑی ہے — سائز 4 MB سے کم رکھیں');
  }

  let formTitle = '';
  let fields = null;
  let embeddable = null; // link path only: can the page be framed in-app?
  let provider = null; // 'google' | 'generic' (link path)
  let formBaseUrl = null; // Google only: canonical /viewform base
  let prefillAvailable = false;
  if (link) {
    if (!formUrlAllowed(link)) {
      return fail(res, 400, 'bad_link', 'یہ لنک درست نہیں — مکمل آفیشل لنک (https…) لکھیں، یا فارم کا اسکرین شاٹ بھیجیں');
    }
    const page = await fetchFormPage(link);
    if (!page) {
      return fail(res, 422, 'form_unreachable', 'فارم کا صفحہ کھل نہیں سکا — فارم کا اسکرین شاٹ اپ لوڈ کر کے کوشش کریں');
    }
    embeddable = frameEmbeddable(page.headers);
    const ex = extractFormFields(page.html);
    formTitle = ex.title;
    fields = ex.fields;
    provider = ex.provider;
    if (provider === 'google') {
      // page.finalUrl already followed any forms.gle redirect.
      formBaseUrl = googleFormBaseUrl(page.finalUrl || link);
      prefillAvailable = !!(formBaseUrl && fields.some((f) => f.entryId != null && f.prefillCapable));
    }
    if (!fields.length) {
      return fail(res, 422, 'form_fields_not_found', 'اس صفحے پر فارم کے خانے نہیں مل سکے — فارم کا اسکرین شاٹ اپ لوڈ کر کے کوشش کریں');
    }
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return fail(res, 501, 'ai_not_configured', 'AI مدد ابھی فعال نہیں ہے — فی الحال فارم کا لنک استعمال کریں');
    }
    const prompt = [
      'Look at this screenshot of an online form. List the form\'s fields IN ORDER, exactly as they appear.',
      'Respond with ONLY a JSON object {"title": "the form/page title if visible, else empty string", "fields": [{"label": "field label/question text", "kind": "text|paragraph|choice|date|email|phone|number|file"}]}. Use kind "file" for document/photo upload fields. No prose outside the JSON.',
    ].join('\n');
    const parts = [{ text: prompt }, { inline_data: { mime_type: img.mime, data: img.data } }];
    const ans = await callGemini(apiKey, parts, { maxOutputTokens: 1400, temperature: 0.1 });
    if (!ans) {
      return fail(res, 502, 'ai_upstream', 'جواب حاصل نہیں ہو سکا — چند لمحے بعد دوبارہ کوشش کریں');
    }
    const parsed = looseJson(ans, '{', '}');
    const rawFields = parsed && Array.isArray(parsed.fields) ? parsed.fields : [];
    fields = rawFields
      .filter((f) => f && typeof f.label === 'string' && f.label.trim())
      .slice(0, MAX_FORM_FIELDS)
      .map((f) => ({ label: f.label.trim().slice(0, 200), kind: typeof f.kind === 'string' ? f.kind : 'text' }));
    formTitle = parsed && typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
    if (!fields.length) {
      return fail(res, 422, 'form_fields_not_found', 'اسکرین شاٹ میں فارم کے خانے واضح نہیں پڑھے جا سکے — صاف اور قریب سے لیا ہوا اسکرین شاٹ بھیجیں');
    }
  }

  /* Login page? Then there is no answer sheet to build — the session
     leads with the login step; the portal's own credential fields are
     never returned as fillable fields. */
  if (detectLoginPage(fields)) {
    return res.json({ ok: true, formTitle, fields: [], embeddable, loginFirst: true, provider, formBaseUrl, prefillAvailable: false, prefillUrl: null });
  }

  const profile = formProfile(req.user);
  let mapped = mapFieldsRule(fields, profile);
  mapped = await refineWithAi(mapped, profile, note, process.env.GEMINI_API_KEY);
  const prefillUrl = prefillAvailable ? buildGooglePrefillUrl(formBaseUrl, mapped) : null;
  return res.json({ ok: true, formTitle, fields: mapped, embeddable, loginFirst: false, provider, formBaseUrl, prefillAvailable, prefillUrl });
});

router._test = { extractFormFields, extractGoogleFormFields, extractGenericFormFields, mapFieldsRule, formProfile, formUrlAllowed, frameEmbeddable, detectLoginPage, isPasswordField, googleFormBaseUrl, googlePrefillParams, buildGooglePrefillUrl };

module.exports = router;
