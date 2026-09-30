// GET /api/data/rev hands out the revision alone — what a signed-in client polls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = 'test-secret-rev-endpoint';
const uid = 'u_rev_1';
const cookie = () => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

test('GET /api/data/rev tracks PUT /api/data', async t => {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: uid, name: 'R', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  const { api } = await spawnApi(t, { dataDir });
  assert.equal((await fetch(`${api}/api/health`)).status, 200);

  const h = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  assert.equal((await fetch(`${api}/api/data/rev`)).status, 401);
  assert.deepEqual(await (await fetch(`${api}/api/data/rev`, { headers: h })).json(), { rev: 0 });
  const put = await fetch(`${api}/api/data`, { method: 'PUT', headers: h, body: JSON.stringify({ state: { workouts: [], routines: [] }, baseRev: 0 }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await fetch(`${api}/api/data/rev`, { headers: h })).json(), { rev: 1 });
});
