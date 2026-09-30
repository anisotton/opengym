/* api/scripts/import-json.js (ISO-1404): db.json + state-<uid>.json → PostgreSQL. Needs a real
 * PostgreSQL — provisionTestDatabase() (helpers.mjs) throws a clear error without
 * TEST_DATABASE_URL, run this through `npm run test:pg`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations } from '../db.js';
import { provisionTestDatabase } from './helpers.mjs';
import { runImport, readJsonDb, readStateFiles, formatReport } from '../scripts/import-json.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-json');

function copyFixtureDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-import-json-'));
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  return dir;
}

async function withDb(fn) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const pool = createPool(databaseUrl);
  try {
    await runMigrations(pool);
    await fn(pool);
  } finally {
    await pool.end();
    await cleanup();
  }
}

async function withClient(pool, fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function committedImport(pool, dataDir, opts) {
  return withClient(pool, async client => {
    await client.query('BEGIN');
    const counters = await runImport(client, dataDir, opts);
    await client.query('COMMIT');
    return counters;
  });
}

test('readJsonDb defaults every array when db.json is missing or partial', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-import-json-empty-'));
  const db = readJsonDb(dir);
  assert.deepEqual(db, { users: [], creds: [], subs: [], invites: [], deviceLinks: [] });
});

test('readStateFiles finds every state-*.json and reports parse failures without throwing', () => {
  const dataDir = copyFixtureDataDir();
  const files = readStateFiles(dataDir);
  const byUid = Object.fromEntries(files.map(f => [f.uid, f]));
  assert.equal(files.length, 3);
  assert.equal(byUid['u-admin'].data._rev, 3);
  assert.ok(byUid['u-member'].parseError, 'invalid JSON is reported, not thrown');
});

test('imports every field of the fixture db.json and state files, skipping invalid/orphan records', async () => {
  await withDb(async pool => {
    const dataDir = copyFixtureDataDir();
    const counters = await committedImport(pool, dataDir);

    assert.deepEqual(counters.users, { read: 3, inserted: 2, updated: 0, skipped: 1 });
    // INVITE1 and the dangling one (bad createdBy, but the invite itself is still valid) both
    // insert; only the one missing `code` is skipped.
    assert.deepEqual(counters.invites, { read: 3, inserted: 2, updated: 0, skipped: 1 });
    assert.deepEqual(counters.passkeys, { read: 3, inserted: 1, updated: 0, skipped: 2 });
    assert.deepEqual(counters.push_subscriptions, { read: 2, inserted: 1, updated: 0, skipped: 1 });
    assert.deepEqual(counters.device_links, { read: 2, inserted: 1, updated: 0, skipped: 1 });
    assert.deepEqual(counters.user_state, { read: 3, inserted: 1, updated: 0, skipped: 2 });

    const admin = (await pool.query('SELECT * FROM users WHERE id = $1', ['u-admin'])).rows[0];
    assert.equal(admin.name, 'Admin');
    assert.equal(admin.email, 'admin@example.com');
    assert.equal(admin.admin, true);
    assert.equal(admin.password_hash, 'hash-admin');
    assert.ok(admin.password_set_at);
    assert.equal(Number(admin.last_pull_at ? new Date(admin.last_pull_at).getTime() : null), 1767225600000);

    const member = (await pool.query('SELECT * FROM users WHERE id = $1', ['u-member'])).rows[0];
    assert.equal(member.invited_by, 'INVITE1', 'backfilled once the invite existed');
    assert.equal(member.password_reset_hash, 'reset-hash');
    assert.equal(member.password_reset_by, 'u-admin', 'backfilled once the referenced user existed');
    assert.equal(Number(new Date(member.password_reset_expires_at).getTime()), 1893456000000);

    const dangling = (await pool.query("SELECT created_by FROM invites WHERE code = 'INVITE-DANGLING'")).rows[0];
    assert.equal(dangling.created_by, null, 'a reference to a user that was never imported is dropped, not fatal');

    const cred = (await pool.query('SELECT * FROM passkeys WHERE id = $1', ['cred-1'])).rows[0];
    assert.equal(cred.user_id, 'u-admin');
    assert.deepEqual(cred.transports, ['internal', 'hybrid']);
    assert.equal(Number(cred.counter), 4);

    const sub = (await pool.query('SELECT * FROM push_subscriptions WHERE endpoint = $1', ['https://push.example/ep-1'])).rows[0];
    assert.equal(sub.p256dh, 'p256dh-1');
    assert.equal(sub.device_id, 'device-1');

    const link = (await pool.query('SELECT * FROM device_links WHERE hash = $1', ['linkhash-1'])).rows[0];
    assert.equal(link.user_id, 'u-admin');

    const state = (await pool.query('SELECT * FROM user_state WHERE user_id = $1', ['u-admin'])).rows[0];
    assert.equal(Number(state.rev), 3);
    assert.equal(state.state._rev, 3);
    assert.equal(state.state.unit, 'kg');

    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM user_state')).rows[0].count, '1');
  });
});

test('running the import twice is a no-op the second time (idempotent upserts, unchanged user_state)', async () => {
  await withDb(async pool => {
    const dataDir = copyFixtureDataDir();
    const first = await committedImport(pool, dataDir);
    assert.equal(first.users.inserted, 2);

    const second = await committedImport(pool, dataDir);
    assert.deepEqual(second.users, { read: 3, inserted: 0, updated: 2, skipped: 1 });
    assert.deepEqual(second.invites, { read: 3, inserted: 0, updated: 2, skipped: 1 });
    assert.deepEqual(second.passkeys, { read: 3, inserted: 0, updated: 1, skipped: 2 });
    assert.deepEqual(second.push_subscriptions, { read: 2, inserted: 0, updated: 1, skipped: 1 });
    assert.deepEqual(second.device_links, { read: 2, inserted: 0, updated: 1, skipped: 1 });
    // Same _rev as the row already in the database: not a newer revision, so left untouched.
    assert.deepEqual(second.user_state, { read: 3, inserted: 0, updated: 0, skipped: 3 });

    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM passkeys')).rows[0].count, '1');
  });
});

test('user_state only replaces the stored row when the file rev is greater, never a lower or equal one', async () => {
  await withDb(async pool => {
    const dataDir = copyFixtureDataDir();
    await committedImport(pool, dataDir);
    let row = (await pool.query('SELECT rev, state FROM user_state WHERE user_id = $1', ['u-admin'])).rows[0];
    assert.equal(Number(row.rev), 3);

    // A newer file (higher _rev) replaces the stored row.
    fs.writeFileSync(path.join(dataDir, 'state-u-admin.json'), JSON.stringify({ _rev: 5, unit: 'lb' }));
    let counters = await committedImport(pool, dataDir);
    assert.equal(counters.user_state.updated, 1);
    row = (await pool.query('SELECT rev, state FROM user_state WHERE user_id = $1', ['u-admin'])).rows[0];
    assert.equal(Number(row.rev), 5);
    assert.equal(row.state.unit, 'lb');

    // An older file (lower _rev than what's already stored) must not overwrite newer data —
    // e.g. the API itself wrote rev 5 after this JSON snapshot was taken.
    fs.writeFileSync(path.join(dataDir, 'state-u-admin.json'), JSON.stringify({ _rev: 1, unit: 'stale' }));
    counters = await committedImport(pool, dataDir);
    assert.equal(counters.user_state.skipped >= 1, true);
    row = (await pool.query('SELECT rev, state FROM user_state WHERE user_id = $1', ['u-admin'])).rows[0];
    assert.equal(Number(row.rev), 5, 'still the newer revision, not clobbered');
    assert.equal(row.state.unit, 'lb');
  });
});

test('--dry-run (rollback instead of commit) leaves the database untouched but reports real counts', async () => {
  await withDb(async pool => {
    const dataDir = copyFixtureDataDir();
    const counters = await withClient(pool, async client => {
      await client.query('BEGIN');
      const c = await runImport(client, dataDir);
      await client.query('ROLLBACK');
      return c;
    });
    assert.equal(counters.users.inserted, 2);
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) FROM user_state')).rows[0].count, '0');
  });
});

test('formatReport renders a row per table with read/inserted/updated/skipped columns', () => {
  const report = formatReport({ users: { read: 3, inserted: 2, updated: 0, skipped: 1 } }, { dryRun: true });
  assert.match(report, /--dry-run/);
  assert.match(report, /users/);
  assert.match(report, /read\s+inserted\s+updated\s+skipped/);
});
