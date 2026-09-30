/* The `users` half of store.js (ISO-1403), tested directly against real PostgreSQL — no server.js
 * spawned, since these functions are not wired into any route yet (see the module comment in
 * store.js). One isolated database per test file, migrated the same way server.js boots. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import {
  createUser, getUserById, getAllUsers, setPassword, removePassword, setPasswordReset,
  bumpSessionVersion, setEmail, setDisabled, touchLastPull, setLastReminder, deleteUser
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
