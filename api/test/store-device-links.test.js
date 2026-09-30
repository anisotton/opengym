/* The `device_links` half of store.js (ISO-1403), tested directly against real PostgreSQL — no
 * server.js spawned. The routes around it are in server-passkeys.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import { createUser, createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks } from '../store.js';
import { makeLinkCode, hashLinkCode, DEVICE_LINK_TTL_MS } from '../device-link.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();

test('createDeviceLink: issues a code bound to the user, with an expiry, and keeps only its hash', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const before = Date.now();
  const { code, link } = await createDeviceLink(pool, 'user-a', 10 * 60 * 1000);
  assert.equal(link.userId, 'user-a');
  assert.ok(link.exp >= before + 10 * 60 * 1000 && link.exp <= Date.now() + 10 * 60 * 1000);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(link.h, hashLinkCode(code));
  const { rows } = await pool.query('SELECT * FROM device_links');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, hashLinkCode(code));
  // Nowhere in what is stored does the code itself appear.
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(code.replace(/-/g, '')));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(code));
});

test('createDeviceLink: lasts ten minutes unless told otherwise', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const before = Date.now();
  const { link } = await createDeviceLink(pool, 'user-a');
  assert.ok(link.exp >= before + DEVICE_LINK_TTL_MS && link.exp <= Date.now() + DEVICE_LINK_TTL_MS);
  assert.equal(DEVICE_LINK_TTL_MS, 10 * 60 * 1000);
});

test('createDeviceLink: replaces any unused link for the same user, leaves another user’s alone', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'user-b', name: 'Bea', created: iso() });
  const first = await createDeviceLink(pool, 'user-a', 60000);
  await createDeviceLink(pool, 'user-b', 60000);
  const second = await createDeviceLink(pool, 'user-a', 60000);
  const { rows } = await pool.query('SELECT user_id FROM device_links');
  assert.equal(rows.length, 2, 'one per user, not three');
  assert.equal(await findDeviceLink(pool, first.code), null);
  assert.ok(await findDeviceLink(pool, second.code));
});

test('makeLinkCode: makes codes that differ', () => {
  const seen = new Set(Array.from({ length: 200 }, makeLinkCode));
  assert.equal(seen.size, 200);
});

test('findDeviceLink: finds the link however the code is typed, without using it up', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const { code, link } = await createDeviceLink(pool, 'user-a', 60000);
  assert.deepEqual(await findDeviceLink(pool, code), link);
  assert.deepEqual(await findDeviceLink(pool, ' ' + code.toLowerCase().replace(/-/g, ' ') + ' '), link);
  const { rows } = await pool.query('SELECT * FROM device_links');
  assert.equal(rows.length, 1, 'finding it did not use it up');
});

test('findDeviceLink: is single use once burned', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const { code, link } = await createDeviceLink(pool, 'user-a', 60000);
  await burnDeviceLink(pool, link.h);
  assert.equal(await findDeviceLink(pool, code), null);
  const { rows } = await pool.query('SELECT * FROM device_links');
  assert.equal(rows.length, 0);
});

test('findDeviceLink: refuses an expired link', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  // a negative ttl backdates the expiry into the past — already expired the moment it's made
  const { code } = await createDeviceLink(pool, 'user-a', -1000);
  assert.equal(await findDeviceLink(pool, code), null);
});

test('findDeviceLink: refuses a wrong code without touching other links', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createDeviceLink(pool, 'user-a', 60000);
  assert.equal(await findDeviceLink(pool, 'nope'), null);
  assert.equal(await findDeviceLink(pool, 'AAAA-AAAA-AAAA'), null);
  const { rows } = await pool.query('SELECT * FROM device_links');
  assert.equal(rows.length, 1);
});

test('dropDeviceLinks: drops only that user’s links and says whether any went', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'user-b', name: 'Bea', created: iso() });
  const a = await createDeviceLink(pool, 'user-a', 60000);
  const b = await createDeviceLink(pool, 'user-b', 60000);
  assert.equal(await dropDeviceLinks(pool, 'user-a'), true);
  assert.equal(await dropDeviceLinks(pool, 'user-a'), false);
  assert.equal(await findDeviceLink(pool, a.code), null);
  assert.deepEqual(await findDeviceLink(pool, b.code), b.link);
});

test('deleting the user cascades to their device links', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createDeviceLink(pool, 'user-a', 60000);
  await pool.query('DELETE FROM users WHERE id = $1', ['user-a']);
  const { rows } = await pool.query('SELECT * FROM device_links');
  assert.equal(rows.length, 0);
});
