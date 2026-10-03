/* ISO-1447 (Phase 4, LGPD): self-service account deletion (DELETE /api/account) — the same
   deleteAccount helper admin/user/delete uses (server-admin-delete.test.js), reached by someone
   removing their own account instead of an admin removing someone else's. Real server.js in a
   child, real PostgreSQL; the authenticator is the same software P-256 key server-passkeys.test.js
   uses, since proveOwner takes the exact same proof here as it does everywhere else. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { hashPassword } from '../password.js';
import { tempData, spawnApi, seedUserState } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

// Same construction as server.js's makeSession(): `uid:exp:sv` (a payload with no 4th field —
// the session-id this account deletion also has to invalidate, via the row itself going away,
// not just this signature).
const mintSession = (uid, sv = 0) => {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

// Trimmed copy of server-passkeys.test.js's software authenticator — this file only ever needs
// an existing passkey to prove ownership with, never to register a new one.
const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  let counter = 0;
  return {
    id,
    row: (userId, extra = {}) => ({ id, userId, publicKey: cose.toString('base64url'), counter: 0, transports: ['internal'], ...extra }),
    assertion(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null }
      };
    }
  };
}

const GOOD = 'correct horse battery staple';
let pwHash;
before(async () => { pwHash ??= await hashPassword(GOOD); });

const user = (id, name, extra = {}) => ({ id, name, created: new Date().toISOString(), ...extra });
const withPassword = (id, name, extra = {}) => user(id, name, { pw: { h: pwHash, set: new Date().toISOString() }, ...extra });

async function startServer(t, { users = [], creds = [], env = {} } = {}) {
  pwHash ??= await hashPassword(GOOD);
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users, creds, subs: [], invites: [{ code: 'CODE1', usedBy: users.find(u => u.invitedBy === 'CODE1')?.id, usedAt: new Date().toISOString() }]
  }));
  const h = await spawnApi(t, { dataDir, env: { ORIGIN, PASSWORD_LOGIN: '1', ADMIN_UIDS: 'u_adm_1', AUDIT_LOG: '1', ...env } });
  h.req = async (method, p, { body, cookie, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = r.headers.getSetCookie().find(c => c.startsWith('gymsid='));
    return { status: r.status, body: await r.json(), cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  h.stepUp = async key => {
    const { cid, options } = (await h.req('POST', '/api/login/options', { body: {} })).body;
    return { cid, credential: key.assertion(options.challenge) };
  };
  h.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  h.pool = () => new pg.Pool({ connectionString: h.databaseUrl });
  h.row1 = async (sql, params) => { const p = h.pool(); try { return (await p.query(sql, params)).rows[0] || null; } finally { await p.end(); } };
  h.rows = async (sql, params) => { const p = h.pool(); try { return (await p.query(sql, params)).rows; } finally { await p.end(); } };
  h.dataDir = dataDir;
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  return h;
}

// Every table with a direct reference to a user row, so "everything is gone" is checked by
// enumeration, not by guessing which tables matter.
const USER_TABLES = [
  ['users', 'id'], ['passkeys', 'user_id'], ['user_state', 'user_id'], ['sessions', 'user_id'],
  ['push_subscriptions', 'user_id'], ['device_links', 'user_id'], ['subscriptions', 'user_id'],
  ['email_tokens', 'user_id']
];

test('self-delete: zero rows anywhere, nothing left on disk, and the old session dies at once', async t => {
  const key = softPasskey();
  const h = await startServer(t, {
    users: [withPassword('u_vic_1', 'Mallory', { invitedBy: 'CODE1' })],
    creds: [key.row('u_vic_1')]
  });
  await seedUserState(h.databaseUrl, 'u_vic_1', { unit: 'kg', workouts: [], _rev: 3 }, 3);
  // A second push subscription, a device link and an e-mail token — the store.js tables the
  // admin-delete test does not also populate for the account actually being deleted.
  const pool = h.pool();
  await pool.query("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ('u_vic_1', 'https://push/victim', 'p', 'a')");
  await pool.query("INSERT INTO device_links (hash, user_id, expires_at) VALUES ('deadbeef', 'u_vic_1', now() + interval '10 minutes')");
  await pool.query("INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ('u_vic_1', 'recover', 'tokhash', now() + interval '15 minutes')");
  await pool.end();

  // Disk: an uploaded file, the Coach credential (coachConfig.profileAuthFile) and the Coach
  // per-profile record (jobs.js's userFile, under DATA_DIR/coach/).
  const uploadDir = path.join(h.dataDir, 'uploads', 'u_vic_1');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'deadbeef'.repeat(8) + '.webp'), 'x');
  fs.writeFileSync(path.join(h.dataDir, 'coach-auth-u_vic_1.json'), JSON.stringify({ daily: null }));
  fs.mkdirSync(path.join(h.dataDir, 'coach'), { recursive: true });
  fs.writeFileSync(path.join(h.dataDir, 'coach', 'u_vic_1.json'), JSON.stringify({ daily: null, current: null, pending: null, history: [] }));

  const cookieA = mintSession('u_vic_1'), cookieB = mintSession('u_vic_1');
  // Two "devices" signed in under the same account.
  assert.equal((await h.req('GET', '/api/me', { cookie: cookieA })).status, 200);
  assert.equal((await h.req('GET', '/api/me', { cookie: cookieB })).status, 200);

  const del = await h.req('DELETE', '/api/account', { body: await h.stepUp(key), cookie: cookieA });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(del.body.ok);
  assert.equal(del.cookie, 'gymsid=', 'the session cookie is cleared');

  for (const [table, col] of USER_TABLES) {
    assert.deepEqual(await h.rows(`SELECT 1 FROM ${table} WHERE ${col} = $1`, ['u_vic_1']), [], `${table}.${col} still has rows`);
  }
  // The invite code stays burned (migrations/003 — not this issue's to change).
  assert.equal((await h.row1('SELECT used_by FROM invites WHERE code = $1', ['CODE1']))?.used_by, 'u_vic_1');

  assert.equal(fs.existsSync(uploadDir), false, 'uploaded files are gone');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'coach-auth-u_vic_1.json')), false, 'the Coach credential is gone');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'coach', 'u_vic_1.json')), false, "the Coach per-profile record is gone");

  // Both cookies, and the passkey itself.
  assert.equal((await h.req('GET', '/api/me', { cookie: cookieA })).status, 401);
  assert.equal((await h.req('GET', '/api/me', { cookie: cookieB })).status, 401);
  const lo = (await h.req('POST', '/api/login/options', { body: {} })).body;
  assert.equal((await h.req('POST', '/api/login/verify', { body: { cid: lo.cid, credential: key.assertion(lo.options.challenge) } })).status, 404);

  assert.ok(h.audit().some(e => e.ev === 'account.delete' && e.uid === 'u_vic_1' && !('name' in e)), JSON.stringify(h.audit()));
  assert.equal(h.stackFrames(), 0, `stack traces in the log:\n${h.log}`);
});

test('self-delete needs real proof: a bare session, a wrong password and another account’s passkey are all refused', async t => {
  const mine = softPasskey(), theirs = softPasskey();
  const h = await startServer(t, {
    users: [withPassword('u_vic_1', 'Mallory'), user('u_oth_1', 'Oscar')],
    creds: [mine.row('u_vic_1'), theirs.row('u_oth_1')]
  });
  const cookie = mintSession('u_vic_1');
  const bare = await h.req('DELETE', '/api/account', { body: {}, cookie });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.code, 'current-required');

  const wrong = await h.req('DELETE', '/api/account', { body: { current: 'not it' }, cookie });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'current-wrong');

  const stolen = await h.req('DELETE', '/api/account', { body: await h.stepUp(theirs), cookie });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.body.code, 'passkey');

  // Nothing above actually removed the account.
  assert.ok(await h.row1('SELECT 1 FROM users WHERE id = $1', ['u_vic_1']));
  const ok = await h.req('DELETE', '/api/account', { body: { current: GOOD }, cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('the last admin cannot delete themselves; an admin who is not the last one can', async t => {
  const h = await startServer(t, {
    users: [withPassword('u_adm_1', 'Adminna', { admin: true })]
  });
  const refused = await h.req('DELETE', '/api/account', { body: { current: GOOD }, cookie: mintSession('u_adm_1') });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'last-admin');
  assert.ok(await h.row1('SELECT 1 FROM users WHERE id = $1', ['u_adm_1']));

  const h2 = await startServer(t, {
    users: [withPassword('u_adm_1', 'Adminna', { admin: true }), withPassword('u_adm_2', 'Second', { admin: true })],
    env: { ADMIN_UIDS: 'u_adm_1,u_adm_2' }
  });
  const ok = await h2.req('DELETE', '/api/account', { body: { current: GOOD }, cookie: mintSession('u_adm_2') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await h2.row1('SELECT 1 FROM users WHERE id = $1', ['u_adm_2']), null);
  assert.ok(await h2.row1('SELECT 1 FROM users WHERE id = $1', ['u_adm_1']));
});

test('an account with no subscription (read-only under the billing gate) can still delete itself', async t => {
  const h = await startServer(t, {
    users: [withPassword('u_vic_1', 'Mallory')],
    env: { STRIPE_API_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_test_x' }
  });
  const cookie = mintSession('u_vic_1');
  // Read-only: no subscription, so a write is refused…
  const put = await h.req('PUT', '/api/data', { body: { state: { workouts: [] } }, cookie });
  assert.equal(put.status, 402);
  // …but deleting the account is not a write the 402 gate was ever asked about.
  const del = await h.req('DELETE', '/api/account', { body: { current: GOOD }, cookie });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('Stripe: an active subscription is cancelled and the customer deleted; a Stripe failure still completes the local delete, and a later retry clears the rest', async t => {
  const calls = [];
  let customerDeleteFails = false;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url === '/v1/subscriptions/sub_vic') {
        return respond({ id: 'sub_vic', object: 'subscription', schedule: null });
      }
      if (req.method === 'DELETE' && req.url === '/v1/subscriptions/sub_vic') {
        return respond({ id: 'sub_vic', object: 'subscription', status: 'canceled' });
      }
      if (req.method === 'DELETE' && req.url === '/v1/customers/cus_vic') {
        return customerDeleteFails
          ? respond({ error: { message: 'internal error', type: 'api_error' } }, 500)
          : respond({ id: 'cus_vic', object: 'customer', deleted: true });
      }
      return respond({ error: { message: 'unexpected ' + req.method + ' ' + req.url, type: 'invalid_request_error' } }, 404);
      function respond(json, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); }
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => mock.close());
  const port = mock.address().port;

  const h = await startServer(t, {
    users: [withPassword('u_vic_1', 'Mallory')],
    env: { STRIPE_API_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_test_x', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port) }
  });
  const pool = h.pool();
  await pool.query("UPDATE users SET stripe_customer_id = 'cus_vic' WHERE id = 'u_vic_1'");
  await pool.query("INSERT INTO subscriptions (id, user_id, data) VALUES ('sub_vic', 'u_vic_1', $1)", [{ status: 'active', plan: 'monthly' }]);
  await pool.end();

  const del = await h.req('DELETE', '/api/account', { body: { current: GOOD }, cookie: mintSession('u_vic_1') });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(calls.includes('DELETE /v1/subscriptions/sub_vic'), calls.join(', '));
  assert.ok(calls.includes('DELETE /v1/customers/cus_vic'), calls.join(', '));
  // Success: nothing left pending.
  assert.deepEqual(await h.rows('SELECT 1 FROM stripe_cleanup'), []);

  // Now the failure path, on a second account, with the customer delete failing once.
  const h2 = await startServer(t, {
    users: [withPassword('u_vic_2', 'Nadia')],
    env: { STRIPE_API_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_test_x', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port) }
  });
  const pool2 = h2.pool();
  await pool2.query("UPDATE users SET stripe_customer_id = 'cus_vic' WHERE id = 'u_vic_2'");
  await pool2.query("INSERT INTO subscriptions (id, user_id, data) VALUES ('sub_vic', 'u_vic_2', $1)", [{ status: 'active', plan: 'monthly' }]);
  await pool2.end();
  customerDeleteFails = true;
  const del2 = await h2.req('DELETE', '/api/account', { body: { current: GOOD }, cookie: mintSession('u_vic_2') });
  assert.equal(del2.status, 200, 'the local account deletion completes even though Stripe just failed');
  assert.equal(await h2.row1('SELECT 1 FROM users WHERE id = $1', ['u_vic_2']), null);
  const pending = await h2.row1('SELECT customer_id, subscription_ids FROM stripe_cleanup', []);
  assert.equal(pending.customer_id, 'cus_vic');
  assert.deepEqual(pending.subscription_ids, ['sub_vic']);

  // The periodic retry (billing.js's tickStripeCleanup, called directly here rather than waiting
  // on the real 15-minute setInterval) completes it once Stripe is reachable again. This runs in
  // the test's own process, which has never called billing.js's getStripe() before — unlike the
  // env passed to spawnApi above, these only take effect once set on this process directly.
  customerDeleteFails = false;
  process.env.STRIPE_API_KEY = 'sk_test_unused';
  process.env.STRIPE_API_HOST = '127.0.0.1';
  process.env.STRIPE_API_PORT = String(port);
  const { tickStripeCleanup } = await import('../billing.js');
  const retryPool = h2.pool();
  await tickStripeCleanup(retryPool);
  assert.deepEqual((await retryPool.query('SELECT 1 FROM stripe_cleanup')).rows, []);
  await retryPool.end();
});
