/* Minimum age at signup (ISO-1521, Decision 18/10/2026 of ISO-1390), replacing ISO-1386/1398's
   "ask, never block": a birth date is now required on both /api/register/options and
   /api/register/password, and one giving an age under 18 as of now is refused outright —
   `400 underage` — rather than only feeding a dismissable notice. Real server.js in a child,
   same harness as server-terms.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const VERSION = '2026-10-17';
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

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

async function startServer(t, { env = {} } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    env: { ORIGIN, APP_URL: '', TRUST_PROXY: '1', INVITE_ONLY: '', ADMIN_UIDS: '', AUDIT_LOG: '1', ...env }
  });
  h.req = async (method, p, { body, cookie, ip = '198.51.100.60', headers = {} } = {}) => {
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

// Calendar-date math, not elapsed time: "N years ago, plus `extraDays`" on today's own
// month/day, the same shape the server and frontend/src/lib/age.js both compare birth dates by.
function yearsAgo(years, extraDays = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}
const ADULT_TODAY = yearsAgo(18, 0);   // turns 18 exactly today
const MINOR_TODAY = yearsAgo(18, 1);   // 17 years, 364 (or 365) days — turns 18 tomorrow

test('register/options: no birthDate → birth-date-required; under 18 → underage, no user, audited', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.61';
  const missing = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io', termsVersion: VERSION }, ip });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'a birth date is required', code: 'birth-date-required' });

  const minor = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io', termsVersion: VERSION, birthDate: MINOR_TODAY }, ip });
  assert.equal(minor.status, 400);
  assert.deepEqual(minor.body, { error: 'Brilhart Fitness is for people 18 and older', code: 'underage' });

  const bad = await h.req('POST', '/api/register/options', { body: { name: 'A', email: 'a@x.io', termsVersion: VERSION, birthDate: 'not-a-date' }, ip });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'that is not a date', code: 'birth-date-invalid' });

  assert.equal(await h.userCount(), 0, 'none of these created a user');
  const denied = h.audit().filter(e => e.ev === 'auth.register.denied').map(e => e.msg);
  assert.deepEqual(denied, ['birth-date-required', 'underage', 'birth-date-invalid']);
  // The refused date itself is never recorded, only the reason code.
  for (const row of h.audit()) assert.ok(!JSON.stringify(row).includes(MINOR_TODAY));
});

test('register/options: exactly 18 today signs up as normal', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.62';
  const key = softPasskey();
  const opt = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com', termsVersion: VERSION, birthDate: ADULT_TODAY }, ip });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  const r = await h.req('POST', '/api/register/verify', { body: { cid: opt.body.cid, credential: key.attestation(opt.body.options.challenge) }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await h.user(r.body.user.id);
  assert.equal(row.birth_date.toISOString().slice(0, 10), ADULT_TODAY);
  assert.equal(await h.userCount(), 1);
});

test('register/password (PASSWORD_LOGIN=1): no birthDate → birth-date-required; under 18 → underage, no user, audited', async t => {
  const h = await startServer(t, { env: { PASSWORD_LOGIN: '1' } });
  const ip = '198.51.100.63';
  const password = 'correct horse battery staple';
  const missing = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password, termsVersion: VERSION }, ip });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'a birth date is required', code: 'birth-date-required' });

  const minor = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password, termsVersion: VERSION, birthDate: MINOR_TODAY }, ip });
  assert.equal(minor.status, 400);
  assert.deepEqual(minor.body, { error: 'Brilhart Fitness is for people 18 and older', code: 'underage' });

  assert.equal(await h.userCount(), 0, 'none of these created a user');
  const denied = h.audit().filter(e => e.ev === 'auth.register.denied').map(e => e.msg);
  assert.deepEqual(denied, ['birth-date-required', 'underage']);

  const ok = await h.req('POST', '/api/register/password', { body: { name: 'Bea', password, termsVersion: VERSION, birthDate: ADULT_TODAY }, ip });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await h.user(ok.body.user.id);
  assert.equal(row.birth_date.toISOString().slice(0, 10), ADULT_TODAY);
  assert.equal(await h.userCount(), 1);
});
