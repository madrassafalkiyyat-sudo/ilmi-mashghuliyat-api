'use strict';
// Password hashing (bcrypt) + JWT issue/verify.
// Passwords are NEVER stored, logged, or returned. Only bcrypt hashes
// live in users.passwordHash. Refresh tokens are stored only as SHA-256
// hashes, so a database read alone cannot mint a session.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id, email: user.email, role: user.role || 'student', status: user.status || 'pending' },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { hashPassword, checkPassword, signAccessToken, hashToken, newRefreshToken, verifyAccessToken };
