/* POST /api/client-event (ISO-1480): the beacon that makes a WebAuthn ceremony the browser
   refused outright — an untrusted certificate, no screen lock, a non-secure origin — show up in
   audit.log instead of looking like "nothing happened". Real server.js in a child, same shape as
   server-email-recovery.test.js; this route needs no session and no passkey crypto, so the setup
   here is deliberately smaller than that file's. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';

async function startServer(t, { env = {} } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, { dataDir, env: { ORIGIN, TRUST_PROXY: '1', AUDIT_LOG: '1', ...env } });
  h.req = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: parsed };
  };
  h.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  return h;
}

test('a well-formed beacon writes one auth.webauthn.fail line, with the flow/kind/timing it sent', async t => {
  const h = await startServer(t);
  const r = await h.req('POST', '/api/client-event', {
    body: { flow: 'login', step: 'assertion', kind: 'cert-untrusted', elapsedMs: 42, isSecureContext: true },
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36' }
  });
  assert.equal(r.status, 200);
  const line = h.audit().find(e => e.ev === 'auth.webauthn.fail');
  assert.ok(line, 'expected an auth.webauthn.fail line');
  assert.equal(line.ok, false);
  assert.equal(line.act, 'login:assertion');
  assert.match(line.msg, /^cert-untrusted elapsedMs=42 secure=true ua=Chrome\/Android$/);
});

test('an unrecognized flow/kind is clamped to the allowlist, and step has anything but [a-z0-9-] stripped', async t => {
  const h = await startServer(t);
  await h.req('POST', '/api/client-event', {
    body: { flow: 'drop-tables', step: '<script>evil', kind: 'something-made-up', elapsedMs: 10 }
  });
  const line = h.audit().find(e => e.ev === 'auth.webauthn.fail');
  assert.ok(line);
  // flow/kind are a hard enum (unrecognized -> unknown/other); step only loses characters outside
  // [a-z0-9-], so the tags around the stripped text are gone but the letters survive.
  assert.equal(line.act, 'unknown:scriptevil');
  assert.match(line.msg, /^other elapsedMs=10/);
});

test('a missing or malformed body still answers 200 and logs something, not a 500', async t => {
  const h = await startServer(t);
  const empty = await h.req('POST', '/api/client-event', { body: {} });
  assert.equal(empty.status, 200);
  const garbage = await h.req('POST', '/api/client-event', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(garbage.status, 200);
  assert.equal(h.audit().filter(e => e.ev === 'auth.webauthn.fail').length, 2);
});

test('elapsedMs is clamped into [0, 60000] rather than logged as given', async t => {
  const h = await startServer(t);
  await h.req('POST', '/api/client-event', { body: { flow: 'register', kind: 'other', elapsedMs: -5 } });
  await h.req('POST', '/api/client-event', { body: { flow: 'register', kind: 'other', elapsedMs: 999999 } });
  const [a, b] = h.audit().filter(e => e.ev === 'auth.webauthn.fail');
  assert.match(a.msg, /elapsedMs=0\b/);
  assert.match(b.msg, /elapsedMs=60000\b/);
});

test('the route is rate-limited by the shared burst budget, like every other unauthenticated route', async t => {
  const h = await startServer(t);
  let sawTooMany = false;
  for (let i = 0; i < 70 && !sawTooMany; i++) {
    const r = await h.req('POST', '/api/client-event', { body: { flow: 'login', kind: 'other' } });
    if (r.status === 429) sawTooMany = true;
  }
  assert.ok(sawTooMany, 'expected a 429 once the per-address burst budget (60/min) was spent');
});
