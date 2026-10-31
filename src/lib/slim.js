'use strict';
// Response slimming for the 60s polling client.
//  * stripSecrets: credential material never leaves the server, on any
//    route that returns a users doc.
//  * lite mode (?lite=1): an embedded data: URI (profile photo, session
//    poster) is replaced by a short content signature. The client keeps
//    the image cached by signature and fetches it once from the dedicated
//    endpoint only when the signature changes. Plain URLs are left as-is.
//    Without ?lite=1 the payload is byte-for-byte the old one, so cached
//    copies of the old app keep working.
const crypto = require('crypto');

const SECRET_USER_FIELDS = ['passwordHash', 'refreshTokens', 'resetTokenHash', 'loginTokenHash'];

function stripSecrets(user) {
  if (!user || typeof user !== 'object') return user;
  const out = { ...user };
  for (const k of SECRET_USER_FIELDS) delete out[k];
  return out;
}

function isDataUri(v) {
  return typeof v === 'string' && v.startsWith('data:');
}

function signature(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function isLite(req) {
  return req.query.lite === '1' || req.query.lite === 'true';
}

function slimUserPhoto(user) {
  if (!user || !user.profile || !isDataUri(user.profile.photo)) return user;
  const profile = { ...user.profile, photoSig: signature(user.profile.photo) };
  delete profile.photo;
  return { ...user, profile };
}

function slimSessionPoster(session) {
  if (!session || !isDataUri(session.poster)) return session;
  const out = { ...session, posterSig: signature(session.poster) };
  delete out.poster;
  return out;
}

module.exports = {
  SECRET_USER_FIELDS, stripSecrets, isDataUri, signature, isLite, slimUserPhoto, slimSessionPoster,
};
