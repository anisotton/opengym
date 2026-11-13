#!/usr/bin/env node
// Blocks until the PostgreSQL behind TEST_DATABASE_URL (or DATABASE_URL) accepts a connection,
// then exits 0; exits 1 after the deadline. Exists for CI runners that start a database service
// alongside the job but don't wait for it to be ready (GitLab's `services:`), on images that
// carry no pg_isready — it uses the api's own `pg` dependency instead, so `npm ci` is enough.
//
//   node scripts/wait-for-pg.mjs            # 60 s deadline
//   node scripts/wait-for-pg.mjs 120        # custom deadline, seconds
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('wait-for-pg: neither TEST_DATABASE_URL nor DATABASE_URL is set');
  process.exit(2);
}
const deadlineMs = Number(process.argv[2] || 60) * 1000;
const started = Date.now();
let lastError = '';
while (Date.now() - started < deadlineMs) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
    console.log(`wait-for-pg: ready after ${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(0);
  } catch (e) {
    lastError = e.message;
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.error(`wait-for-pg: not ready after ${deadlineMs / 1000}s — last error: ${lastError}`);
process.exit(1);
