/* Terms of Use / Privacy Policy acceptance at signup (ISO-1390). The acceptance is bound to the
   text the client can actually show, so the app sends the LEGAL_VERSION of its own bundle and the
   server refuses any other: no version at all is `terms-required`, a different one is
   `terms-version-stale` (an app built before the texts changed — "update the app", not "tick the
   box"). /api/config carries the current version for everyone, and /api/me says whether this
   account still has to accept it — an account imported from db.json at boot never did. Real
   server.js in a child, same harness as server-email-recovery.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const VERSION = '2026-10-25';
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

const mintSession = (uid, sv = 0) => {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);

function softPasskey() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  return {
    id,
    attestation(challenge, { origin = ORIGIN } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, raw, cose]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)
      ]);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] }
      };
    }
  };
}

async function startServer(t, { env = {}, users = [] } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    // APP_URL blanked for the same reason as server-email-recovery.test.js: a host .env must not
    // leak into the child.
    env: { ORIGIN, APP_URL: '', TRUST_PROXY: '1', INVITE_ONLY: '', ADMIN_UIDS: '', AUDIT_LOG: '1', ...env }
  });
  h.req = async (method, p, { body, cookie, ip = '198.51.100.1', headers = {} } = {}) => {
    const r = await fetch(`${h.api}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = r.headers.getSetCookie().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
    return { status: r.status, body: await r.json(), headers: r.headers, cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  h.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  h.pool = () => new pg.Pool({ connectionString: h.databaseUrl });
  h.user = async id => {
    const pool = h.pool();
    try { return (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null; }
    finally { await pool.end(); }
  };
  h.userCount = async () => {
    const pool = h.pool();
    try { return (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n; }
    finally { await pool.end(); }
  };
  return h;
}

const isIso = s => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

test('GET /api/config carries legal_version for everyone', async t => {
  const h = await startServer(t);
  const anon = await h.req('GET', '/api/config');
  assert.equal(anon.status, 200);
  assert.equal(anon.body.legal_version, VERSION);
});

test('register/options: no termsVersion → 400 terms-required; wrong type too; a stale one → terms-version-stale', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.40';
  const missing = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io' }, ip });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'update the app to accept the terms', code: 'terms-required' });
  for (const termsVersion of [42, '', '   ']) {
    const r = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io', termsVersion }, ip });
    assert.equal(r.status, 400, JSON.stringify(termsVersion));
    assert.equal(r.body.code, 'terms-required', JSON.stringify(termsVersion));
  }
  const stale = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io', termsVersion: '2020-01-01' }, ip });
  assert.equal(stale.status, 400);
  assert.deepEqual(stale.body, { error: 'these terms are not the current ones — update the app', code: 'terms-version-stale' });
  assert.equal(await h.userCount(), 0, 'none of these created a user');
  const denied = h.audit().filter(e => e.ev === 'auth.register.denied').map(e => e.msg);
  assert.ok(denied.includes('terms-required'));
  assert.ok(denied.includes('terms-version-stale'));
});

test('a passkey signup with the current version lands with both columns set', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.41';
  const key = softPasskey();
  const opt = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com', birthDate: '1990-05-05', termsVersion: VERSION }, ip });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  const r = await h.req('POST', '/api/register/verify', { body: { cid: opt.body.cid, credential: key.attestation(opt.body.options.challenge) }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await h.user(r.body.user.id);
  assert.equal(row.terms_accepted_version, VERSION);
  assert.notEqual(row.terms_accepted_at, null);

  const me = await h.req('GET', '/api/me', { cookie: r.cookie, ip });
  assert.equal(me.status, 200);
  assert.equal(me.body.needsTerms, false);
  assert.equal(me.body.termsVersion, VERSION);
  assert.ok(isIso(me.body.termsAcceptedAt), me.body.termsAcceptedAt);
});

test('register/password (PASSWORD_LOGIN=1) follows the same rule', async t => {
  const h = await startServer(t, { env: { PASSWORD_LOGIN: '1' } });
  const ip = '198.51.100.42';
  const password = 'correct horse battery staple';
  const missing = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password }, ip });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'terms-required');
  const stale = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password, termsVersion: '2020-01-01' }, ip });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.code, 'terms-version-stale');
  assert.equal(await h.userCount(), 0);
  const denied = h.audit().filter(e => e.ev === 'auth.register.denied').map(e => e.msg);
  assert.deepEqual(denied, ['terms-required', 'terms-version-stale'], 'audited like register/options');

  const ok = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password, birthDate: '1990-05-05', termsVersion: VERSION }, ip });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await h.user(ok.body.user.id);
  assert.equal(row.terms_accepted_version, VERSION);
  assert.notEqual(row.terms_accepted_at, null);

  const me = await h.req('GET', '/api/me', { cookie: ok.cookie, ip });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.body), ['user', 'termsVersion', 'termsAcceptedAt', 'needsTerms'],
    'the terms fields are there even with PASSWORD_LOGIN, unlike the e-mail ones');
  assert.equal(me.body.termsVersion, VERSION);
  assert.ok(isIso(me.body.termsAcceptedAt), me.body.termsAcceptedAt);
  assert.equal(me.body.needsTerms, false);
});

test('an account imported from db.json at boot needs the terms', async t => {
  const h = await startServer(t, { users: [{ id: 'u_old', name: 'Old', created: new Date().toISOString() }] });
  const me = await h.req('GET', '/api/me', { cookie: mintSession('u_old'), ip: '198.51.100.43' });
  assert.equal(me.status, 200);
  assert.equal(me.body.needsTerms, true);
  assert.equal(me.body.termsVersion, null);
  assert.equal(me.body.termsAcceptedAt, null);
});

test('account/terms/accept: session required, current version only, idempotent', async t => {
  const h = await startServer(t, { users: [{ id: 'u_old', name: 'Old', created: new Date().toISOString() }] });
  const ip = '198.51.100.44';
  const cookie = mintSession('u_old');
  const anon = await h.req('POST', '/api/account/terms/accept', { body: { version: VERSION }, ip });
  assert.equal(anon.status, 401);

  const stale = await h.req('POST', '/api/account/terms/accept', { body: { version: '2020-01-01' }, cookie, ip });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.code, 'terms-version-stale');
  const missing = await h.req('POST', '/api/account/terms/accept', { body: {}, cookie, ip });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'terms-required');
  assert.equal((await h.user('u_old')).terms_accepted_at, null, 'a refusal records nothing');

  const first = await h.req('POST', '/api/account/terms/accept', { body: { version: VERSION }, cookie, ip });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.termsVersion, VERSION);
  assert.ok(isIso(first.body.termsAcceptedAt), first.body.termsAcceptedAt);
  const row = await h.user('u_old');
  assert.equal(row.terms_accepted_version, VERSION);
  assert.equal(row.terms_accepted_at.toISOString(), first.body.termsAcceptedAt);

  const again = await h.req('POST', '/api/account/terms/accept', { body: { version: VERSION }, cookie, ip });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body, 'a second call answers the same acceptance');
  assert.equal((await h.user('u_old')).terms_accepted_at.toISOString(), first.body.termsAcceptedAt, 'not rewritten');

  const me = await h.req('GET', '/api/me', { cookie, ip });
  assert.equal(me.status, 200);
  assert.equal(me.body.needsTerms, false);

  const accepted = h.audit().filter(e => e.ev === 'account.terms.accept');
  assert.equal(accepted.length, 1, 'the second call does not audit again');
  assert.equal(accepted[0].uid, 'u_old');
  assert.equal(accepted[0].msg, VERSION);
});

test('billing/checkout refuses 403 terms-required before it looks at the e-mail', async t => {
  const created = new Date().toISOString();
  const h = await startServer(t, {
    // BILLING_ON needs both; no step below gets as far as createCheckoutSession, so Stripe is
    // never contacted with these dummies.
    env: { STRIPE_API_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
    users: [{ id: 'u_a', name: 'A', created }, { id: 'u_b', name: 'B', created }]
  });
  const ip = '198.51.100.45';
  const pool = h.pool();
  try { await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', ['u_a']); }
  finally { await pool.end(); }

  const a = await h.req('POST', '/api/billing/checkout', { body: { plan: 'monthly' }, cookie: mintSession('u_a'), ip });
  assert.equal(a.status, 403);
  assert.equal(a.body.code, 'terms-required');

  const cookieB = mintSession('u_b');
  const b = await h.req('POST', '/api/billing/checkout', { body: { plan: 'monthly' }, cookie: cookieB, ip });
  assert.equal(b.status, 403);
  assert.equal(b.body.code, 'terms-required', 'the terms come before the e-mail');

  const accept = await h.req('POST', '/api/account/terms/accept', { body: { version: VERSION }, cookie: cookieB, ip });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  const after = await h.req('POST', '/api/billing/checkout', { body: { plan: 'monthly' }, cookie: cookieB, ip });
  assert.equal(after.status, 403);
  assert.equal(after.body.code, 'email-unverified', 'past the terms gate, the e-mail one still holds before Stripe');
});
