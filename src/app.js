'use strict';
// Express app wiring. No listening here (see server.js) so the app can be
// imported by tests without opening a port.
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { fail } = require('./middleware/auth');

const app = express();

// CORS: exactly one origin — the institutional GitHub Pages host.
// Credentials are NOT used (Bearer tokens instead), so a reflected origin
// can never turn this API into a confused deputy.
app.use(cors({ origin: config.corsOrigin, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] }));
// 10MB JSON limit: base64 photos/documents are ~650KB after client
// compression; 10MB leaves headroom without inviting abuse.
app.use(express.json({ limit: '10mb' }));

// Minimal request log: method, path, status, duration. Bodies, tokens
// and query strings are NEVER logged (they may carry credentials).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Health endpoint for the free-tier keep-warm pinger (see
// .github/workflows/keep-warm.yml). No auth, no data: only liveness +
// process uptime, so it is safe to curl every 10 minutes from Actions.
function healthHandler(req, res) {
  return res.json({ ok: true, uptimeMs: Math.round(process.uptime() * 1000) });
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Brute-force guard on the auth surface (login / register / re-register
// / token endpoints). 60 attempts per IP per 15 minutes is generous for
// real students and stops casual password guessing; the message stays
// generic so it reveals nothing about which accounts exist.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'too_many_requests', 'بہت زیادہ کوششیں ہو گئی ہیں — کچھ دیر بعد دوبارہ کوشش کریں'),
});
app.use('/api/auth', authLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/content', require('./routes/content'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/star', require('./routes/star'));
app.use('/api/notifications', require('./routes/notifications'));

// Unknown API route + last-resort error handler (never leak stack traces).
app.use('/api', (req, res) => fail(res, 404, 'not_found', 'یہ راستہ موجود نہیں'));
app.use((err, req, res, next) => {
  console.error('API error:', err && err.message);
  return fail(res, 500, 'server_error', 'سرور کی خرابی');
});

module.exports = app;
