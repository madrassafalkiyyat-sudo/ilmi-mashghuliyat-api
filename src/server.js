'use strict';
// HTTP entrypoint: connects to MongoDB first, then listens.
// If the database is unreachable the process exits loudly instead of
// serving an API that answers everything with 500s.
const app = require('./app');
const config = require('./config');
const { getDb } = require('./db');

// Availability guards (2026-11-08): a stray async error anywhere in route
// code must never take the whole API down. Node's default is to EXIT on an
// unhandled rejection, which turned single bad requests into full outages
// (the app then fell back to offline demo mode for everyone). Log and live.
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection (kept alive):', e && e.message);
});
process.on('uncaughtException', (e) => {
  console.error('uncaughtException (kept alive):', e && e.message);
});

async function main() {
  const db = await getDb();
  app.listen(config.port, () => {
    console.log(`ilmi-mashghuliyat API listening on port ${config.port}`);
    console.log(`CORS origin: ${config.corsOrigin}`);
  });
  // Idara Sazi course: seed batch 1 (sessions, codes, targeted launch
  // announcement) and run the auto-release engine — at boot, then hourly.
  // Everything is deterministic-id upserts, so restarts and repeats are
  // no-ops; Render's free-tier sleep can only delay a release to the same
  // day, and the boot run catches up immediately on wake.
  const course = require('./lib/course');
  const deadlineAnnounce = require('./lib/deadlineAnnounce');
  // Overlap guard (2026-11-08): if one tick's database work ever stalls,
  // later hourly ticks must SKIP instead of piling more pending operations
  // onto the same process until it suffocates.
  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) { console.error('course tick skipped — previous tick still running'); return; }
    tickRunning = true;
    try {
      try {
        await course.seedCourseBatch(db);
        await course.runCourseReleases(db);
      } catch (e) {
        console.error('course tick failed:', e && e.message);
      }
      // «⏰ آخری موقع» deadline announcements (Mufti, 2026-11-03): one
      // effective pass per Karachi date inside this same tick family;
      // deterministic upserts make repeats no-ops.
      try {
        await deadlineAnnounce.runDeadlineAnnouncements(db);
      } catch (e) {
        console.error('deadline-announce tick failed:', e && e.message);
      }
    } finally {
      tickRunning = false;
    }
  };
  // First tick a few seconds after listen, so the API answers health and
  // login requests before any maintenance work starts.
  setTimeout(tick, 10000);
  const timer = setInterval(tick, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  // Vision self-heal (one-shot at boot, idempotent): students whose
  // vision summary reached the server without a verdict (the verdict
  // used to be Firestore-automation-only) get it applied now, and a
  // name that only exists under profile.* is lifted to top level.
  // Records that already have a verdict or a name are never touched.
  const vision = require('./lib/vision');
  vision.healVisionRecords(db).catch((e) => {
    console.error('vision heal failed:', e && e.message);
  });
}

main().catch((err) => {
  console.error('Failed to start API:', err && err.message);
  process.exit(1);
});
