/* "Sign in with Google" (ISO-1597): the routes in server.js, against a real server.js in a
 * child (the same harness as server-passkeys.test.js) and a tiny in-process fake Google — just
 * enough of discovery + token + JWKS to drive oauth-google.js, no real network. The RSA key pair
 * used to sign fake ID tokens is generated fresh per test file run; GOOGLE_OAUTH_TEST_DISCOVERY_URL
 * (documented as test-only in oauth-google.js) is the one seam that points the server at it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { hashPassword } from '../password.js';
import { tempData, spawnApi } from './helpers.mjs';

const ORIGIN = 'http://localhost:8080';
const SECRET = 'a'.repeat(64); // tempData()'s own fixed test secret (helpers.mjs)
const TERMS = '2026-10-18';
const ADULT_BIRTH = '1990-05-05';

const b64u = v => Buffer.from(v).toString('base64url');

/* ---------- a signed session cookie, forged directly against the known test secret — same idea
 * as server-passkeys.test.js's mintSession, with no real login ceremony needed. */
function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
// server.js's own signJSON: sign(base64url(JSON)) — forged here to build an expired/tampered
// gauth_oauth cookie without going through a real /start.
function signJSONFor(obj) {
  const payload = b64u(JSON.stringify(obj));
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/* ---------- a minimal JWT signer, hand-rolled the same way oauth-google.js verifies: no new
 * dependency for either side of this. */
function signJwt(claims, { kid, privateKey, alg = 'RS256' }) {
  const header = { alg, kid, typ: 'JWT' };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  if (alg === 'none') return `${signingInput}.`;
  const sig = alg === 'HS256'
    ? crypto.createHmac('sha256', String(privateKey)).update(signingInput).digest()
    : crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

function baseClaims({
  sub = 'google-sub-1', email = 'ada@example.com', name = 'Ada Lovelace', emailVerified = true,
  nonce, aud = 'test-client-id', iss = 'https://accounts.google.com', skewSec = 0
} = {}) {
  const now = Math.floor(Date.now() / 1000) - skewSec;
  return { iss, aud, sub, email, email_verified: emailVerified, name, nonce, iat: now, exp: now + 3600 };
}

/* ---------- the fake Google: discovery, jwks (mutable key set + Cache-Control) and token
 * (single-use codes by default, id_token supplied per test). */
function fakeGoogleServer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };
  const state = { keys: [jwk], cacheControl: 'max-age=3600', nextIdToken: null, usedCodes: new Set(), rejectReusedCode: true };
  let port;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const send = (code, obj, headers = {}) => {
        const s = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(s);
      };
      if (req.url === '/.well-known/openid-configuration') {
        return send(200, {
          issuer: 'https://accounts.google.com',
          authorization_endpoint: `http://127.0.0.1:${port}/o/authorize`,
          token_endpoint: `http://127.0.0.1:${port}/token`,
          jwks_uri: `http://127.0.0.1:${port}/jwks`
        });
      }
      if (req.url === '/jwks') return send(200, { keys: state.keys }, { 'Cache-Control': state.cacheControl });
      if (req.url === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const code = params.get('code');
        if (state.rejectReusedCode) {
          if (state.usedCodes.has(code)) return send(400, { error: 'invalid_grant' });
          state.usedCodes.add(code);
        }
        const idToken = typeof state.nextIdToken === 'function' ? state.nextIdToken(params) : state.nextIdToken;
        if (!idToken) return send(400, { error: 'test did not set nextIdToken' });
        return send(200, { id_token: idToken, access_token: 'fake-access', token_type: 'Bearer' });
      }
      send(404, { error: 'not found' });
    });
  });
  return {
    server, state, privateKey, jwk,
    async listen() { port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); return port; },
    base: () => `http://127.0.0.1:${port}`
  };
}

/* ---------- parsing the HashRouter redirect every google route answers with. */
function parseHashRedirect(location) {
  const url = new URL(location);
  const frag = url.hash.slice(1);
  const qIdx = frag.indexOf('?');
  return { path: qIdx < 0 ? frag : frag.slice(0, qIdx), params: new URLSearchParams(qIdx < 0 ? '' : frag.slice(qIdx + 1)) };
}
function cookieNamed(res, name) {
  const found = (res.headers.getSetCookie?.() || []).find(c => c.startsWith(name + '='));
  return found ? found.split(';')[0] : null;
}
function cookieCleared(res, name) {
  return (res.headers.getSetCookie?.() || []).some(c => c.startsWith(name + '=;') || /Max-Age=0/.test(c) && c.startsWith(name + '='));
}

let pwHash;

async function startServer(t, google, { env = {}, users = [] } = {}) {
  pwHash ??= await hashPassword('correct horse battery staple');
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  await google.listen();
  const base = google.base();
  t.after(() => google.server.close());
  const h = await spawnApi(t, {
    dataDir,
    env: {
      ORIGIN, TRUST_PROXY: '1', AUDIT_LOG: '1',
      GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_OAUTH_TEST_DISCOVERY_URL: `${base}/.well-known/openid-configuration`,
      ...env
    }
  });
  h.raw = (method, p, { body, cookie, headers = {} } = {}) => fetch(`${h.api}${p}`, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(cookie !== undefined ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  h.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  h.pool = () => new pg.Pool({ connectionString: h.databaseUrl });
  h.insertIdentity = async ({ subject, userId, email = null }) => {
    const p = h.pool();
    try { await p.query('INSERT INTO oauth_identities (provider, subject, user_id, email) VALUES ($1,$2,$3,$4)', ['google', subject, userId, email]); }
    finally { await p.end(); }
  };
  h.identity = async userId => {
    const p = h.pool();
    try { const { rows } = await p.query('SELECT * FROM oauth_identities WHERE user_id = $1 AND provider = $2', [userId, 'google']); return rows[0] || null; }
    finally { await p.end(); }
  };
  h.verifyEmail = async userId => {
    const p = h.pool();
    try { await p.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]); }
    finally { await p.end(); }
  };
  h.userRow = async id => {
    const p = h.pool();
    try { const { rows } = await p.query('SELECT * FROM users WHERE id = $1', [id]); return rows[0]; }
    finally { await p.end(); }
  };
  return h;
}

// GET /api/auth/google/start?intent=login|signup → the authorization URL, and the signed cookie
// the callback will check itself against.
async function beginStart(h, intent, { cookie } = {}) {
  const r = await h.raw('GET', `/api/auth/google/start?intent=${intent}`, { cookie });
  const loc = new URL(r.headers.get('location'));
  return { res: r, loc, state: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce'), oauthCookie: cookieNamed(r, 'gauth_oauth') };
}

/* =================================================================== without GOOGLE_* set */

test('without GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, every google route is a 404 and /api/config is unchanged', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  for (const [method, p] of [
    ['GET', '/api/auth/google/start?intent=login'],
    ['GET', '/api/auth/google/callback'],
    ['POST', '/api/account/google/start'],
    ['POST', '/api/register/google'],
    ['DELETE', '/api/account/google']
  ]) {
    const r = await h.raw(method, p);
    assert.equal(r.status, 404, `${method} ${p}`);
  }
  const cfg = await h.raw('GET', '/api/config');
  const body = await cfg.json();
  assert.equal('google_login' in body, false);
});

test('only one of GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET set is still off', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { env: { GOOGLE_CLIENT_SECRET: '' } });
  assert.equal((await h.raw('GET', '/api/auth/google/start?intent=login')).status, 404);
});

/* =================================================================== GET /api/auth/google/start */

test('GET /api/auth/google/start redirects to the discovered authorization endpoint with PKCE/state/nonce', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { res, loc, oauthCookie } = await beginStart(h, 'login');
  assert.equal(res.status, 302);
  assert.equal(loc.origin + loc.pathname, `${google.base()}/o/authorize`);
  assert.equal(loc.searchParams.get('client_id'), 'test-client-id');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state'));
  assert.ok(loc.searchParams.get('nonce'));
  assert.ok(loc.searchParams.get('code_challenge'));
  assert.ok(oauthCookie);
});

test('GET /api/auth/google/start?intent=reauth needs a session and an existing link', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  assert.equal((await h.raw('GET', '/api/auth/google/start?intent=reauth')).status, 401);
  const cookie = mintSession('u1');
  const noLink = await h.raw('GET', '/api/auth/google/start?intent=reauth', { cookie });
  assert.equal(noLink.status, 400);
  assert.equal((await noLink.json()).code, 'not-linked');
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const ok = await h.raw('GET', '/api/auth/google/start?intent=reauth', { cookie });
  assert.equal(ok.status, 302);
});

test('an invalid intent is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const r = await h.raw('GET', '/api/auth/google/start?intent=nonsense');
  assert.equal(r.status, 400);
});

/* =================================================================== callback: the happy paths */

test('login: no account matches at all — a pending signup, finished by POST /api/register/google', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-new', email: 'new@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });

  const cb = await h.raw('GET', `/api/auth/google/callback?code=abc&state=${state}`, { cookie: oauthCookie });
  assert.equal(cb.status, 302);
  const { path, params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(path, '/entrar');
  assert.equal(params.get('google'), 'signup');
  assert.equal(params.get('email'), 'new@example.com');
  assert.equal(params.get('name'), 'Ada Lovelace');
  assert.ok(cookieCleared(cb, 'gauth_oauth'));
  const signupCookie = cookieNamed(cb, 'gauth_signup');
  assert.ok(signupCookie);

  const reg = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH, termsVersion: TERMS }, cookie: signupCookie });
  assert.equal(reg.status, 200);
  const body = await reg.json();
  assert.equal(body.user.name, 'Ada Lovelace');
  const sessionCookie = cookieNamed(reg, 'gymsid');
  assert.ok(sessionCookie);
  assert.ok(cookieCleared(reg, 'gauth_signup'));

  const row = await h.userRow(body.user.id);
  assert.equal(row.email, 'new@example.com');
  assert.ok(row.email_verified_at, 'Google already proved the e-mail — no confirmation link needed');
  const identity = await h.identity(body.user.id);
  assert.equal(identity.subject, 'sub-new');

  const me = await h.raw('GET', '/api/me', { cookie: sessionCookie });
  const meBody = await me.json();
  assert.equal(meBody.google.email, 'new@example.com');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.signup'));
});

test('login: an existing, already-linked identity signs in (ok)', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1', email: 'ana@example.com' });
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', email: 'ana@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const { path, params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(path, '/entrar');
  assert.equal(params.get('google'), 'ok');
  assert.ok(cookieNamed(cb, 'gymsid'));
  assert.ok(h.audit().some(e => e.ev === 'auth.google.ok' && e.uid === 'u1'));
});

test('login: a verified e-mail match links and signs in (linked)', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString(), email: 'ana@example.com' }] });
  await h.verifyEmail('u1');
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', email: 'ana@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'linked');
  assert.ok(cookieNamed(cb, 'gymsid'));
  const identity = await h.identity('u1');
  assert.equal(identity.subject, 'sub-1');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.link' && e.uid === 'u1'));
});

test('login: an e-mail match with an unverified e-mail refuses — does not link, anti-hijack (ISO-1397)', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString(), email: 'ana@example.com' }] });
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', email: 'ana@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'email-unverified');
  assert.equal(cookieNamed(cb, 'gymsid'), null);
  assert.equal(await h.identity('u1'), null);
  assert.ok(h.audit().some(e => e.ev === 'auth.google.refused' && e.msg === 'email-unverified'));
});

test('login: a disabled account, already linked or matched by e-mail, is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString(), disabled: true }] });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'disabled');
  assert.equal(cookieNamed(cb, 'gymsid'), null);
});

test('login: Google returns error=access_denied — cancelled, not a failure', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, oauthCookie } = await beginStart(h, 'login');
  const cb = await h.raw('GET', `/api/auth/google/callback?error=access_denied&state=${state}`, { cookie: oauthCookie });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'cancelled');
  assert.ok(!h.audit().some(e => e.ev === 'auth.google.fail'));
});

/* =================================================================== callback: id-token checks */

test('a tampered signature is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => {
    const good = signJwt(baseClaims({ nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
    const [header, payload, sig] = good.split('.');
    const tampered = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    return `${header}.${payload}.${tampered}`;
  };
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('bad-signature')));
});

test('an unknown kid triggers exactly one refetch of the JWKS', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  // First callback with the original key populates the cache.
  const first = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-a', nonce: first.nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb1 = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${first.state}`, { cookie: first.oauthCookie });
  assert.equal(parseHashRedirect(cb1.headers.get('location')).params.get('google'), 'signup');

  // Rotate: a new key appears server-side; a token signed with it must still verify, by refetching.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk2 = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-2', use: 'sig', alg: 'RS256' };
  google.state.keys.push(jwk2);
  const second = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-b', email: 'b@example.com', nonce: second.nonce }), { kid: 'test-key-2', privateKey });
  const cb2 = await h.raw('GET', `/api/auth/google/callback?code=c2&state=${second.state}`, { cookie: second.oauthCookie });
  assert.equal(parseHashRedirect(cb2.headers.get('location')).params.get('google'), 'signup');
});

test('a kid that never matches any published key is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce }), { kid: 'nonexistent-kid', privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('unknown-kid')));
});

for (const [label, alg] of [['none', 'none'], ['HS256 (confusion attack)', 'HS256']]) {
  test(`alg ${label} is refused — only RS256 is ever trusted`, async t => {
    const google = fakeGoogleServer();
    const h = await startServer(t, google, {});
    const { state, nonce, oauthCookie } = await beginStart(h, 'login');
    google.state.nextIdToken = () => signJwt(baseClaims({ nonce }), { kid: google.jwk.kid, privateKey: 'whatever-secret', alg });
    const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
    assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
    assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('bad-alg')));
  });
}

test('a wrong issuer is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce, iss: 'https://evil.example.com' }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('bad-iss')));
});

test('a wrong audience is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce, aud: 'someone-elses-client-id' }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('bad-aud')));
});

test('an expired id token is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  // skewSec shifts both iat and exp back by this many seconds from a token good for one hour; it
  // has to clear the verifier's own 5-minute clock-skew allowance for exp to actually be expired.
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce, skewSec: 4000 }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('expired')));
});

test('a mismatched nonce is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce: 'not-the-one-in-the-cookie' }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('bad-nonce')));
});

test('email_verified: false is refused even with a correctly-signed token', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ nonce, emailVerified: false }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg.includes('email-unverified')));
});

/* =================================================================== callback: state/cookie/replay */

test('a different state than the cookie carries is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { oauthCookie } = await beginStart(h, 'login');
  const cb = await h.raw('GET', '/api/auth/google/callback?code=c1&state=not-the-real-state', { cookie: oauthCookie });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg === 'state-mismatch'));
});

test('no gauth_oauth cookie at all is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const cb = await h.raw('GET', '/api/auth/google/callback?code=c1&state=whatever');
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg === 'state-cookie-invalid'));
});

test('an expired gauth_oauth cookie (past 10 minutes) is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const forged = signJSONFor({ state: 's', nonce: 'n', verifier: 'v', intent: 'login', uid: null, iat: Date.now() - 11 * 60000 });
  const cb = await h.raw('GET', '/api/auth/google/callback?code=c1&state=s', { cookie: `gauth_oauth=${forged}` });
  assert.equal(parseHashRedirect(cb.headers.get('location')).params.get('google'), 'error');
  assert.ok(h.audit().some(e => e.ev === 'auth.google.fail' && e.msg === 'state-cookie-invalid'));
});

test('a reused authorization code fails on replay — the token endpoint\'s own single-use rule', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'login');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-replay', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const first = await h.raw('GET', `/api/auth/google/callback?code=same-code&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(first.headers.get('location')).params.get('google'), 'signup');
  const second = await h.raw('GET', `/api/auth/google/callback?code=same-code&state=${state}`, { cookie: oauthCookie });
  assert.equal(parseHashRedirect(second.headers.get('location')).params.get('google'), 'error');
});

/* =================================================================== linking (intent=link) */

test('POST /api/account/google/start asks the usual proof before minting the link cookie', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {
    env: { PASSWORD_LOGIN: '1' },
    users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString(), pw: { h: pwHash, set: new Date().toISOString() } }]
  });
  const cookie = mintSession('u1');
  const noProof = await h.raw('POST', '/api/account/google/start', { body: {}, cookie });
  assert.equal(noProof.status, 403);
  assert.equal((await noProof.json()).code, 'current-required');

  const r = await h.raw('POST', '/api/account/google/start', { body: { current: 'correct horse battery staple' }, cookie });
  assert.equal(r.status, 200);
  const { url } = await r.json();
  const loc = new URL(url);
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  const linkCookie = cookieNamed(r, 'gauth_oauth');

  google.state.nextIdToken = () => signJwt(
    baseClaims({ sub: 'sub-link', email: 'different@example.com', nonce: loc.searchParams.get('nonce') }),
    { kid: google.jwk.kid, privateKey: google.privateKey }
  );
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${loc.searchParams.get('state')}`, { cookie: linkCookie });
  const { path, params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(path, '/configuracoes', 'link/reauth land on Settings, not the login screen');
  assert.equal(params.get('google'), 'linked');
  const identity = await h.identity('u1');
  assert.equal(identity.subject, 'sub-link');
  assert.equal(identity.email, 'different@example.com', 'links regardless of whether the e-mail matches');
});

test('POST /api/account/google/start refuses when the profile is already linked', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {
    env: { PASSWORD_LOGIN: '1' },
    users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString(), pw: { h: pwHash, set: new Date().toISOString() } }]
  });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const r = await h.raw('POST', '/api/account/google/start', { body: { current: 'correct horse battery staple' }, cookie: mintSession('u1') });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'already-linked');
});

test('linking a Google account already linked to a different profile answers already-linked', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {
    env: { PASSWORD_LOGIN: '1' },
    users: [
      { id: 'u1', name: 'Ana', created: new Date().toISOString(), pw: { h: pwHash, set: new Date().toISOString() } },
      { id: 'u2', name: 'Bea', created: new Date().toISOString() }
    ]
  });
  await h.insertIdentity({ subject: 'sub-taken', userId: 'u2' });
  const start = await h.raw('POST', '/api/account/google/start', { body: { current: 'correct horse battery staple' }, cookie: mintSession('u1') });
  const { url } = await start.json();
  const loc = new URL(url);
  const linkCookie = cookieNamed(start, 'gauth_oauth');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-taken', nonce: loc.searchParams.get('nonce') }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${loc.searchParams.get('state')}`, { cookie: linkCookie });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'already-linked');
  assert.equal((await h.identity('u1')), null);
});

/* =================================================================== reauth (proveOwner's third proof) */

test('intent=reauth mints a proof that proveOwner accepts for an account with only Google', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const cookie = mintSession('u1');
  const { state, nonce, oauthCookie } = await beginStart(h, 'reauth', { cookie });

  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: `${oauthCookie}; ${cookie}` });
  const { path, params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(path, '/configuracoes');
  assert.equal(params.get('google'), 'reauth-ok');
  const proof = params.get('proof');
  assert.ok(proof);

  // No password, no passkey — DELETE /api/account would be refused without this third proof.
  const del = await h.raw('DELETE', '/api/account', { body: { googleProof: proof }, cookie });
  assert.equal(del.status, 200);
});

test('intent=reauth with a different Google account than the one linked answers reauth-mismatch', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  await h.insertIdentity({ subject: 'sub-real', userId: 'u1' });
  const cookie = mintSession('u1');
  const { state, nonce, oauthCookie } = await beginStart(h, 'reauth', { cookie });
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-other-account', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: `${oauthCookie}; ${cookie}` });
  const { params } = parseHashRedirect(cb.headers.get('location'));
  assert.equal(params.get('google'), 'reauth-mismatch');
});

test('a reauth proof is single-use and refuses a replay', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const cookie = mintSession('u1');
  const { state, nonce, oauthCookie } = await beginStart(h, 'reauth', { cookie });
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: `${oauthCookie}; ${cookie}` });
  const proof = parseHashRedirect(cb.headers.get('location')).params.get('proof');
  const first = await h.raw('DELETE', '/api/account', { body: { googleProof: proof }, cookie });
  assert.equal(first.status, 200);
  // Second account, same proof: refused (also already consumed, and a different account entirely).
  const second = await h.raw('DELETE', '/api/account', { body: { googleProof: proof }, cookie: mintSession('u1') });
  assert.equal(second.status, 401, 'the account is already gone');
});

test('a reauth proof minted for one account does not confirm anything for another', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {
    users: [
      { id: 'u1', name: 'Ana', created: new Date().toISOString() },
      { id: 'u2', name: 'Bea', created: new Date().toISOString() }
    ]
  });
  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const cookie1 = mintSession('u1');
  const { state, nonce, oauthCookie } = await beginStart(h, 'reauth', { cookie: cookie1 });
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: `${oauthCookie}; ${cookie1}` });
  const proof = parseHashRedirect(cb.headers.get('location')).params.get('proof');
  const cookie2 = mintSession('u2');
  const r = await h.raw('DELETE', '/api/account', { body: { googleProof: proof }, cookie: cookie2 });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'google-proof-invalid');
});

/* =================================================================== POST /api/register/google */

test('POST /api/register/google requires terms acceptance and an adult birth date, atomically', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const { state, nonce, oauthCookie } = await beginStart(h, 'signup');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-young', email: 'young@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const signupCookie = cookieNamed(cb, 'gauth_signup');

  const noTerms = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH }, cookie: signupCookie });
  assert.equal(noTerms.status, 400);
  assert.equal((await noTerms.json()).code, 'terms-required');

  const underage = await h.raw('POST', '/api/register/google', { body: { birthDate: '2015-01-01', termsVersion: TERMS }, cookie: signupCookie });
  assert.equal(underage.status, 400);
  assert.equal((await underage.json()).code, 'underage');

  // Neither refused attempt created an account or burned the (still-live) ticket.
  const ok = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH, termsVersion: TERMS }, cookie: signupCookie });
  assert.equal(ok.status, 200);
});

test('POST /api/register/google: an expired or missing ticket is refused', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, {});
  const noTicket = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH, termsVersion: TERMS } });
  assert.equal(noTicket.status, 400);
  assert.equal((await noTicket.json()).code, 'ticket-invalid');
});

test('POST /api/register/google: INVITE_ONLY requires a valid code, consumed atomically with the account', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { env: { INVITE_ONLY: '1' } });
  const p = h.pool();
  try { await p.query('INSERT INTO invites (code) VALUES ($1)', ['GOODCODE']); } finally { await p.end(); }

  const { state, nonce, oauthCookie } = await beginStart(h, 'signup');
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-invite', email: 'invitee@example.com', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: oauthCookie });
  const signupCookie = cookieNamed(cb, 'gauth_signup');

  const noCode = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH, termsVersion: TERMS }, cookie: signupCookie });
  assert.equal(noCode.status, 403);
  assert.equal((await noCode.json()).code, 'invite');

  const ok = await h.raw('POST', '/api/register/google', { body: { birthDate: ADULT_BIRTH, termsVersion: TERMS, code: 'goodcode' }, cookie: signupCookie });
  assert.equal(ok.status, 200);

  const p2 = h.pool();
  try {
    const { rows } = await p2.query('SELECT used_by FROM invites WHERE code = $1', ['GOODCODE']);
    assert.ok(rows[0].used_by);
  } finally { await p2.end(); }
});

/* =================================================================== DELETE /api/account/google */

test('DELETE /api/account/google is refused when it is the last way in, and succeeds otherwise', async t => {
  const google = fakeGoogleServer();
  const h = await startServer(t, google, { users: [{ id: 'u1', name: 'Ana', created: new Date().toISOString() }] });
  const cookie = mintSession('u1');
  // No identity at all: a no-op success.
  assert.equal((await h.raw('DELETE', '/api/account/google', { body: {}, cookie })).status, 200);

  await h.insertIdentity({ subject: 'sub-1', userId: 'u1' });
  const refused = await h.raw('DELETE', '/api/account/google', { body: {}, cookie });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'last-way-in');

  // A passkey added alongside it (direct DB insert — no WebAuthn ceremony needed for this check)
  // is now the other way in; the reauth proof from earlier tests is the natural way to confirm,
  // but a passkey assertion proves it just as well — insert a passkey row directly and prove with
  // the Google identity itself via a fresh reauth.
  const p = h.pool();
  try {
    await p.query(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($1,$2,$3,0,'{}',now())`,
      ['pk-1', 'u1', 'pk']
    );
  } finally { await p.end(); }

  const { state, nonce, oauthCookie } = await beginStart(h, 'reauth', { cookie });
  google.state.nextIdToken = () => signJwt(baseClaims({ sub: 'sub-1', nonce }), { kid: google.jwk.kid, privateKey: google.privateKey });
  const cb = await h.raw('GET', `/api/auth/google/callback?code=c1&state=${state}`, { cookie: `${oauthCookie}; ${cookie}` });
  const proof = parseHashRedirect(cb.headers.get('location')).params.get('proof');

  const ok = await h.raw('DELETE', '/api/account/google', { body: { googleProof: proof }, cookie });
  assert.equal(ok.status, 200);
  assert.equal(await h.identity('u1'), null);
  assert.ok(h.audit().some(e => e.ev === 'auth.google.unlink'));
});
