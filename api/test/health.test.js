/* ISO-1400: /api/health is public (no session, polled by an external uptime monitor) and now
 * pings the database instead of just answering 200 unconditionally — a down database used to
 * look identical to a healthy server, so the compose/Coolify healthcheck could never actually
 * tell the two apart. It also used to report `users: db.users.length`, a public account count a
 * health probe has no business leaking. Needs a real PostgreSQL — see test:pg. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnApi } from './helpers.mjs';

test('GET /api/health reports db:"ok" and never the account count', async t => {
  const { api } = await spawnApi(t);
  const res = await fetch(`${api}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, db: 'ok', writable: true });
  assert.ok(!('users' in body), 'the account count must not be in the public health response');
});

test('GET /api/health answers 503 once the database is gone', async t => {
  const { api, dropDatabase } = await spawnApi(t);
  await dropDatabase();
  const res = await fetch(`${api}/api/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, db: 'down', writable: true });
});
