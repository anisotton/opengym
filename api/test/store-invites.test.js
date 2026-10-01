/* The `invites` half of store.js (ISO-1403), tested directly against real PostgreSQL — no
 * server.js spawned. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate, withTransaction } from '../db.js';
import { createUser, createInvite, getAllInvites, codeExists, inviteIsValid, consumeInvite, revokeInvite } from '../store.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();

test('createInvite + getAllInvites: a fresh code has no usedBy, oldest first', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'admin1', name: 'Admin', created: iso() });
  await createInvite(pool, { code: 'CODE1', note: 'for Bea', createdBy: 'admin1' });
  const invites = await getAllInvites(pool);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].code, 'CODE1');
  assert.equal(invites[0].note, 'for Bea');
  assert.equal(invites[0].createdBy, 'admin1');
  assert.equal('usedBy' in invites[0], false);
});

test('createInvite with no note and no createdBy is fine', async t => {
  const pool = await withPool(t);
  await createInvite(pool, { code: 'CODE1' });
  const invites = await getAllInvites(pool);
  assert.equal('note' in invites[0], false);
  assert.equal('createdBy' in invites[0], false);
});

test('codeExists / inviteIsValid: unused is both; used is only codeExists; unknown is neither', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createInvite(pool, { code: 'CODE1' });
  assert.equal(await codeExists(pool, 'CODE1'), true);
  assert.equal(await inviteIsValid(pool, 'CODE1'), true);
  assert.equal(await codeExists(pool, 'NOPE'), false);
  assert.equal(await inviteIsValid(pool, 'NOPE'), false);

  await consumeInvite(pool, 'CODE1', 'u1');
  assert.equal(await codeExists(pool, 'CODE1'), true);
  assert.equal(await inviteIsValid(pool, 'CODE1'), false);
});

test('consumeInvite: the first caller wins, a second call for the same code loses', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await createInvite(pool, { code: 'CODE1' });
  assert.equal(await consumeInvite(pool, 'CODE1', 'u1'), true);
  assert.equal(await consumeInvite(pool, 'CODE1', 'u2'), false, 'already used, by u1');
  const [invite] = await getAllInvites(pool);
  assert.equal(invite.usedBy, 'u1', 'the second caller did not overwrite the first');
});

// The real race this exists for: two requests consuming the same code concurrently — only one of
// two truly-parallel UPDATEs can match `used_by IS NULL`.
test('two concurrent consumeInvite calls for the same code: exactly one wins', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createUser(pool, { id: 'u2', name: 'Bea', created: iso() });
  await createInvite(pool, { code: 'CODE1' });
  const [a, b] = await Promise.all([
    consumeInvite(pool, 'CODE1', 'u1'),
    consumeInvite(pool, 'CODE1', 'u2')
  ]);
  assert.deepEqual([a, b].sort(), [false, true]);
});

test('consumeInvite inside a rolled-back transaction leaves the invite unused', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createInvite(pool, { code: 'CODE1' });
  await assert.rejects(withTransaction(pool, async client => {
    const ok = await consumeInvite(client, 'CODE1', 'u1');
    assert.equal(ok, true, 'consumed inside the transaction');
    throw new Error('simulated failure after consuming — e.g. the user row never landed');
  }));
  assert.equal(await inviteIsValid(pool, 'CODE1'), true, 'the rollback undid the consumption');
});

test('revokeInvite removes an unused code; refuses one already used', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createInvite(pool, { code: 'FREE' });
  await createInvite(pool, { code: 'USED' });
  await consumeInvite(pool, 'USED', 'u1');

  assert.equal(await revokeInvite(pool, 'FREE'), true);
  assert.equal(await codeExists(pool, 'FREE'), false);

  assert.equal(await revokeInvite(pool, 'USED'), false, 'already used — not revoked');
  assert.equal(await codeExists(pool, 'USED'), true, 'the used code is untouched');

  assert.equal(await revokeInvite(pool, 'NOPE'), false);
});

test('deleting the admin who created an invite clears createdBy; deleting who used it leaves the code burned', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'admin1', name: 'Admin', created: iso() });
  await createUser(pool, { id: 'u1', name: 'Ana', created: iso() });
  await createInvite(pool, { code: 'CODE1', createdBy: 'admin1' });
  await consumeInvite(pool, 'CODE1', 'u1');
  await pool.query('DELETE FROM users WHERE id = $1', ['admin1']);
  await pool.query('DELETE FROM users WHERE id = $1', ['u1']);
  const [invite] = await getAllInvites(pool);
  assert.equal(invite.code, 'CODE1');
  assert.equal('createdBy' in invite, false, 'ON DELETE SET NULL on created_by — purely informational');
  // used_by has no foreign key on purpose: admin/user/delete relies on the code staying burned
  // even once the account that burned it is gone, or deleting a user would quietly free their
  // invite back up on an invite-only instance.
  assert.equal(invite.usedBy, 'u1', 'the code stays burned after the user who used it is deleted');
});
