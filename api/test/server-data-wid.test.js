/* Every write of /api/data gets a write id (`_wid`) and keeps its ancestors' (`_wids`): after the
   data directory went back in time (a restored backup, a write lost to a power cut) the same `_rev`
   names a different document, and a client quoting the id it last saw (`baseWid`) is refused
   instead of overwriting it. (QA 2026-10-06.) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempData, spawnApi, testPool } from './helpers.mjs';

// ---- the real server -------------------------------------------------------------------------
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
test('PUT /api/data: write ids, their ancestry, and a stale write id refused at a reused revision', async t => {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, { dataDir });
  const base = h.api;
  // The profile's row, where the state file used to be (ISO-1403): the document and its revision.
  const row = async () => { const p = testPool(h.databaseUrl); try { return (await p.query('SELECT state, rev::int AS rev FROM user_state WHERE user_id = $1', ['u1'])).rows[0]; } finally { await p.end(); } };
  const headers = { Cookie: `gymsid=${mintSession('u1')}`, 'Content-Type': 'application/json' };
  const put = async body => { const r = await fetch(`${base}/api/data`, { method: 'PUT', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  // A nightly backup put back: the row as it was, revision and all.
  const restore = async saved => { const p = testPool(h.databaseUrl); try { await p.query('UPDATE user_state SET state = $1, rev = $2 WHERE user_id = $3', [saved.state, saved.rev, 'u1']); } finally { await p.end(); } };

  const a = await put({ state: { _ts: 1, workouts: [], routines: [] }, baseRev: 0 });
  assert.equal(a.status, 200);
  const backup = await row();   // the nightly backup, at rev 1
  const b = await put({ state: { _ts: 2, workouts: [{ id: 'LegDay', d: '2026-10-01' }], routines: [] }, baseRev: 1, baseWid: a.body.wid });
  assert.equal(b.status, 200);
  assert.notEqual(b.body.wid, a.body.wid);
  assert.deepEqual((await row()).state._wids, [a.body.wid]);
  // restored, and another device writes rev 2 again
  await restore(backup);
  const other = await put({ state: { _ts: 3, workouts: [{ id: 'B', d: '2026-10-02' }], routines: [] }, baseRev: 1, baseWid: a.body.wid });
  assert.equal(other.status, 200);
  assert.equal(other.body.rev, 2);
  // the first device, at "rev 2" of the lost document, is refused with the current one
  const stale = await put({ state: { _ts: 4, workouts: [], routines: [] }, baseRev: 2, baseWid: b.body.wid });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.state.workouts.map(w => w.id), ['B']);
  // its rev check sees the other write id
  const rev = await (await fetch(`${base}/api/data/rev`, { headers })).json();
  assert.deepEqual(rev, { rev: 2, wid: other.body.wid });
});
