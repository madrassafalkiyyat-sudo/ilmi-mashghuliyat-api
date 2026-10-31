'use strict';
// End-to-end test of the website's api-bridge.js against this API.
// The bridge runs in a vm sandbox with minimal browser stand-ins
// (window, localStorage, document, location); fetch is the real one.
// The core guarantee under test: in lite mode the snapshots handed to
// the UI are IDENTICAL to what the classic full requests produce, while
// images are downloaded once and then served from the signature cache.
//
// The bridge lives in the website repo. Default location is the sibling
// checkout (../ilmi-mashghuliyat/api-bridge.js); override with BRIDGE_PATH.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MongoMemoryServer } = require('mongodb-memory-server');

const BRIDGE_PATH = process.env.BRIDGE_PATH
  || path.join(__dirname, '..', '..', 'ilmi-mashghuliyat', 'api-bridge.js');
const HAVE_BRIDGE = fs.existsSync(BRIDGE_PATH);
const skip = HAVE_BRIDGE ? false : `api-bridge.js not found at ${BRIDGE_PATH}`;

const PHOTO = 'data:image/jpeg;base64,' + 'P'.repeat(40000);
const ADMIN_PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(20000);
const POSTER = 'data:image/jpeg;base64,' + 'S'.repeat(80000);
const POSTER2 = 'data:image/jpeg;base64,' + 'T'.repeat(70000);

let mongod;
let server;
let BASE;

before(async () => {
  if (!HAVE_BRIDGE) return;
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt';
  process.env.AUTH_RATE_MAX = '1000';
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const d = await db();
  const hash = await require('../src/auth').hashPassword('password123');
  await d.collection('admins').insertOne({ _id: 'br-admin@example.com' });
  await d.collection('users').insertMany([
    { _id: 'br-admin', uid: 'br-admin', email: 'br-admin@example.com', name: 'Admin', status: 'approved', role: 'student',
      profile: { photo: ADMIN_PHOTO }, passwordHash: hash, refreshTokens: [] },
    { _id: 'br-s1', uid: 'br-s1', email: 'br-s1@example.com', name: 'Student', status: 'approved', role: 'student',
      profile: { photo: PHOTO, gender: 'مرد', city: 'Karachi' }, passwordHash: hash, refreshTokens: [] },
    { _id: 'br-s2', uid: 'br-s2', email: 'br-s2@example.com', name: 'No Photo', status: 'pending', role: 'student',
      profile: {}, passwordHash: hash, refreshTokens: [] },
  ]);
  await d.collection('settings').insertOne({
    _id: 'session', title: 'Live', sessionDate: '2026-11-06', when: 'Fri', poster: POSTER, zoomPass: '1432',
  });
});

after(async () => {
  try { if (server) await new Promise((r) => server.close(r)); } catch (e) {}
  try { await require('../src/db').close(); } catch (e) {}
  try { if (mongod) await mongod.stop(); } catch (e) {}
});

async function db() {
  return require('../src/db').getDb();
}

// Load a fresh bridge instance (own cache, own tokens) in a sandbox.
function loadBridge(opts) {
  opts = opts || {};
  const store = new Map();
  const snapshots = {};
  const requests = [];
  const listeners = {};
  let inflight = 0;
  let lastActivity = Date.now();

  async function trackedFetch(url, init) {
    const p = String(url).replace(BASE, '');
    requests.push(p);
    inflight++;
    lastActivity = Date.now();
    try {
      if (opts.failPaths && opts.failPaths.some((f) => p.startsWith(f))) {
        return new Response(JSON.stringify({ error: { code: 'server_error', message: 'x' } }), { status: 500 });
      }
      return await fetch(url, init);
    } finally {
      inflight--;
      lastActivity = Date.now();
    }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, atob, btoa,
    fetch: trackedFetch,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { search: '', href: 'http://localhost/' },
    document: {
      hidden: false,
      getElementById: () => null,
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    },
    navigator: {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    ILMI_API_BASE: BASE,
    __applySnapshot: (k, data) => { snapshots[k] = JSON.parse(JSON.stringify(data)); },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, 'utf8'), sandbox, { filename: 'api-bridge.js' });

  async function idle() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (inflight === 0 && Date.now() - lastActivity > 250) return;
    }
    throw new Error('bridge did not go idle');
  }
  async function pollAgain() {
    for (const fn of listeners.visibilitychange || []) fn();
    await idle();
  }
  return { fb: sandbox.__fb, snapshots, requests, idle, pollAgain, stop: () => sandbox.__fb.stopSubscriptions() };
}

// The bridge's own normalisation (normDoc): _id -> id/uid when missing.
function normDoc(d) {
  const o = Object.assign({}, d);
  if (!o.id && o._id) o.id = o._id;
  if (!o.uid && o._id) o.uid = o._id;
  return o;
}

async function token(email) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  return (await r.json()).accessToken;
}

async function getFull(p, tok) {
  const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tok } });
  return r.json();
}

function countMatching(requests, prefix) {
  return requests.filter((p) => p.startsWith(prefix)).length;
}

test('student poll (lite): snapshots equal the full responses; images fetched once', { skip }, async () => {
  const b = loadBridge();
  try {
    await b.fb.signIn('br-s1@example.com', 'password123');
    await b.idle();
    const tok = await token('br-s1@example.com');
    const fullMe = await getFull('/api/users/me', tok);
    const fullSess = await getFull('/api/attendance/sessions', tok);

    assert.deepEqual(b.snapshots.users, [normDoc(fullMe.user)], 'own user doc identical, photo included');
    assert.equal(b.snapshots.users[0].profile.photo, PHOTO);
    assert.deepEqual(b.snapshots.eventSession, fullSess.liveSession, 'live session identical, poster included');
    assert.ok(b.requests.includes('/api/users/me?lite=1'));
    assert.ok(b.requests.includes('/api/attendance/sessions?lite=1'));
    assert.equal(countMatching(b.requests, '/api/users/me/photo'), 1);
    assert.equal(countMatching(b.requests, '/api/attendance/session-poster'), 1);

    const before2 = b.requests.length;
    await b.pollAgain();
    const second = b.requests.slice(before2);
    assert.equal(countMatching(second, '/api/users/me/photo'), 0, 'photo served from cache');
    assert.equal(countMatching(second, '/api/attendance/session-poster'), 0, 'poster served from cache');
    assert.equal(b.snapshots.users[0].profile.photo, PHOTO);
    assert.equal(b.snapshots.eventSession.poster, POSTER);
  } finally { b.stop(); }
});

test('student poll (lite): a changed poster is fetched again and shown', { skip }, async () => {
  const b = loadBridge();
  const d = await db();
  try {
    await b.fb.signIn('br-s1@example.com', 'password123');
    await b.idle();
    await d.collection('settings').updateOne({ _id: 'session' }, { $set: { poster: POSTER2 } });
    const before2 = b.requests.length;
    await b.pollAgain();
    assert.equal(countMatching(b.requests.slice(before2), '/api/attendance/session-poster'), 1);
    assert.equal(b.snapshots.eventSession.poster, POSTER2);
    assert.equal(b.snapshots.eventSession.posterSig, undefined);
  } finally {
    b.stop();
    await d.collection('settings').updateOne({ _id: 'session' }, { $set: { poster: POSTER } });
  }
});

test('admin poll (lite): users list and session equal the full responses; photos fetched once', { skip }, async () => {
  const b = loadBridge();
  try {
    await b.fb.signIn('br-admin@example.com', 'password123');
    await b.idle();
    const tok = await token('br-admin@example.com');
    const fullUsers = await getFull('/api/admin/users?limit=200', tok);
    const fullSess = await getFull('/api/admin/settings/session', tok);

    assert.deepEqual(b.snapshots.users, fullUsers.docs.map(normDoc), 'admin users snapshot identical');
    const s1 = b.snapshots.users.find((u) => u._id === 'br-s1');
    assert.equal(s1.profile.photo, PHOTO);
    for (const u of b.snapshots.users) assert.equal(u.profile && u.profile.photoSig, undefined);
    assert.deepEqual(b.snapshots.eventSession, fullSess.session);
    assert.ok(b.requests.includes('/api/admin/users?limit=200&lite=1'));
    assert.equal(countMatching(b.requests, '/api/admin/users/photos'), 1, 'one batched photo request');

    const before2 = b.requests.length;
    await b.pollAgain();
    const second = b.requests.slice(before2);
    assert.equal(countMatching(second, '/api/admin/users/photos'), 0);
    assert.equal(countMatching(second, '/api/attendance/session-poster'), 0);
    assert.deepEqual(b.snapshots.users, fullUsers.docs.map(normDoc));
  } finally { b.stop(); }
});

test('fallback: if the photo/poster endpoints fail, the bridge uses the classic full requests', { skip }, async () => {
  const b = loadBridge({ failPaths: ['/api/admin/users/photos', '/api/attendance/session-poster'] });
  try {
    await b.fb.signIn('br-admin@example.com', 'password123');
    await b.idle();
    const tok = await token('br-admin@example.com');
    const fullUsers = await getFull('/api/admin/users?limit=200', tok);
    assert.deepEqual(b.snapshots.users, fullUsers.docs.map(normDoc));
    assert.equal(b.snapshots.eventSession.poster, POSTER);
    assert.ok(b.requests.includes('/api/admin/users?limit=200'), 'classic users request used');
    assert.ok(b.requests.includes('/api/admin/settings/session'), 'classic session request used');
  } finally { b.stop(); }
});

test('student self-save: a stray photoSig is never sent or stored; photo kept', { skip }, async () => {
  const b = loadBridge();
  try {
    await b.fb.signIn('br-s1@example.com', 'password123');
    await b.idle();
    const me = b.snapshots.users[0];
    await b.fb.upsert('users', me.uid, { ...me, profile: { ...me.profile, photoSig: 'stray', city: 'Quetta' } });
    const d = await db();
    const stored = await d.collection('users').findOne({ _id: 'br-s1' });
    assert.equal(stored.profile.city, 'Quetta');
    assert.equal(stored.profile.photoSig, undefined);
    assert.equal(stored.profile.photo, PHOTO);
  } finally { b.stop(); }
});

test('admin session save from a polled snapshot keeps the poster', { skip }, async () => {
  const b = loadBridge();
  try {
    await b.fb.signIn('br-admin@example.com', 'password123');
    await b.idle();
    const s = b.snapshots.eventSession;
    assert.equal(s.poster, POSTER);
    await b.fb.upsert('settings', 'session', { ...s, title: 'Edited', posterSig: 'stray' });
    const d = await db();
    const stored = await d.collection('settings').findOne({ _id: 'session' });
    assert.equal(stored.title, 'Edited');
    assert.equal(stored.poster, POSTER);
    assert.equal(stored.posterSig, undefined);
  } finally { b.stop(); }
});
