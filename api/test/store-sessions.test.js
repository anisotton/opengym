/* The `sessions` half of store.js (ISO-1403), tested directly against real PostgreSQL — no
 * server.js spawned, since these functions are not wired into any route yet. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import { createUser, createSession, getSession, revokeSession } from '../store.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  // node:test runs t.after hooks in registration order — the pool has to close before cleanup()'s
  // pg_terminate_backend runs, or node-pg surfaces the kill as a connection error.
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}

test('createSession + getSession: a fresh row is not revoked', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: new Date().toISOString() });
  const id = await createSession(pool, { userId: 'u1', expiresAt: Date.now() + 86400000, userAgent: 'test-agent' });
  assert.ok(id);
  const s = await getSession(pool, id);
  assert.deepEqual(s, { userId: 'u1', revoked: false });
});

test('getSession: an id that was never a session is null', async t => {
  const pool = await withPool(t);
  assert.equal(await getSession(pool, '00000000-0000-0000-0000-000000000000'), null);
});

test('revokeSession marks it revoked; revoking twice is a no-op, not an error', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: new Date().toISOString() });
  const id = await createSession(pool, { userId: 'u1', expiresAt: Date.now() + 86400000 });
  await revokeSession(pool, id);
  assert.equal((await getSession(pool, id)).revoked, true);
  await revokeSession(pool, id); // already revoked — still fine
  assert.equal((await getSession(pool, id)).revoked, true);
});

test('createSession: a user_agent over 300 characters is truncated, not refused', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: new Date().toISOString() });
  const id = await createSession(pool, { userId: 'u1', expiresAt: Date.now() + 86400000, userAgent: 'x'.repeat(500) });
  const { rows } = await pool.query('SELECT user_agent FROM sessions WHERE id = $1', [id]);
  assert.equal(rows[0].user_agent.length, 300);
});

test('createSession: no user_agent at all is fine', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: new Date().toISOString() });
  const id = await createSession(pool, { userId: 'u1', expiresAt: Date.now() + 86400000 });
  const { rows } = await pool.query('SELECT user_agent FROM sessions WHERE id = $1', [id]);
  assert.equal(rows[0].user_agent, null);
});

test('deleting the user cascades to their sessions', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: new Date().toISOString() });
  const id = await createSession(pool, { userId: 'u1', expiresAt: Date.now() + 86400000 });
  await pool.query('DELETE FROM users WHERE id = $1', ['u1']);
  assert.equal(await getSession(pool, id), null);
});
