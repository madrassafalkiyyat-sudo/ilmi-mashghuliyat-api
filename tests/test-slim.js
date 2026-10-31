'use strict';
// Unit tests for src/lib/slim.js (no database, no server).
const { test } = require('node:test');
const assert = require('node:assert');
const slim = require('../src/lib/slim');

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
const POSTER = 'data:image/jpeg;base64,' + 'B'.repeat(5000);

test('stripSecrets removes every credential field and keeps the rest', () => {
  const u = {
    _id: 'u1', email: 'a@example.com', name: 'A', status: 'approved', profile: { photo: PHOTO },
    passwordHash: 'x', refreshTokens: [{ hash: 'h' }], resetTokenHash: 'r', loginTokenHash: 'l',
  };
  const out = slim.stripSecrets(u);
  for (const k of slim.SECRET_USER_FIELDS) assert.equal(k in out, false, k);
  assert.deepEqual(out, { _id: 'u1', email: 'a@example.com', name: 'A', status: 'approved', profile: { photo: PHOTO } });
  assert.equal(u.passwordHash, 'x', 'input object is not mutated');
  assert.equal(slim.stripSecrets(null), null);
});

test('signature is stable, short, and changes with content', () => {
  assert.equal(slim.signature(PHOTO), slim.signature(PHOTO));
  assert.equal(slim.signature(PHOTO).length, 16);
  assert.notEqual(slim.signature(PHOTO), slim.signature(PHOTO + 'A'));
});

test('slimUserPhoto swaps a data: photo for photoSig without mutating input', () => {
  const u = { _id: 'u1', profile: { photo: PHOTO, gender: 'مرد' } };
  const out = slim.slimUserPhoto(u);
  assert.equal(out.profile.photo, undefined);
  assert.equal(out.profile.photoSig, slim.signature(PHOTO));
  assert.equal(out.profile.gender, 'مرد');
  assert.equal(u.profile.photo, PHOTO, 'input object is not mutated');
});

test('slimUserPhoto leaves URL photos, empty photos and photo-less users untouched', () => {
  const url = { _id: 'u2', profile: { photo: 'https://example.com/p.jpg' } };
  assert.equal(slim.slimUserPhoto(url), url);
  const empty = { _id: 'u3', profile: { photo: '' } };
  assert.equal(slim.slimUserPhoto(empty), empty);
  const none = { _id: 'u4' };
  assert.equal(slim.slimUserPhoto(none), none);
  assert.equal(slim.slimUserPhoto(null), null);
});

test('slimSessionPoster swaps a data: poster for posterSig, keeps every other field', () => {
  const s = { _id: 'session', title: 'T', zoomLink: 'z', poster: POSTER };
  const out = slim.slimSessionPoster(s);
  assert.deepEqual(out, { _id: 'session', title: 'T', zoomLink: 'z', posterSig: slim.signature(POSTER) });
  assert.equal(s.poster, POSTER);
  const noPoster = { title: 'T', poster: '' };
  assert.equal(slim.slimSessionPoster(noPoster), noPoster);
  assert.equal(slim.slimSessionPoster(null), null);
});

test('isLite accepts only explicit opt-in values', () => {
  assert.equal(slim.isLite({ query: { lite: '1' } }), true);
  assert.equal(slim.isLite({ query: { lite: 'true' } }), true);
  assert.equal(slim.isLite({ query: {} }), false);
  assert.equal(slim.isLite({ query: { lite: '0' } }), false);
});
