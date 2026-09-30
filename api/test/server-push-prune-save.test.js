/* Pruning a dead subscription writes db.json. When ./data cannot be written (disk full, read-only
   mount, EIO) that write fails — and almost nobody awaits sendPush(): the rest-timer setTimeout
   and the Coach proposal hook both call it and walk away, so the throw used to become an unhandled
   rejection and the process exited (losing every in-memory rest timer and pairing on the way out).
   The awaited caller, POST /api/push/test, turned the same failure into a 500 for a push that had
   in fact gone out.

   The subscription below has a private endpoint, so pushEndpointError prunes it without opening a
   socket: no outbound network, and the prune is deterministic. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, spawnApi, seedUserState } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = { Cookie: `gymsid=${mintSession('u_test_1')}` };

async function startServer(t) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_test_1', name: 'One', created: new Date().toISOString() }],
    creds: [], invites: [],
    // a private address: refused at send time and pruned, no socket opened
    subs: [{ userId: 'u_test_1', endpoint: 'https://10.1.2.3/push/abc', keys: { p256dh: 'p', auth: 'a' }, created: new Date().toISOString() }]
  }));
  // node:test runs t.after hooks in registration order, so this has to be registered before
  // spawnApi's own t.after (kill + rmSync) — otherwise rmSync hits the directory while it is
  // still the 0500 a test left it in.
  t.after(() => { try { fs.chmodSync(dataDir, 0o700); } catch { /* already restored */ } });
  // AUDIT_LOG off and the reminder tick parked: the only write this test wants to fail is the prune's
  const h = await spawnApi(t, { dataDir, env: { AUDIT_LOG: '0', REMINDER_TICK_MS: '100000' } });
  await seedUserState(h.databaseUrl, 'u_test_1', { lang: 'en', workouts: [], routines: [] });
  h.exited = null;
  h.child.on('exit', (code, signal) => { h.exited = { code, signal }; });
  return h;
}
const unwritable = h => fs.chmodSync(h.dataDir, 0o500);
// Root writes through a 0500 directory, so the failure these tests need cannot be made as root
// (the GitLab CI container runs as root); they are skipped there rather than failing for it.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skip = asRoot ? 'running as root: a 0500 directory is still writable' : false;
const writable = h => fs.chmodSync(h.dataDir, 0o700);

test('an unwritable ./data cannot take the process down through the rest timer nobody awaits', { skip }, async t => {
  const h = await startServer(t);
  unwritable(h);
  const r = await fetch(`${h.api}/api/push/rest-timer`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' },
    body: JSON.stringify({ seconds: 1 })
  });
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 2500));     // the timer fires at 1 s, then prunes
  writable(h);

  assert.equal(h.exited, null, `the api exited on a failed prune save:\n${h.log}`);
  assert.equal((await fetch(`${h.api}/api/health`)).status, 200, 'still serving');
  assert.match(h.log, /push: could not save db.json/, 'and it said so, once, without a stack');
});

test('a push that was delivered is a 200 even when only the prune save failed', { skip }, async t => {
  const h = await startServer(t);
  unwritable(h);
  const r = await fetch(`${h.api}/api/push/test`, {
    method: 'POST', headers: { ...cookie, Origin: 'http://localhost:8080' }
  });
  assert.equal(r.status, 200, 'the awaited caller does not report the bookkeeping failure');
  assert.deepEqual(await r.json(), { ok: true });
  writable(h);
  assert.equal(h.exited, null, `the api exited on a failed prune save:\n${h.log}`);
});
