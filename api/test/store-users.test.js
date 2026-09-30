/* The `users` half of store.js (ISO-1403), tested directly against real PostgreSQL — server.js's
 * own routes are covered by the server-*.test.js files that spawn it; this file is for the data
 * layer on its own, including the boot-time backfill (upsertUser/backfillPasswordResetBy) that
 * only runs once, at startup, and is easier to pin down directly than through a boot log. One
 * isolated database per test file, migrated the same way server.js boots. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import {
  createUser, getUserById, getAllUsers, setPassword, removePassword, setPasswordReset,
  bumpSessionVersion, setEmail, setDisabled, touchLastPull, setLastReminder, deleteUser,
  upsertUser, backfillPasswordResetBy
} from '../store.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  // node:test runs t.after hooks in registration order, so the pool has to close gracefully
  // before cleanup()'s pg_terminate_backend runs — the other way round, node-pg surfaces the
  // kill as a connection error on whatever pool.end() was still doing.
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}

const iso = () => new Date().toISOString();

test('createUser + getUserById: a passkey-only signup round-trips with no password fields at all', async t => {
  const pool = await withPool(t);
  const created = iso();
  await createUser(pool, { id: 'u1', name: 'Ana', created });
  const u = await getUserById(pool, 'u1');
  assert.equal(u.id, 'u1');
  assert.equal(u.name, 'Ana');
  assert.equal(u.created, created);
  assert.equal(u.admin, false);
  assert.equal(u.disabled, false);
  assert.equal(u.sv, 0);
  assert.equal('email' in u, false);
  assert.equal('pw' in u, false);
  assert.equal('pwReset' in u, false);
  assert.equal('lastPull' in u, false);
  assert.equal('lastReminder' in u, false);
});

test('createUser with a password and an e-mail carries both, in the shape hasPassword()/holdsName() expect', async t => {
  const pool = await withPool(t);
  const set = iso();
  await createUser(pool, { id: 'u1', name: 'Bo', created: iso(), email: 'bo@example.com', pw: { h: 'hash1', set } });
  const u = await getUserById(pool, 'u1');
  assert.deepEqual(u.pw, { h: 'hash1', set });
  assert.equal(u.email, 'bo@example.com');
});

// invited_by has a foreign key on invites(code), and invites have not moved to PostgreSQL yet
// (a later slice) — a real invite code from db.json cannot be referenced from a Postgres row
// today. createUser has to carry it some other way rather than violate that FK the first time a
// real invite code is used.
test('createUser with an invitedBy code that exists only in db.json does not violate the invites FK', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso(), invitedBy: 'CODE-NOT-IN-PG' });
  const u = await getUserById(pool, 'u1');
  assert.equal(u.invitedBy, 'CODE-NOT-IN-PG');
});

test('getUserById: no such user is null, not a throw', async t => {
  const pool = await withPool(t);
  assert.equal(await getUserById(pool, 'nobody'), null);
});

test('getAllUsers: every user, oldest first', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'First', created: '2026-01-01T00:00:00.000Z' });
  await createUser(pool, { id: 'u2', name: 'Second', created: '2026-01-02T00:00:00.000Z' });
  const all = await getAllUsers(pool);
  assert.deepEqual(all.map(u => u.id), ['u1', 'u2']);
});

test('setPassword replaces the record and clears any pending reset in one statement', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await setPasswordReset(pool, 'u1', { h: 'reset-hash', exp: Date.now() + 60000, by: 'u1' });
  assert.ok((await getUserById(pool, 'u1')).pwReset);

  const set = iso();
  await setPassword(pool, 'u1', { h: 'new-hash', set });
  const u = await getUserById(pool, 'u1');
  assert.deepEqual(u.pw, { h: 'new-hash', set });
  assert.equal('pwReset' in u, false, 'a fresh password and a pending reset never both stand');
});

test('removePassword drops the record; the user may still have no way in left to the caller to check', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso(), pw: { h: 'h', set: iso() } });
  await removePassword(pool, 'u1');
  assert.equal('pw' in (await getUserById(pool, 'u1')), false);
});

test('setPasswordReset drops any live password; exp round-trips as the same epoch ms', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'admin1', name: 'Admin', created: iso() });
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso(), pw: { h: 'h', set: iso() } });
  const exp = Date.now() + 24 * 3600000;
  await setPasswordReset(pool, 'u1', { h: 'reset-hash', exp, by: 'admin1' });
  const u = await getUserById(pool, 'u1');
  assert.equal('pw' in u, false);
  assert.deepEqual(u.pwReset, { h: 'reset-hash', exp, by: 'admin1' });
});

test('bumpSessionVersion returns the new value and keeps counting from there', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  assert.equal(await bumpSessionVersion(pool, 'u1'), 1);
  assert.equal(await bumpSessionVersion(pool, 'u1'), 2);
  assert.equal((await getUserById(pool, 'u1')).sv, 2);
});

test('setEmail, setDisabled, touchLastPull and setLastReminder each touch only their own field', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await setEmail(pool, 'u1', 'ana@example.com');
  await setDisabled(pool, 'u1', true);
  const pullAt = Date.now();
  await touchLastPull(pool, 'u1', pullAt);
  await setLastReminder(pool, 'u1', '2026-09-30');
  const u = await getUserById(pool, 'u1');
  assert.equal(u.email, 'ana@example.com');
  assert.equal(u.disabled, true);
  assert.equal(u.lastPull, pullAt);
  assert.equal(u.lastReminder, '2026-09-30');
  assert.equal(u.name, 'Ana', 'untouched fields are untouched');
});

test('deleteUser removes the row; a profile\'s user_state goes with it via cascade', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await pool.query("INSERT INTO user_state (user_id, state, rev) VALUES ('u1', '{}', 1)");
  await deleteUser(pool, 'u1');
  assert.equal(await getUserById(pool, 'u1'), null);
  const { rows } = await pool.query('SELECT 1 FROM user_state WHERE user_id = $1', ['u1']);
  assert.equal(rows.length, 0);
});

test('upsertUser carries every field db.json could hold, and is a no-op the second time', async t => {
  const pool = await withPool(t);
  const created = iso();
  const full = {
    id: 'u1', name: 'Ana', created, email: 'ana@example.com', admin: true, disabled: false, sv: 3,
    pw: { h: 'h1', set: iso() }, invitedBy: 'CODE1', lastPull: Date.now(), lastReminder: '2026-09-30'
  };
  await upsertUser(pool, full);
  let u = await getUserById(pool, 'u1');
  assert.equal(u.email, 'ana@example.com');
  assert.equal(u.admin, true);
  assert.equal(u.sv, 3);
  assert.deepEqual(u.pw, full.pw);
  assert.equal(u.invitedBy, 'CODE1');
  assert.equal(u.lastReminder, '2026-09-30');

  // A second boot (a restart) re-upserts the same db.json row — nothing changes.
  await upsertUser(pool, full);
  u = await getUserById(pool, 'u1');
  assert.equal(u.sv, 3, 'upsertUser overwrites with the source value, it does not increment');
});

test('upsertUser never sets password_reset_by directly — db.json users have no guaranteed order', async t => {
  const pool = await withPool(t);
  await upsertUser(pool, { id: 'u1', name: 'Ana', created: iso(), pwReset: { h: 'reset-h', exp: Date.now() + 60000, by: 'admin1' } });
  // admin1's own row does not exist yet at this point, in the boot pass this simulates.
  assert.equal((await getUserById(pool, 'u1')).pwReset.by, null);
});

test('backfillPasswordResetBy sets it once every row exists, and is a no-op without a pending reset', async t => {
  const pool = await withPool(t);
  await upsertUser(pool, { id: 'admin1', name: 'Admin', created: iso() });
  await upsertUser(pool, { id: 'u1', name: 'Ana', created: iso(), pwReset: { h: 'reset-h', exp: Date.now() + 60000, by: 'admin1' } });
  await upsertUser(pool, { id: 'u2', name: 'Bo', created: iso() }); // no pending reset

  await backfillPasswordResetBy(pool, 'u1', 'admin1');
  await backfillPasswordResetBy(pool, 'u2', 'admin1'); // nothing to attach it to

  assert.equal((await getUserById(pool, 'u1')).pwReset.by, 'admin1');
  assert.equal('pwReset' in (await getUserById(pool, 'u2')), false);
});
