/* The `passkeys` half of store.js (ISO-1403), tested directly against real PostgreSQL — no
 * server.js spawned. The routes are in server-passkeys.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import {
  createUser, insertPasskey, listPasskeys, getPasskeyById, countPasskeys, renamePasskey,
  passkeyRemovalRefused, removePasskey, touchPasskeyUse
} from '../store.js';
import { MAX_PASSKEYS } from '../passkeys-store.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();
const cred = (id, extra = {}) => ({ id, publicKey: 'pk-' + id, counter: 0, transports: ['internal'], ...extra });

test('insertPasskey + listPasskeys: attaches a credential to the existing user', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  const r = await insertPasskey(pool, 'u1', { ...cred('phone'), name: '  Work   phone ' });
  assert.equal(r.ok, true);
  const list = await listPasskeys(pool, 'u1');
  assert.deepEqual(list.map(c => c.id), ['hello', 'phone']);
  for (const c of list) assert.equal(c.publicKey, undefined);
  assert.deepEqual(list[0], { id: 'hello', name: null, created: list[0].created, lastUsed: null, transports: ['internal'] });
  assert.equal(list[1].name, 'Work phone');
});

test('insertPasskey: refuses a credential id that already exists', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  const r = await insertPasskey(pool, 'u2', cred('hello'));
  assert.deepEqual(r, { error: 'credential already registered', code: 'credential-exists' });
  assert.equal(await countPasskeys(pool, 'u1'), 1);
  assert.equal(await countPasskeys(pool, 'u2'), 0);
});

test('insertPasskey: keeps only a short list of short transport words', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', { ...cred('a'), transports: ['usb', 42, 'x'.repeat(100), ...Array(20).fill('nfc')] });
  await insertPasskey(pool, 'u1', { ...cred('b'), transports: 'internal' });
  const list = await listPasskeys(pool, 'u1');
  assert.deepEqual(list.find(c => c.id === 'a').transports, ['usb', ...Array(7).fill('nfc')]);
  assert.deepEqual(list.find(c => c.id === 'b').transports, []);
});

test(`insertPasskey: stops at ${MAX_PASSKEYS} passkeys per profile`, async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  for (let i = 0; i < MAX_PASSKEYS; i++) await insertPasskey(pool, 'u1', cred('k' + i));
  assert.equal((await insertPasskey(pool, 'u1', cred('one-more'))).code, 'passkey-limit');
  assert.equal((await insertPasskey(pool, 'u2', cred('theirs'))).ok, true);
});

// The real race this exists for: two additions for the same account running side by side —
// only the count checked as part of the same statement as the insert can't both slip past it.
test('insertPasskey: two concurrent additions at the cap — exactly one more gets in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  for (let i = 0; i < MAX_PASSKEYS - 1; i++) await insertPasskey(pool, 'u1', cred('k' + i));
  const [a, b] = await Promise.all([
    insertPasskey(pool, 'u1', cred('race-a')),
    insertPasskey(pool, 'u1', cred('race-b'))
  ]);
  const oks = [a, b].filter(r => r.ok).length;
  assert.equal(oks, 1);
  assert.equal(await countPasskeys(pool, 'u1'), MAX_PASSKEYS);
});

test('renamePasskey: names one of the user’s passkeys, and an empty name clears it', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('a'));
  assert.equal((await renamePasskey(pool, 'u1', 'a', 'Security key\n')).ok, true);
  assert.equal((await getPasskeyById(pool, 'a')).name, 'Security key');
  await renamePasskey(pool, 'u1', 'a', '   ');
  assert.equal('name' in (await getPasskeyById(pool, 'a')), false);
});

test('renamePasskey: does not touch another user’s passkey', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertPasskey(pool, 'u1', cred('a'));
  assert.equal((await renamePasskey(pool, 'u2', 'a', 'mine now')).code, 'not-found');
  assert.equal('name' in (await getPasskeyById(pool, 'a')), false);
});

test('removePasskey: removes one of several passkeys', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertPasskey(pool, 'u1', cred('phone'));
  const r = await removePasskey(pool, 'u1', 'hello');
  assert.equal(r.ok, true);
  assert.equal(r.row.id, 'hello');
  assert.deepEqual((await listPasskeys(pool, 'u1')).map(c => c.id), ['phone']);
});

test('removePasskey: refuses to remove the last passkey when nothing else signs the profile in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertPasskey(pool, 'u2', cred('other'));
  const r = await removePasskey(pool, 'u1', 'hello');
  assert.deepEqual(r, { error: 'this passkey is the only way into this profile', code: 'last-way-in' });
  assert.equal(await countPasskeys(pool, 'u1'), 1);
});

test('removePasskey: lets the last passkey go while a password still signs the profile in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  assert.equal((await removePasskey(pool, 'u1', 'hello', 1)).ok, true);
  assert.equal(await countPasskeys(pool, 'u1'), 0);
});

test('removePasskey: does not let one user delete another’s passkey', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertPasskey(pool, 'u2', cred('other'));
  const r = await removePasskey(pool, 'u2', 'hello');
  assert.deepEqual(r, { error: 'passkey not found', code: 'not-found' });
  assert.equal(await countPasskeys(pool, 'u1'), 1);
});

test('passkeyRemovalRefused: answers what removePasskey would, without removing anything', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertPasskey(pool, 'u1', cred('phone'));
  await insertPasskey(pool, 'u2', cred('other'));
  assert.equal(await passkeyRemovalRefused(pool, 'u1', 'hello'), null);
  assert.deepEqual(await passkeyRemovalRefused(pool, 'u1', 'other'), { error: 'passkey not found', code: 'not-found' });
  assert.deepEqual(await passkeyRemovalRefused(pool, 'u2', 'other'), { error: 'this passkey is the only way into this profile', code: 'last-way-in' });
  assert.equal(await passkeyRemovalRefused(pool, 'u2', 'other', 1), null);
  assert.equal((await passkeyRemovalRefused(pool, 'u1', 'nope')).code, 'not-found');
  assert.equal(await countPasskeys(pool, 'u1'), 2);
});

test('touchPasskeyUse: updates counter and last_used_at', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  assert.equal((await getPasskeyById(pool, 'hello')).lastUsed, undefined);
  await touchPasskeyUse(pool, 'hello', 7);
  const row = await getPasskeyById(pool, 'hello');
  assert.equal(row.counter, 7);
  assert.ok(row.lastUsed);
});

test('deleting the user cascades to their passkeys', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await pool.query('DELETE FROM users WHERE id = $1', ['u1']);
  assert.equal(await getPasskeyById(pool, 'hello'), null);
});
