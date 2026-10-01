/* /api/data carries a server revision: GET hands it out, PUT with `baseRev` is refused (409, with
   the current document) when another write landed in between, PUT without `baseRev` overwrites
   as clients from before revisions always did. Real server.js in a child, real PostgreSQL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });

async function startServer(t, { users = [{ id: 'u_rev_1', name: 'One', created: new Date().toISOString() }] } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, { dataDir });
  h.row = async uid => {
    const pool = new pg.Pool({ connectionString: h.databaseUrl });
    try {
      const { rows } = await pool.query('SELECT state, rev::int AS rev FROM user_state WHERE user_id = $1', [uid]);
      return rows[0] || null;
    } finally { await pool.end(); }
  };
  return h;
}

test('GET/PUT /api/data: revisions, conditional writes and the legacy overwrite', async t => {
  const h = await startServer(t);
  const uid = 'u_rev_1';
  const get = async () => { const r = await fetch(`${h.api}/api/data`, { headers: headers(uid) }); return { status: r.status, body: await r.json() }; };
  const put = async body => { const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(uid), body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const stored = async () => (await h.row(uid))?.state;

  // nothing synced yet
  let r = await get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { state: null, rev: 0 });

  // first write against rev 0
  r = await put({ state: { _ts: 100, workouts: [{ id: 'w1', d: '2026-09-01' }], routines: [], active: { id: 'running' } }, baseRev: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rev, 1);
  assert.equal(r.body.ts, 100);
  assert.equal((await stored())._rev, 1);
  assert.equal('active' in (await stored()), false, 'active is stripped');

  r = await get();
  assert.equal(r.body.rev, 1);
  assert.equal(r.body.state._rev, 1);
  assert.deepEqual(r.body.state.workouts.map(w => w.id), ['w1']);

  // the same baseRev again — someone else already wrote rev 1 — is a conflict, and the current
  // document comes back with it
  r = await put({ state: { _ts: 200, workouts: [], routines: [] }, baseRev: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'conflict');
  assert.equal(r.body.rev, 1);
  assert.deepEqual(r.body.state.workouts.map(w => w.id), ['w1']);
  assert.deepEqual((await stored()).workouts.map(w => w.id), ['w1'], 'a refused write changes nothing');

  // a client from before revisions sends no baseRev and overwrites, as it always did
  r = await put({ state: { _ts: 300, workouts: [{ id: 'w2', d: '2026-09-02' }], routines: [] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 2);
  assert.deepEqual((await stored()).workouts.map(w => w.id), ['w2']);

  // a matching baseRev goes through; a client-supplied _rev is ignored
  r = await put({ state: { _ts: 400, _rev: 99, workouts: [{ id: 'w3', d: '2026-09-03' }], routines: [] }, baseRev: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 3);
  assert.equal((await stored())._rev, 3);

  // an explicit null is "no baseRev", not "rev null"
  r = await put({ state: { _ts: 500, workouts: [], routines: [] }, baseRev: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 4);

  // a baseRev that is a string never matches (no coercion)
  r = await put({ state: { _ts: 600, workouts: [], routines: [] }, baseRev: '4' });
  assert.equal(r.status, 409);

  // the shape check still comes first
  r = await put({ state: { workouts: 'nope' }, baseRev: 4 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid state');
  assert.equal((await stored())._rev, 4);
});

// `{}` keeps every rule this route has and still empties the profile: it is
// an object, it is not an array, `workouts` and `routines` are absent (which is legal — a client
// fills its own defaults), so the document stored becomes `{"_rev":n+1}` with every routine,
// workout and weigh-in gone, and the revision keeps counting so the next poll sees nothing wrong.
// No shipped client sends it: the web and mobile clients push a state built on DEF, which always
// carries its keys.
test('PUT /api/data refuses an empty object, which would wipe the profile and keep counting', async t => {
  const h = await startServer(t);
  const uid = 'u_rev_1';
  const put = async body => { const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(uid), body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const rev = async () => (await fetch(`${h.api}/api/data/rev`, { headers: headers(uid) }).then(r => r.json())).rev;
  const stored = async () => (await h.row(uid))?.state;

  assert.equal((await put({ state: { _ts: 100, workouts: [{ id: 'w1', d: '2026-09-01' }], routines: [] } })).status, 200);
  assert.equal(await rev(), 1);

  // `_rev` and `_ts` are this route's own bookkeeping — it stamps the one and echoes the other —
  // so a document carrying nothing but those is the same empty push wearing a hat, and did the
  // same damage: `{"_rev":5}` wrote `{"_rev":2}` over the profile.
  for (const state of [{}, { _rev: 5 }, { _ts: Date.now() }, { _rev: 5, _ts: Date.now() }]) {
    const r = await put({ state, baseRev: 1 });
    assert.equal(r.status, 400, `state: ${JSON.stringify(state)}`);
    assert.equal(r.body.error, 'state required');
  }
  assert.equal(await rev(), 1, 'nothing was written');
  assert.deepEqual((await stored()).workouts.map(w => w.id), ['w1'], 'the profile is still there');

  // …and a document that carries one real key alongside them is a profile, and goes through.
  assert.equal((await put({ state: { _rev: 99, _ts: 1, routines: [] }, baseRev: 1 })).status, 200);
  assert.equal(await rev(), 2);
});

// Two devices, the scenario baseRev exists for: both read rev N, A pushes first and wins, B's
// push against the same baseRev is refused with A's rev/state, and B's retry with that rev goes
// through. Acceptance criterion for ISO-1403 (Phase 1b) — see the issue.
test('two devices: a stale write is refused, a retry against the current rev succeeds', async t => {
  const h = await startServer(t);
  const uid = 'u_rev_1';
  const get = async () => (await fetch(`${h.api}/api/data`, { headers: headers(uid) })).json();
  const put = async body => { const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(uid), body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  // Both devices start from rev 0.
  const a0 = await get();
  const b0 = await get();
  assert.equal(a0.rev, 0);
  assert.equal(b0.rev, 0);

  // A pushes first.
  const aPush = await put({ state: { _ts: 100, workouts: [{ id: 'a1', d: '2026-09-01' }], routines: [] }, baseRev: a0.rev });
  assert.equal(aPush.status, 200);
  assert.equal(aPush.body.rev, 1);

  // B, still on rev 0, is refused — with A's rev and document, so it can merge.
  const bPush = await put({ state: { _ts: 150, workouts: [{ id: 'b1', d: '2026-09-01' }], routines: [] }, baseRev: b0.rev });
  assert.equal(bPush.status, 409);
  assert.equal(bPush.body.error, 'conflict');
  assert.equal(bPush.body.rev, 1);
  assert.deepEqual(bPush.body.state.workouts.map(w => w.id), ['a1']);

  // B retries against the rev the conflict just told it about, folding its own entry in.
  const bRetry = await put({
    state: { _ts: 200, workouts: [...bPush.body.state.workouts, { id: 'b1', d: '2026-09-01' }], routines: [] },
    baseRev: bPush.body.rev
  });
  assert.equal(bRetry.status, 200);
  assert.equal(bRetry.body.rev, 2);

  const final = await get();
  assert.equal(final.rev, 2);
  assert.deepEqual(final.state.workouts.map(w => w.id).sort(), ['a1', 'b1']);
});

// The real race, not the sequential simulation above: two writers for the same profile issue
// their PUTs concurrently. putUserState's compare-and-set (store.js) means only one of two
// requests both sent with baseRev 0 can land — the other is retried internally against the fresh
// row and comes back a 409, never a silently-dropped write.
test('two concurrent writes with the same baseRev: exactly one wins', async t => {
  const h = await startServer(t);
  const uid = 'u_rev_1';
  const put = body => fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(uid), body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

  const [ra, rb] = await Promise.all([
    put({ state: { _ts: 100, workouts: [{ id: 'a1', d: '2026-09-01' }], routines: [] }, baseRev: 0 }),
    put({ state: { _ts: 100, workouts: [{ id: 'b1', d: '2026-09-01' }], routines: [] }, baseRev: 0 })
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = ra.status === 200 ? ra : rb;
  assert.equal(winner.body.rev, 1);

  const row = await h.row(uid);
  assert.equal(row.rev, 1);
  assert.equal(row.state.workouts.length, 1, 'exactly one write landed');
});
