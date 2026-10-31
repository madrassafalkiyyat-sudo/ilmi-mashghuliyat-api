'use strict';
// Notifications: exactly-once delivery + automatic expiry.
//  * Every notification carries createdAt (a real Date). A TTL index
//    deletes it NOTIF_TTL_DAYS after creation, read or unread.
//  * Expiry must not undo exactly-once: several writers (hourly course
//    seed, vision review, admin decisions) use deterministic ids and rely
//    on "already exists" to mean "already sent". notificationLog keeps a
//    tiny permanent marker per (email, id) so a deleted notification is
//    never re-sent.
//  * The UI shows `date` verbatim (Urdu, dd/mm/yyyy or ISO) and de-dups on
//    it, so `date` is never rewritten; createdAt is the sortable field.

const NOTIF_TTL_DAYS = Number(process.env.NOTIF_TTL_DAYS || 20);
const TTL_INDEX_NAME = 'createdAt_ttl';

const URDU_MONTHS = {
  'جنوری': 1, 'فروری': 2, 'مارچ': 3, 'اپریل': 4, 'مئی': 5, 'جون': 6,
  'جولائی': 7, 'اگست': 8, 'ستمبر': 9, 'اکتوبر': 10, 'نومبر': 11, 'دسمبر': 12,
};
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

function logKey(email, id) {
  return `${String(email).toLowerCase()}|${id}`;
}

function asciiDigits(s) {
  return String(s)
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

function karachiMidnight(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 2000)) return null;
  return new Date(Date.UTC(y, m - 1, d) - KARACHI_OFFSET_MS);
}

// Parses the three `date` shapes found in stored notifications:
// ISO ("2026-10-28T19:35:36.947Z"), "26/10/2026" (day first) and
// Urdu ("۲۴ اکتوبر ۲۰۲۶"). Returns null when unrecognised.
function parseNotifDate(value) {
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = asciiDigits(value.trim());
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return karachiMidnight(Number(m[3]), mo, d);
  }
  m = s.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (m && URDU_MONTHS[m[2]]) return karachiMidnight(Number(m[3]), URDU_MONTHS[m[2]], Number(m[1]));
  return null;
}

// Creates the notification unless it was ever sent before. `doc` needs
// email + id; the stored _id stays doc.id (unchanged from before).
// Returns true when a new notification was created.
async function notifyOnce(db, doc) {
  const email = String(doc.email).toLowerCase();
  const key = logKey(email, doc.id);
  if (await db.collection('notificationLog').findOne({ _id: key })) return false;
  const r = await db.collection('notifications').updateOne(
    { email, id: doc.id },
    { $setOnInsert: { _id: doc.id, ...doc, email, createdAt: new Date() } },
    { upsert: true }
  );
  await db.collection('notificationLog').updateOne(
    { _id: key }, { $setOnInsert: { _id: key, at: new Date() } }, { upsert: true }
  );
  return r.upsertedCount > 0;
}

async function ensureNotificationIndexes(db) {
  const coll = db.collection('notifications');
  const seconds = Math.round(NOTIF_TTL_DAYS * 86400);
  let indexes = [];
  try {
    indexes = await coll.indexes();
  } catch (e) {
    if (e.code !== 26) throw e; // NamespaceNotFound: collection not created yet
  }
  const existing = indexes.find((i) => i.name === TTL_INDEX_NAME);
  if (!existing) {
    await coll.createIndex({ createdAt: 1 }, { name: TTL_INDEX_NAME, expireAfterSeconds: seconds });
  } else if (existing.expireAfterSeconds !== seconds) {
    await db.command({ collMod: 'notifications', index: { name: TTL_INDEX_NAME, expireAfterSeconds: seconds } });
  }
  await coll.createIndex({ email: 1, createdAt: -1 });
}

// Idempotent: gives every notification without createdAt one (parsed from
// its `date`, else now) and records its exactly-once marker.
async function backfillNotifications(db) {
  const coll = db.collection('notifications');
  const docs = await coll.find({ createdAt: { $exists: false } }, { projection: { email: 1, id: 1, date: 1 } }).toArray();
  let updated = 0;
  for (const d of docs) {
    const createdAt = parseNotifDate(d.date) || new Date();
    await coll.updateOne({ _id: d._id, createdAt: { $exists: false } }, { $set: { createdAt } });
    if (d.email && d.id) {
      const key = logKey(d.email, d.id);
      await db.collection('notificationLog').updateOne(
        { _id: key }, { $setOnInsert: { _id: key, at: new Date() } }, { upsert: true }
      );
    }
    updated += 1;
  }
  return { updated };
}

module.exports = { NOTIF_TTL_DAYS, parseNotifDate, notifyOnce, ensureNotificationIndexes, backfillNotifications, logKey };
