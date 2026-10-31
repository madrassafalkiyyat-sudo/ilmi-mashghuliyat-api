'use strict';
// Input rules for everything a student writes about themselves. Values the
// pages later place inside HTML (photo src, names) are restricted here, so
// a crafted value is refused at the door instead of being stored and
// executed in another user's (or an admin's) browser.

const PHOTO_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const MAX_PHOTO_CHARS = 1000000;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_TEXT = 2000;
const MAX_LIST = 50;
const MAX_LIST_ITEM = 300;
const MAX_TOP_LEVEL = 200;
const MAX_OWN_DOC_BYTES = 200 * 1024;
// Characters that can end an HTML attribute or open a tag. Names, places
// and profile links never need them (apostrophes do occur and are kept).
const UNSAFE_TEXT_RE = /[<>"`]/;
// Plain mailbox characters only: emails are placed inside onclick
// handlers by the admin pages, so a quote in an address is an injection.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function isSafeText(v) {
  return typeof v === 'string' && !UNSAFE_TEXT_RE.test(v);
}

// Fields an admin sets on student submissions (transfer/competition
// decisions); a student's write may never set or overwrite them.
const ADMIN_OWNED_FIELDS = ['status', 'position', 'decidedAt', 'decidedBy', 'approvedAt', 'approvedBy'];

function isPhoto(v) {
  return typeof v === 'string' && v.length <= MAX_PHOTO_CHARS && PHOTO_RE.test(v);
}

function isSafeId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

// Returns { value } for an acceptable profile value, or { error }.
function profileValue(key, v) {
  if (key === 'photo') {
    if (v === '' || v === null) return { value: '' };
    return isPhoto(v) ? { value: v } : { error: 'bad_photo' };
  }
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return { value: v };
  if (typeof v === 'string') {
    if (v.length > MAX_TEXT) return { error: 'too_long' };
    return isSafeText(v) ? { value: v } : { error: 'unsafe_text' };
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_LIST) return { error: 'too_long' };
    if (!v.every((x) => isSafeText(x) && x.length <= MAX_LIST_ITEM)) return { error: 'bad_value' };
    return { value: v };
  }
  return { error: 'bad_value' };
}

const PROTECTED_PROFILE_KEYS = ['status', 'role', 'email', 'uid', '_id', 'passwordHash', 'photoSig'];

// profile object -> { set: {'profile.k': v} } or { error, field }.
function profileSet(profile) {
  const set = {};
  for (const [k, v] of Object.entries(profile)) {
    if (PROTECTED_PROFILE_KEYS.includes(k)) continue;
    if (!KEY_RE.test(k)) return { error: 'bad_field', field: k };
    const r = profileValue(k, v);
    if (r.error) return { error: r.error, field: k };
    set[`profile.${k}`] = r.value;
  }
  return { set };
}

function topLevelValue(v) {
  if (v === null) return { value: '' };
  if (typeof v !== 'string' || v.length > MAX_TOP_LEVEL) return { error: 'bad_value' };
  return isSafeText(v) ? { value: v } : { error: 'unsafe_text' };
}

// Student-owned submission (draft, transfer, competition entry, message):
// drops admin-owned and identity fields, refuses unsafe keys and
// oversized documents. Returns { fields } or { error }.
function ownDocFields(data) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(data)); } catch (e) { return { error: 'bad_value' }; }
  if (size > MAX_OWN_DOC_BYTES) return { error: 'too_large' };
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === '_id' || k === 'id' || k === 'email' || ADMIN_OWNED_FIELDS.includes(k)) continue;
    if (!KEY_RE.test(k)) return { error: 'bad_field', field: k };
    fields[k] = v;
  }
  return { fields };
}

module.exports = {
  PHOTO_RE, MAX_PHOTO_CHARS, ADMIN_OWNED_FIELDS, EMAIL_RE,
  isPhoto, isSafeId, isSafeText, profileSet, topLevelValue, ownDocFields,
};
