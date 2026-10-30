'use strict';
// Environment-only configuration. No secret value may ever be written here.
// MONGO_URI and JWT_SECRET are required at runtime; the process exits
// with a clear message if they are missing, instead of starting half-open.
const REQUIRED = ['MONGO_URI', 'JWT_SECRET'];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  dbName: process.env.MONGO_DB || 'ilmi-mashghuliyat',
  port: Number(process.env.PORT || 3000),
  // The ONLY browser origin allowed to call this API: the institutional
  // GitHub Pages host. Never widen this to '*' — the API serves student
  // records and must not be callable from arbitrary websites.
  corsOrigin: process.env.CORS_ORIGIN || 'https://madrassafalkiyyat-sudo.github.io',
  jwtExpires: process.env.JWT_EXPIRES || '1h',
  // Refresh tokens are effectively PERMANENT (Mufti, 2026-10-31: a student
  // who logged in once on a device must never be asked again on that
  // device). ~10 years; revocation stays server-side via the stored
  // SHA-256 hashes (logout / rotation), not via expiry.
  refreshExpiresDays: Number(process.env.REFRESH_EXPIRES_DAYS || 3650),
  // Asia/Karachi is the canonical timezone for sessions/attendance.
  timezone: 'Asia/Karachi',
};
