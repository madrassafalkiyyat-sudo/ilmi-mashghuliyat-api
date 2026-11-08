'use strict';
// Lazy MongoClient singleton. The client connects on first use and is
// reused for the life of the process (serverless hosts should keep this
// module warm; see OPEN-DECISIONS.md for host notes).
const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;
let monitorStarted = false;
let pingFails = 0;

async function getDb() {
  if (db) return db;
  // Bounded timeouts (2026-11-08): a stalled database call must fail in
  // seconds, never hang a request (or the whole process) forever.
  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 20000,
    maxPoolSize: 10,
  });
  await client.connect();
  db = client.db(config.dbName);
  await ensureIndexes(db);
  startMonitor();
  return db;
}

// Self-heal (2026-11-08): ping the database every minute; after two
// consecutive failures, drop the client so the next getDb() reconnects
// fresh instead of every request queueing behind a dead connection.
function startMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  const t = setInterval(async () => {
    if (!db) return;
    try {
      await db.command({ ping: 1 });
      pingFails = 0;
    } catch (e) {
      pingFails++;
      console.error('mongo ping failed (' + pingFails + '):', e && e.message);
      if (pingFails >= 2) {
        const c = client;
        client = null;
        db = null;
        pingFails = 0;
        if (c) c.close().catch(() => {});
        console.error('mongo client reset — next request reconnects');
      }
    }
  }, 60000);
  if (t.unref) t.unref();
}

// Indexes that enforce the app's standing rules at the database level.
async function ensureIndexes(db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ uid: 1 }, { unique: true, sparse: true });
  await db.collection('admins').createIndex({ _id: 1 });
  // Exactly-once notifications: one document per (user, notification id).
  await db.collection('notifications').createIndex({ email: 1, id: 1 }, { unique: true, sparse: true });
  // One attendance claim per student per session.
  await db.collection('attendanceClaims').createIndex({ sessionId: 1, email: 1 }, { unique: true });
  await db.collection('sessionSecrets').createIndex({ sessionId: 1 }, { unique: true });
  // Course classroom: one submission per (assignment, student); release
  // scheduling scans assignments by release time.
  await db.collection('assignmentSubmissions').createIndex({ assignmentId: 1, email: 1 }, { unique: true });
  await db.collection('assignments').createIndex({ releaseAtMs: 1 });
  await db.collection('announcements').createIndex({ expiresAt: 1 });
  await db.collection('news').createIndex({ expiresAt: 1 });
  await db.collection('jobs').createIndex({ expiresAt: 1 });
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

module.exports = { getDb, close };
