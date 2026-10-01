/* The `email_tokens` half of store.js (ISO-1397), tested directly against real PostgreSQL — no
 * server.js spawned. The routes around it are in server-email-recovery.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import { createUser, createEmailToken, consumeEmailToken } from '../store.js';
import { makeEmailToken, hashEmailToken } from '../email-tokens.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();

test('makeEmailToken: makes tokens that differ', () => {
  const seen = new Set(Array.from({ length: 200 }, makeEmailToken));
  assert.equal(seen.size, 200);
});

test('createEmailToken + consumeEmailToken: round-trips, and keeps only the hash', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const token = makeEmailToken();
  const before = Date.now();
  const { expiresAt } = await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(token), 60000);
  assert.ok(expiresAt >= before + 60000 && expiresAt <= Date.now() + 60000);
  const { rows } = await pool.query('SELECT * FROM email_tokens');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashEmailToken(token));
  assert.equal(rows[0].purpose, 'verify');
  assert.equal(rows[0].used_at, null);
  // Nowhere in what is stored does the token itself appear.
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(token));
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'verify'), 'user-a');
});

test('consumeEmailToken: single use — a second redemption of the same token claims nothing', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const token = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(token), 60000);
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'verify'), 'user-a');
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'verify'), null);
});

// The real race POST /api/account/email/verify and POST /api/recover/redeem rely on: two
// requests redeeming the same token side by side — only the one whose UPDATE actually matches a
// row may go on to mark the e-mail verified / mint a device-link code.
test('consumeEmailToken: two concurrent redemptions of the same token — exactly one claims it', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const token = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(token), 60000);
  const [a, b] = await Promise.all([
    consumeEmailToken(pool, hashEmailToken(token), 'verify'),
    consumeEmailToken(pool, hashEmailToken(token), 'verify')
  ]);
  assert.deepEqual([a, b].sort(), [null, 'user-a']);
});

test('consumeEmailToken: refuses an expired token, and never claims it', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const token = makeEmailToken();
  // a negative ttl backdates the expiry into the past — already expired the moment it's made
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(token), -1000);
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'verify'), null);
  const { rows } = await pool.query('SELECT used_at FROM email_tokens');
  assert.equal(rows[0].used_at, null, 'an expired token is refused, not silently burned');
});

test('consumeEmailToken: a token of the wrong purpose, or a never-issued one, claims nothing', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  const token = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(token), 60000);
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'recover'), null);
  assert.equal(await consumeEmailToken(pool, hashEmailToken('never-issued'), 'verify'), null);
  // Still live for its own purpose — the wrong-purpose attempt above did not burn it.
  assert.equal(await consumeEmailToken(pool, hashEmailToken(token), 'verify'), 'user-a');
});

test('createEmailToken: a fresh token invalidates whichever one of the same purpose was still live, leaves the other purpose and other users alone', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'user-b', name: 'Bea', created: iso() });
  const first = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(first), 60000);
  const recover = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'recover', hashEmailToken(recover), 60000);
  const bea = makeEmailToken();
  await createEmailToken(pool, 'user-b', 'verify', hashEmailToken(bea), 60000);
  // "Resend": a second 'verify' token for user-a.
  const second = makeEmailToken();
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(second), 60000);

  assert.equal(await consumeEmailToken(pool, hashEmailToken(first), 'verify'), null, 'the first link is dead');
  assert.equal(await consumeEmailToken(pool, hashEmailToken(second), 'verify'), 'user-a', 'the resent one works');
  assert.equal(await consumeEmailToken(pool, hashEmailToken(recover), 'recover'), 'user-a', 'a different purpose was untouched');
  assert.equal(await consumeEmailToken(pool, hashEmailToken(bea), 'verify'), 'user-b', "another user's token was untouched");
});

test('deleting the user cascades to their e-mail tokens', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'user-a', name: 'Ana', created: iso() });
  await createEmailToken(pool, 'user-a', 'verify', hashEmailToken(makeEmailToken()), 60000);
  await pool.query('DELETE FROM users WHERE id = $1', ['user-a']);
  const { rows } = await pool.query('SELECT * FROM email_tokens');
  assert.equal(rows.length, 0);
});
