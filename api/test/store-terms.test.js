import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '../db.js';
import { createUser, getUserById, setTermsAccepted } from '../store.js';
import { provisionTestDatabase } from './helpers.mjs';

async function withDb(fn) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const pool = createPool(databaseUrl);
  try { await runMigrations(pool); await fn(pool); } finally { await pool.end(); await cleanup(); }
}

test('migration 006: a user created with an acceptance reads it back', async () => {
  await withDb(async pool => {
    const at = '2026-10-17T12:00:00.000Z';
    await createUser(pool, { id: 'u_t1', name: 'T', created: at, termsAcceptedVersion: '2026-10-17', termsAcceptedAt: at });
    const u = await getUserById(pool, 'u_t1');
    assert.equal(u.termsAcceptedVersion, '2026-10-17');
    assert.equal(u.termsAcceptedAt, at);
  });
});

test('a user created without one has neither field, and setTermsAccepted fills both', async () => {
  await withDb(async pool => {
    await createUser(pool, { id: 'u_t2', name: 'T', created: new Date().toISOString() });
    const before = await getUserById(pool, 'u_t2');
    assert.ok(!('termsAcceptedVersion' in before) && !('termsAcceptedAt' in before));
    await setTermsAccepted(pool, 'u_t2', '2026-10-17', '2026-10-17T13:00:00.000Z');
    const after = await getUserById(pool, 'u_t2');
    assert.equal(after.termsAcceptedVersion, '2026-10-17');
    assert.equal(after.termsAcceptedAt, '2026-10-17T13:00:00.000Z');
  });
});
