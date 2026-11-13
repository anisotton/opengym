/* The Coach's admin routes (coach/routes.js) are handed server.js's readSession/requireAdmin, which
   are async since ISO-1403 moved users into PostgreSQL. Called without await, each returns a
   Promise, which is always truthy: `if (!requireAdmin(req, res)) return` then never returned, and
   anyone, signed in or not, could read and rewrite the instance's Coach config. These go through
   the real server so the helpers are the real async ones, not the unit tests' synchronous mocks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ADMIN = 'u_coach_admin';
const PLAIN = 'u_coach_plain';
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

async function startServer(t) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: ADMIN, name: 'Admin', created: now }, { id: PLAIN, name: 'Plain', created: now }],
    creds: [], subs: [], invites: []
  }));
  fs.writeFileSync(path.join(dataDir, 'coach.json'), JSON.stringify({ enabled: false, provider: 'fixture' }));
  const h = await spawnApi(t, { dataDir, env: { ADMIN_UIDS: ADMIN, COACH_DISABLED: '' } });
  return { ...h, dataDir };
}
const coachCfg = dataDir => JSON.parse(fs.readFileSync(path.join(dataDir, 'coach.json'), 'utf8'));
const send = (h, method, p, cookie, body) => fetch(h.api + p, {
  method,
  headers: { ...(cookie ? { Cookie: `gymsid=${cookie}` } : {}), 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

for (const [who, cookie, status] of [['a stranger', null, 401], ['a signed-in non-admin', mint(PLAIN), 403]]) {
  test(`${who} cannot read or change the Coach admin config`, async t => {
    const h = await startServer(t);
    assert.equal((await send(h, 'GET', '/api/admin/coach', cookie)).status, status);
    const r = await send(h, 'POST', '/api/admin/coach/config', cookie, { enabled: true });
    assert.equal(r.status, status);
    assert.equal(coachCfg(h.dataDir).enabled, false, 'the config on disk is untouched');
    for (const p of ['/api/admin/coach/test', '/api/admin/coach/models', '/api/admin/coach/disconnect']) {
      assert.equal((await send(h, 'POST', p, cookie, {})).status, status, p);
    }
  });
}

test('an admin still reads and changes the Coach config', async t => {
  const h = await startServer(t);
  assert.equal((await send(h, 'GET', '/api/admin/coach', mint(ADMIN))).status, 200);
  const r = await send(h, 'POST', '/api/admin/coach/config', mint(ADMIN), { enabled: true });
  assert.equal(r.status, 200);
  assert.equal(coachCfg(h.dataDir).enabled, true);
});

test('the Coach user routes answer 401 without a session instead of acting for nobody', async t => {
  const h = await startServer(t);
  for (const [m, p] of [['GET', '/api/coach/status'], ['POST', '/api/coach/forget'], ['GET', '/api/coach/account'], ['GET', '/api/coach/disclosure']]) {
    const r = await send(h, m, p, null, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});
