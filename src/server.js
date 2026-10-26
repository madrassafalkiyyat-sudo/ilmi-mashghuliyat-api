'use strict';
// HTTP entrypoint: connects to MongoDB first, then listens.
// If the database is unreachable the process exits loudly instead of
// serving an API that answers everything with 500s.
const app = require('./app');
const config = require('./config');
const { getDb } = require('./db');

async function main() {
  await getDb();
  app.listen(config.port, () => {
    console.log(`ilmi-mashghuliyat API listening on port ${config.port}`);
    console.log(`CORS origin: ${config.corsOrigin}`);
  });
}

main().catch((err) => {
  console.error('Failed to start API:', err && err.message);
  process.exit(1);
});
