'use strict';
// Lazy MongoClient singleton. The client connects on first use and is
// reused for the life of the process (serverless hosts should keep this
// module warm; see OPEN-DECISIONS.md for host notes).
const { MongoClient } = require('mongodb');
const config = require('./config');
const { ensureNotificationIndexes } = require('./lib/notify');

let client = null;
let db = null;

async function getDb() {
  if (db) return db;
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(config.dbName);
  await ensureIndexes(db);
  return db;
}

// Indexes that enforce the app's standing rules at the database level.
async function ensureIndexes(db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ uid: 1 }, { unique: true, sparse: true });
  await db.collection('admins').createIndex({ _id: 1 });
  // /auth/refresh and /auth/logout look sessions up by token hash.
  await db.collection('users').createIndex({ 'refreshTokens.hash': 1 });
  await db.collection('admins').createIndex({ 'refreshTokens.hash': 1 });
  // Own notifications newest first + automatic expiry (see lib/notify).
  await ensureNotificationIndexes(db);
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
