/* The admin routes used to read state files nobody validated (routines/bodyweight/workouts) and
   walk them to build the drill-down and the user list's workout count — a null or shapeless entry
   in a document stored before PUT /api/data's own filter existed (QA C16/C19) could throw and turn
   the whole drill-down into a 500. ISO-1447 (Phase 4, LGPD) removed that surface instead of
   hardening it: an admin runs the instance, not its users' training, so neither route reads
   routines, bodyweight or workouts out of the profile's state any more — this file now asserts
   that absence holds even for a document from before the filter, not just for a clean one, and
   that the two routes this issue did keep touching the state for (`lastSync`, and the disable
   switch) still work. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi, seedUserState } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');

// Same construction as server.js makeSession(): payload `uid:exp:sv`, HMAC-SHA256 over SECRET.
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const ADMIN = 'u_adm_1', VICTIM = 'u_vic_1';
const asAdmin = { Cookie: `gymsid=${mintSession(ADMIN)}`, 'Content-Type': 'application/json' };

async function startServer(t) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Adminna', created: new Date().toISOString(), admin: true },
      { id: VICTIM, name: 'Mallory', created: new Date().toISOString() }
    ], creds: [], subs: [], invites: []
  }));
  const h = await spawnApi(t, { dataDir });
  // The boot line is fine; anything that looks like a stack frame after this is a defect.
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  // Writes straight into user_state, bypassing PUT /api/data's own validation — simulating a
  // document stored before that filter existed, same as writing state-<uid>.json directly did.
  h.plant = S => seedUserState(h.databaseUrl, VICTIM, S, Number(S?._rev) || 1);
  h.get = async p => { const r = await fetch(`${h.api}${p}`, { headers: asAdmin }); return { status: r.status, body: await r.json() }; };
  // users moved off db.json onto PostgreSQL's users table (ISO-1403).
  h.user = async uid => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try { return (await pool.query('SELECT disabled, last_pull_at FROM users WHERE id = $1', [uid])).rows[0] || null; }
    finally { await pool.end(); }
  };
  return h;
}

const okW = { id: 'w1', name: 'Fine', d: '2026-09-18', start: 1, end: 2, entries: [{ id: 'e', sets: [{ w: 10, r: 5, done: true }] }] };
const okR = { id: 'r1', name: 'Full body', emoji: '💪', ex: [{ id: '0001', sets: 3, reps: 10 }] };
const okB = { d: '2026-09-01', w: 80 };

/* The shapes v1.3.7 accepted through PUT /api/data, one per line. `null` is the one the field
   reports came in with; the rest are the same mistake one field over. None of them should ever
   reach a response any more — ISO-1447 dropped training data from both admin routes entirely,
   which is also what makes every one of these shapes harmless now: nothing walks them. */
const DOCS = {
  'a null routine entry': { workouts: [okW], routines: [null, okR], bodyweight: [okB], unit: 'kg' },
  'shapeless routine entries': { workouts: [okW], routines: [7, 'x', [], okR], bodyweight: [okB], unit: 'kg' },
  'a null workout entry': { workouts: [null, okW], routines: [okR], bodyweight: [okB], unit: 'kg' },
  'shapeless workout entries': { workouts: ['x', [], okW], routines: [okR], bodyweight: [okB], unit: 'kg' },
  'a null body-weight entry': { workouts: [okW], routines: [okR], bodyweight: [null, okB], unit: 'kg' },
  'shapeless body-weight entries': { workouts: [okW], routines: [okR], bodyweight: ['x', 7, [], okB], unit: 'kg' },
  'a null customEx entry': { workouts: [okW], routines: [okR], bodyweight: [okB], customEx: [null], unit: 'kg' },
  'lists that are objects, not arrays': { workouts: { a: 1 }, routines: { a: 1 }, bodyweight: { a: 1 }, unit: 'kg' },
  'lists that are null': { workouts: null, routines: null, bodyweight: null, unit: 'kg' },
  'no lists at all': { unit: 'kg' }
};

test('GET /api/admin/user: no training data, for a clean document or one from before the entry filter', async t => {
  const h = await startServer(t);
  for (const [what, doc] of Object.entries(DOCS)) {
    await h.plant(doc);
    const r = await h.get(`/api/admin/user?id=${VICTIM}`);
    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
    for (const k of ['routines', 'bodyweight', 'workouts', 'unit']) {
      assert.equal(k in r.body, false, `${what}: ${k} should not be in the response`);
    }
    assert.deepEqual(Object.keys(r.body).sort(), ['lastSync', 'subscription', 'user'].sort(), what);
  }
  assert.equal(h.stackFrames(), 0, `stack traces in the log:\n${h.log}`);
});

test('the user list and the disable switch survive the same document, with no training data either', async t => {
  const h = await startServer(t);
  for (const [what, doc] of Object.entries(DOCS)) {
    await h.plant(doc);
    const r = await h.get('/api/admin/users');
    assert.equal(r.status, 200, what);
    const row = r.body.users.find(u => u.id === VICTIM);
    for (const k of ['workouts', 'lastWorkout', 'live']) assert.equal(k in row, false, `${what}: ${k} should not be in the row`);
    assert.equal(typeof row.online, 'boolean', what);
  }
  // The end state the whole thing is about: the account can be stopped from the dashboard.
  await h.plant(DOCS['a null routine entry']);
  const r = await fetch(`${h.api}/api/admin/user/disable`, { method: 'POST', headers: asAdmin, body: JSON.stringify({ id: VICTIM, disabled: true }) });
  assert.equal(r.status, 200);
  assert.equal((await h.user(VICTIM)).disabled, true);
  // …and the audit log still reads back, with that change in it.
  const a = await h.get('/api/admin/audit?limit=10&cat=');
  assert.equal(a.status, 200);
  assert.ok(a.body.events.some(e => e.ev === 'admin.user.disable'), JSON.stringify(a.body.events));
  assert.equal(h.stackFrames(), 0, `stack traces in the log:\n${h.log}`);
});

// QA 1.3.9: a profile that only ever pulled (a second device, someone who reads and never edits)
// showed "last sync never" — only a push moved the document's `_ts`. A pull counts too.
test('a pull shows as the last sync, in the list and the drill-down', async t => {
  const h = await startServer(t);
  await h.plant({ _rev: 3, workouts: [okW] });
  let row = (await h.get('/api/admin/users')).body.users.find(u => u.id === VICTIM);
  assert.equal(row.lastSync, null);
  const before = Date.now();
  const pull = await fetch(`${h.api}/api/data`, { headers: { Cookie: `gymsid=${mintSession(VICTIM)}` } });
  assert.equal(pull.status, 200);
  row = (await h.get('/api/admin/users')).body.users.find(u => u.id === VICTIM);
  assert.ok(row.lastSync >= before, JSON.stringify(row));
  assert.ok((await h.get(`/api/admin/user?id=${VICTIM}`)).body.lastSync >= before);
  // Kept across a restart: it is on the user record.
  assert.ok((await h.user(VICTIM)).last_pull_at.getTime() >= before);
  // A later push still wins when it is the newer of the two.
  await h.plant({ _rev: 4, _ts: Date.now() + 60000, workouts: [okW] });
  row = (await h.get('/api/admin/users')).body.users.find(u => u.id === VICTIM);
  assert.ok(row.lastSync > Date.now());
});
