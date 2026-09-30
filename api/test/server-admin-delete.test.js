/* Issue #107: disabling locks an account out but deliberately leaves state-<uid>.json and the
   credential record in place, so "no data remains" was not reachable from the dashboard. Delete
   removes the user, their credentials, their push subscriptions, their training history and any
   Coach credential — and refuses the two cases nothing in the UI could undo afterwards. Real
   server.js in a child, same harness as server-admin-state.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi, seedUserState } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ADMIN = 'u_adm_1', ADMIN2 = 'u_adm_2', VICTIM = 'u_vic_1';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });
async function startServer(t, { twoAdmins = false } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const users = [
    { id: ADMIN, name: 'Adminna', created: new Date().toISOString(), admin: true },
    { id: VICTIM, name: 'Mallory', created: new Date().toISOString(), invitedBy: 'CODE1' },
  ];
  if (twoAdmins) users.push({ id: ADMIN2, name: 'Second', created: new Date().toISOString(), admin: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users,
    creds: [{ id: 'c-victim', userId: VICTIM, publicKey: 'x' }, { id: 'c-admin', userId: ADMIN, publicKey: 'y' }],
    subs: [
      { endpoint: 'https://push/victim', userId: VICTIM, keys: { p256dh: 'p', auth: 'a' } },
      { endpoint: 'https://push/admin', userId: ADMIN, keys: { p256dh: 'p', auth: 'a' } }
    ],
    invites: [{ code: 'CODE1', usedBy: VICTIM, usedAt: new Date().toISOString() }],
  }));
  const h = await spawnApi(t, { dataDir });
  // Boot has mirrored VICTIM into Postgres by now, so their user_state row can be seeded.
  await seedUserState(h.databaseUrl, VICTIM, { unit: 'kg', workouts: [], _rev: 3 }, 3);
  h.del = async (id, uid = ADMIN) => {
    const r = await fetch(`${h.api}/api/admin/user/delete`, { method: 'POST', headers: { ...as(uid), Origin: 'http://localhost:8080' }, body: JSON.stringify({ id }) });
    return { status: r.status, body: await r.json() };
  };
  h.db = () => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
  h.stateRow = async uid => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try { return (await pool.query('SELECT 1 FROM user_state WHERE user_id = $1', [uid])).rows[0] || null; }
    finally { await pool.end(); }
  };
  // users/invites/push subscriptions moved off db.json onto PostgreSQL (ISO-1403) — creds have
  // not moved yet and still read straight off h.db().
  h.users = async () => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try { return (await pool.query('SELECT id FROM users ORDER BY created_at')).rows.map(r => r.id); }
    finally { await pool.end(); }
  };
  h.invites = async () => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try { return (await pool.query('SELECT code, used_by FROM invites ORDER BY created_at')).rows; }
    finally { await pool.end(); }
  };
  h.subs = async () => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try { return (await pool.query('SELECT user_id FROM push_subscriptions ORDER BY created_at')).rows.map(r => r.user_id); }
    finally { await pool.end(); }
  };
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  return h;
}

test('removes the account and everything attached to it', async t => {
  const h = await startServer(t);
  assert.ok(await h.stateRow(VICTIM));
  const res = await h.del(VICTIM);
  assert.equal(res.status, 200);

  assert.deepEqual(await h.users(), [ADMIN], 'the user is gone');
  const db = h.db();
  assert.deepEqual(db.creds.map(c => c.userId), [ADMIN], 'their passkeys are gone');
  assert.deepEqual(await h.subs(), [ADMIN], 'their push subscriptions are gone');
  assert.equal(await h.stateRow(VICTIM), null, 'their history is gone');
  // The code they joined with stays burned: it was used, and freeing it would quietly widen
  // an invite-only instance.
  const [invite] = await h.invites();
  assert.equal(invite.used_by, VICTIM);
  assert.equal(h.stackFrames(), 0, `no stack traces:\n${h.log}`);
});

test('their session stops working immediately', async t => {
  const h = await startServer(t);
  const before = await fetch(`${h.api}/api/me`, { headers: as(VICTIM) });
  assert.equal(before.status, 200);
  await h.del(VICTIM);
  const after = await fetch(`${h.api}/api/me`, { headers: as(VICTIM) });
  assert.equal(after.status, 401, 'a cookie for a deleted account is worthless');
});

test('refuses the two deletions that cannot be undone', async t => {
  const h = await startServer(t);
  const self = await h.del(ADMIN);
  assert.equal(self.status, 400);
  assert.match(self.body.error, /your own account/);

  const last = await h.del(ADMIN, ADMIN);   // ADMIN is also the only admin
  assert.equal(last.status, 400);
  assert.equal((await h.users()).length, 2, 'nothing was removed');
});

test('another admin can be deleted while one remains', async t => {
  const h = await startServer(t, { twoAdmins: true });
  const res = await h.del(ADMIN2);
  assert.equal(res.status, 200);
  assert.deepEqual((await h.users()).sort(), [ADMIN, VICTIM].sort());
});

test('says so plainly when the account is not there, and needs an admin', async t => {
  const h = await startServer(t);
  const missing = await h.del('nobody');
  assert.equal(missing.status, 404);
  const asVictim = await h.del(ADMIN, VICTIM);
  assert.equal(asVictim.status, 403, 'an ordinary user cannot delete anyone');
  assert.equal((await h.users()).length, 2);
});
