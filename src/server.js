'use strict';
// HTTP entrypoint: connects to MongoDB first, then listens.
// If the database is unreachable the process exits loudly instead of
// serving an API that answers everything with 500s.
const app = require('./app');
const config = require('./config');
const { getDb } = require('./db');

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
  const { backfillNotifications } = require('./lib/notify');
  const tick = async () => {
    try {
      // Before the seed: older notifications get createdAt + their
      // exactly-once marker, so expiry can never trigger a re-send.
      await backfillNotifications(db);
      await course.seedCourseBatch(db);
      await course.runCourseReleases(db);
    } catch (e) {
      console.error('course tick failed:', e && e.message);
    }
  };
  tick();
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
