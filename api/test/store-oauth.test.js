/* The `oauth_identities` half of store.js (ISO-1597), tested directly against real PostgreSQL —
 * no server.js spawned. The routes are in server-google.test.js. Mirrors store-passkeys.test.js's
 * own shape, including its race test — extended here to the third way in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import {
  createUser, getUserById, insertPasskey, countPasskeys, removePasskey, removePasswordUnlessLast,
  insertOAuthIdentity, findOAuthIdentityBySubject, findOAuthIdentityByUser, touchOAuthIdentityUse,
  removeOAuthIdentityUnlessLast
} from '../store.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();
const cred = (id, extra = {}) => ({ id, publicKey: 'pk-' + id, counter: 0, transports: ['internal'], ...extra });

test('insertOAuthIdentity + findOAuthIdentityBySubject/ByUser: attaches an identity to the user', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  const r = await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1', email: 'ana@example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.row.subject, 'sub-1');
  const bySub = await findOAuthIdentityBySubject(pool, 'google', 'sub-1');
  assert.equal(bySub.userId, 'u1');
  assert.equal(bySub.email, 'ana@example.com');
  const byUser = await findOAuthIdentityByUser(pool, 'google', 'u1');
  assert.equal(byUser.subject, 'sub-1');
  assert.equal(await findOAuthIdentityByUser(pool, 'google', 'nope'), null);
  assert.equal(await findOAuthIdentityBySubject(pool, 'google', 'nope'), null);
});

test('insertOAuthIdentity: refuses a second Google account for the same (provider, subject)', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  const r = await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u2' });
  assert.deepEqual(r, { error: 'already linked', code: 'already-linked' });
  assert.equal((await findOAuthIdentityBySubject(pool, 'google', 'sub-1')).userId, 'u1');
});

test('insertOAuthIdentity: refuses a second Google account on the same (provider, user_id)', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  const r = await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-2', userId: 'u1' });
  assert.equal(r.error, 'already linked');
  assert.equal(await findOAuthIdentityBySubject(pool, 'google', 'sub-2'), null);
});

test('insertOAuthIdentity: two concurrent links of the same Google account — exactly one wins', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  const [a, b] = await Promise.all([
    insertOAuthIdentity(pool, { provider: 'google', subject: 'race-sub', userId: 'u1' }),
    insertOAuthIdentity(pool, { provider: 'google', subject: 'race-sub', userId: 'u2' })
  ]);
  const oks = [a, b].filter(r => r.ok).length;
  assert.equal(oks, 1);
});

test('touchOAuthIdentityUse: bumps last_used_at without touching anything else', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1', email: 'a@b.com' });
  await touchOAuthIdentityUse(pool, 'google', 'sub-1');
  const row = await findOAuthIdentityByUser(pool, 'google', 'u1');
  assert.ok(row.lastUsed);
  assert.equal(row.email, 'a@b.com');
});

test('removeOAuthIdentityUnlessLast: removes it when something else still signs the profile in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  const r = await removeOAuthIdentityUnlessLast(pool, 'u1', 'google');
  assert.equal(r.ok, true);
  assert.equal(await findOAuthIdentityByUser(pool, 'google', 'u1'), null);
});

test('removeOAuthIdentityUnlessLast: refuses when it is the only way in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  const r = await removeOAuthIdentityUnlessLast(pool, 'u1', 'google');
  assert.deepEqual(r, { error: 'connecting with Google is the only way into this profile', code: 'last-way-in' });
  assert.ok(await findOAuthIdentityByUser(pool, 'google', 'u1'));
});

// passwordCounts is PASSWORD_LOGIN (a server setting); whether a password actually exists is
// read live, not handed in — a password-less profile gets no credit for one even if asked to.
test('removeOAuthIdentityUnlessLast: passwordCounts asks whether a password would help, not whether it is one', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  assert.deepEqual(await removeOAuthIdentityUnlessLast(pool, 'u1', 'google', true),
    { error: 'connecting with Google is the only way into this profile', code: 'last-way-in' });
  await insertPasskey(pool, 'u1', cred('backup'));
  assert.equal((await removeOAuthIdentityUnlessLast(pool, 'u1', 'google', true)).ok, true);
});

test('removeOAuthIdentityUnlessLast: already gone is a no-op success', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  const r = await removeOAuthIdentityUnlessLast(pool, 'u1', 'google');
  assert.equal(r.ok, true);
});

test('removePasskey: lets the last passkey go while a linked Google identity still signs the profile in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  assert.equal((await removePasskey(pool, 'u1', 'hello', false, true)).ok, true);
  assert.equal(await countPasskeys(pool, 'u1'), 0);
});

test('removePasskey: refuses the last passkey when Google is linked but GOOGLE_LOGIN is off (googleCounts=false)', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await insertPasskey(pool, 'u1', cred('hello'));
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  const r = await removePasskey(pool, 'u1', 'hello');
  assert.deepEqual(r, { error: 'this passkey is the only way into this profile', code: 'last-way-in' });
});

test('removePasswordUnlessLast: lets the password go while a linked Google identity still signs the profile in', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso(), pw: { h: 'h', set: iso() } });
  await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-1', userId: 'u1' });
  assert.equal((await removePasswordUnlessLast(pool, 'u1', true)).ok, true);
  assert.equal('pw' in await getUserById(pool, 'u1'), false);
});

// The real race these exist for (ISO-1592, extended here to the third way in): removing two of a
// profile's two remaining ways in at once must never both succeed — only a check that re-reads
// every table under the same per-account lock can tell which one committed first.
test('removePasswordUnlessLast + removeOAuthIdentityUnlessLast racing an account with only those two: exactly one succeeds', async t => {
  const pool = await withPool(t);
  const ROUNDS = 20;
  for (let i = 0; i < ROUNDS; i++) {
    const uid = 'race-pw-google-' + i;
    await createUser(pool, { id: uid, name: 'Ana', created: iso(), pw: { h: 'h', set: iso() } });
    await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-' + i, userId: uid });
    const [pw, g] = await Promise.all([
      removePasswordUnlessLast(pool, uid, true),
      removeOAuthIdentityUnlessLast(pool, uid, 'google', true)
    ]);
    const oks = [pw, g].filter(r => r.ok).length;
    assert.equal(oks, 1, `round ${i}: ${JSON.stringify(pw)} / ${JSON.stringify(g)}`);
    const stillHasPw = 'pw' in await getUserById(pool, uid);
    const stillHasGoogle = !!(await findOAuthIdentityByUser(pool, 'google', uid));
    assert.equal((stillHasPw ? 1 : 0) + (stillHasGoogle ? 1 : 0), 1, `round ${i}: the profile kept exactly one way in`);
  }
});

test('removePasskey + removeOAuthIdentityUnlessLast racing an account with only those two: exactly one succeeds', async t => {
  const pool = await withPool(t);
  const ROUNDS = 20;
  for (let i = 0; i < ROUNDS; i++) {
    const uid = 'race-pk-google-' + i;
    await createUser(pool, { id: uid, name: 'Ana', created: iso() });
    await insertPasskey(pool, uid, cred('hello' + i));
    await insertOAuthIdentity(pool, { provider: 'google', subject: 'sub-' + i, userId: uid });
    const [pk, g] = await Promise.all([
      removePasskey(pool, uid, 'hello' + i, false, true),
      removeOAuthIdentityUnlessLast(pool, uid, 'google', false)
    ]);
    const oks = [pk, g].filter(r => r.ok).length;
    assert.equal(oks, 1, `round ${i}: ${JSON.stringify(pk)} / ${JSON.stringify(g)}`);
    const stillHasPk = await countPasskeys(pool, uid);
    const stillHasGoogle = !!(await findOAuthIdentityByUser(pool, 'google', uid));
    assert.equal(stillHasPk + (stillHasGoogle ? 1 : 0), 1, `round ${i}: the profile kept exactly one way in`);
  }
});
