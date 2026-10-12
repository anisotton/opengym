/* ISO-1479: an idle Pool client whose connection is dropped server-side (Postgres restart,
 * `pg_terminate_backend`, a managed-Postgres failover) makes node-postgres emit 'error' on the
 * Pool itself. createPool() used to return a bare `new Pool(...)` with no listener for that event
 * — an unhandled EventEmitter error, which crashes the whole Node process. In production that
 * took the API down mid passkey ceremony on every Postgres restart; a user mid-registration or
 * mid-login would see the request simply die. Needs a real PostgreSQL — see test:pg. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../db.js';
import { provisionTestDatabase } from './helpers.mjs';

test('an idle connection terminated server-side does not crash the pool (ISO-1479)', async t => {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  t.after(cleanup);

  const pool = createPool(databaseUrl);
  t.after(() => pool.end());
  assert.ok(
    pool.listenerCount('error') > 0,
    'createPool must attach an error listener, or an idle-connection drop crashes the process'
  );

  // Put a connection in the pool's idle set, then kill it from the server side — exactly what
  // "terminating connection due to administrator command" looks like.
  const client = await pool.connect();
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  client.release();

  // A separate connection does the terminating, so the kill can't land on the client issuing it.
  const admin = createPool(databaseUrl);
  t.after(() => admin.end());
  await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);

  // Give the pool a moment to receive the backend's async error for the now-dead idle client.
  await new Promise(r => setTimeout(r, 300));

  // If the process survived, the pool still serves queries (opening a fresh connection as needed).
  const result = await pool.query('SELECT 1 AS ok');
  assert.equal(result.rows[0].ok, 1);
});
