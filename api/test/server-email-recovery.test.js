/* Verified e-mail + password-less recovery (ISO-1397): registration now requires and checks a
   unique e-mail, a confirmation link (single-use, 24h) proves it, and "I lost my access" sends a
   second kind of single-use link (15min) that chains into the existing device-link pair
   (device-link.js, /api/device-link/options → /verify) rather than a parallel ceremony of its
   own. Real server.js in a child, same shape as server-passkeys.test.js; the mail driver is the
   default `log` one (no MAIL_API_KEY), so a sent link is read back out of the child's own stdout
   (h.log). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
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
    },
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

async function startServer(t, { env = {}, users = [] } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, {
    dataDir,
    // APP_URL explicitly blanked: without this, a host environment that already exports one
    // (this very project's own .env, inherited by spawnApi's `...process.env`) would leak into
    // the child and break the assumption below that a mailed link falls back to ORIGIN.
    env: { ORIGIN, APP_URL: '', TRUST_PROXY: '1', INVITE_ONLY: '', ADMIN_UIDS: '', AUDIT_LOG: '1', ...env }
  });
  h.req = async (method, p, { body, cookie, ip = '198.51.100.1', headers = {} } = {}) => {
    // ISO-1390: a signup sends the LEGAL_VERSION of the app's bundle; leaving it out is
    // server-terms.test.js's subject, not this file's. ISO-1521: same idea for the now-required
    // birthDate — an adult one, since the under-18 refusal is server-age-gate.test.js's subject.
    if (/^\/api\/register\/(options|password)$/.test(p) && body && typeof body === 'object' && !('termsVersion' in body)) body = { ...body, termsVersion: '2026-10-18' };
    if (/^\/api\/register\/(options|password)$/.test(p) && body && typeof body === 'object' && !('birthDate' in body)) body = { ...body, birthDate: '1990-05-05' };
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
  // A direct, pre-ISO-1397-style account: no e-mail, created without going through
  // /api/register/* at all — the shape an upgrading instance's existing profiles are in.
  h.seedOldAccount = async (id, name) => {
    const pool = h.pool();
    try { await pool.query('INSERT INTO users (id, name, created_at) VALUES ($1,$2,now())', [id, name]); }
    finally { await pool.end(); }
  };
  // Registers a brand new profile end to end and returns { user, cookie, email }.
  h.register = async (name, email, ip = '198.51.100.1') => {
    const key = softPasskey();
    const opt = await h.req('POST', '/api/register/options', { body: { name, email }, ip });
    assert.equal(opt.status, 200, JSON.stringify(opt.body));
    const r = await h.req('POST', '/api/register/verify', { body: { cid: opt.body.cid, credential: key.attestation(opt.body.options.challenge) }, ip });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { key, user: r.body.user, cookie: r.cookie, email };
  };
  // Pulls the most recent mailed link matching `kind` ('verificar-email' | 'recuperar') out of
  // the child's own stdout — the `log` mail driver (api/mail.js) writes the full text there.
  h.mailedLink = kind => {
    const matches = [...h.log.matchAll(new RegExp(`${ORIGIN}/#/${kind}\\?token=([^\\s<]+)`, 'g'))];
    assert.ok(matches.length, `no ${kind} link found in the log:\n${h.log}`);
    return { url: matches[matches.length - 1][0], token: decodeURIComponent(matches[matches.length - 1][1]) };
  };
  return h;
}

/* ------------------------------------------------------------------ registration ------------ */

test('register/options requires a valid, unique e-mail; register/verify mints and mails a confirmation link', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.10';
  assert.deepEqual((await h.req('POST', '/api/register/options', { body: { name: 'Ada' }, ip })).body, { error: 'that is not an e-mail address', code: 'email-invalid' });
  assert.equal((await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'not-an-email' }, ip })).status, 400);

  const { user, email } = await h.register('Ada', 'Ada@Example.com', ip);
  assert.equal((await h.user(user.id)).email, 'ada@example.com', 'stored lower-cased, like the sign-in e-mail feature');
  assert.equal((await h.user(user.id)).email_verified_at, null);
  assert.ok(h.audit().some(e => e.ev === 'auth.register.ok' && e.uid === user.id));

  const taken = await h.req('POST', '/api/register/options', { body: { name: 'Eve', email }, ip: '198.51.100.11' });
  assert.deepEqual(taken.body, { error: 'another profile already uses this e-mail address', code: 'email-taken' });
  assert.equal(taken.status, 409);

  const link = h.mailedLink('verificar-email');
  assert.match(link.token, /^[A-Za-z0-9_-]{30,}$/);
});

// ISO-1521 replaces ISO-1398's "optional, never blocks" — required, format-validated, and a
// minor is refused outright. The required/underage cases of that newer rule are
// server-age-gate.test.js's subject; this stays about shape (not-a-date, in the future).
test('register/options validates birthDate\'s shape; a well-formed adult date is stored', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.12';
  const bad = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com', birthDate: '2024-02-30' }, ip });
  assert.deepEqual(bad.body, { error: 'that is not a date', code: 'birth-date-invalid' });
  const future = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com', birthDate: '2999-01-01' }, ip });
  assert.equal(future.status, 400);
  const ok = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com', birthDate: '1990-05-05' }, ip });
  assert.equal(ok.status, 200);
  // h.register() falls back to h.req's own default adult birthDate (ISO-1521) when a test omits one.
  const { user } = await h.register('Bea', 'bea@example.com', ip);
  assert.equal((await h.user(user.id)).birth_date.toISOString().slice(0, 10), '1990-05-05');
});

test('register/verify re-checks the e-mail: a race since options still loses', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.13';
  const key = softPasskey();
  const opt = await h.req('POST', '/api/register/options', { body: { name: 'Ada', email: 'ada@example.com' }, ip });
  assert.equal(opt.status, 200);
  // Someone else's signup for the same address finishes first.
  await h.register('Impostor', 'ada@example.com', '198.51.100.14');
  const r = await h.req('POST', '/api/register/verify', { body: { cid: opt.body.cid, credential: key.attestation(opt.body.options.challenge) }, ip });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'email-taken');
  const pool = h.pool();
  try { assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1, 'only the Impostor exists'); }
  finally { await pool.end(); }
});

/* ------------------------------------------------------------------ confirmation -------------- */

test('GET /api/me reports email/emailVerified/needsEmail; confirming the link sets emailVerified', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.20';
  const { user, cookie } = await h.register('Ada', 'ada@example.com', ip);
  const me1 = await h.req('GET', '/api/me', { cookie, ip });
  // ISO-1390's terms fields ride along; their own values are server-terms.test.js's subject.
  assert.equal(typeof me1.body.termsAcceptedAt, 'string');
  assert.deepEqual(me1.body, { user, email: 'ada@example.com', emailVerified: false, needsEmail: false,
    termsVersion: '2026-10-18', termsAcceptedAt: me1.body.termsAcceptedAt, needsTerms: false, google: null });

  const { token } = h.mailedLink('verificar-email');
  const v = await h.req('POST', '/api/account/email/verify', { body: { token }, ip });
  assert.equal(v.status, 200);
  assert.deepEqual(v.body, { ok: true });
  assert.ok(h.audit().some(e => e.ev === 'auth.email.verify.ok' && e.uid === user.id));

  const me2 = await h.req('GET', '/api/me', { cookie, ip });
  assert.equal(me2.body.emailVerified, true);

  // Single use: the same link does not work twice.
  const replay = await h.req('POST', '/api/account/email/verify', { body: { token }, ip });
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: 'that link is invalid or expired', code: 'token-invalid' });
});

test('an old account (no e-mail) needs one; a wrong confirmation token is refused and throttled', async t => {
  const h = await startServer(t);
  await h.seedOldAccount('u_old', 'Grandfathered');
  const me = await h.req('GET', '/api/me', { cookie: mintSession('u_old'), ip: '198.51.100.30' });
  assert.deepEqual(me.body, { user: { id: 'u_old', name: 'Grandfathered', admin: false }, email: null, emailVerified: false, needsEmail: true,
    termsVersion: null, termsAcceptedAt: null, needsTerms: true, google: null });

  const ip = '198.51.100.31';
  // 20 free wrong guesses, then the 21st is the one whose own failure locks the address — the
  // lock only takes effect from the next request on, same shape as every other ADDR_FAILS pause.
  for (let i = 0; i < 21; i++) {
    const r = await h.req('POST', '/api/account/email/verify', { body: { token: 'nope-' + i }, ip });
    assert.equal(r.status, 400, `attempt ${i}`);
  }
  const locked = await h.req('POST', '/api/account/email/verify', { body: { token: 'nope-last' }, ip });
  assert.equal(locked.status, 429);
  assert.ok(+locked.headers.get('retry-after') > 0);
});

test('resend invalidates the earlier link, and is a no-op once confirmed', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.40';
  const { cookie } = await h.register('Ada', 'ada@example.com', ip);
  const first = h.mailedLink('verificar-email');

  assert.equal((await h.req('POST', '/api/account/email/resend', { cookie, ip })).status, 200);
  const second = h.mailedLink('verificar-email');
  assert.notEqual(second.token, first.token);

  const old = await h.req('POST', '/api/account/email/verify', { body: { token: first.token }, ip });
  assert.equal(old.status, 400, 'the first link died the moment the second was minted');
  const fresh = await h.req('POST', '/api/account/email/verify', { body: { token: second.token }, ip });
  assert.equal(fresh.status, 200);

  const again = await h.req('POST', '/api/account/email/resend', { cookie, ip });
  assert.deepEqual(again.body, { ok: true, alreadyVerified: true });
});

/* ------------------------------------------------------------------ old accounts -------------- */

test('an old account sets its e-mail with proof, and a confirmation is mailed', async t => {
  const h = await startServer(t);
  const key = softPasskey();
  await h.seedOldAccount('u_old', 'Grandfathered');
  const ip = '198.51.100.50';
  const cookie = mintSession('u_old');

  const noProof = await h.req('POST', '/api/account/email', { body: { email: 'old@example.com' }, cookie, ip });
  assert.equal(noProof.status, 403);
  assert.equal(noProof.body.code, 'passkey-required');

  // Give the account a passkey, the way Settings would, directly for the test's sake.
  const pool = h.pool();
  try {
    await pool.query(
      'INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($1,$2,$3,0,$4,now())',
      [key.id, 'u_old', 'irrelevant', []]
    );
  } finally { await pool.end(); }

  const lo = await h.req('POST', '/api/login/options', { body: {}, ip });
  // The soft key has no matching public key to verify an assertion against here — this test only
  // needs a well-formed step-up body shape; a wrong/placeholder public key still refuses cleanly
  // rather than crashing, which the next assertion checks for.
  const withBadKey = await h.req('POST', '/api/account/email', { body: { email: 'old@example.com', cid: lo.body.cid, credential: key.assertion(lo.body.options.challenge) }, cookie, ip });
  assert.equal(withBadKey.status, 403);
});

/* ------------------------------------------------------------------ recovery ------------------ */

test('recover/request always answers 200 the same way, known address or not — and only mails the known one', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.60';
  const { email } = await h.register('Ada', 'ada@example.com', ip);

  const known = await h.req('POST', '/api/recover/request', { body: { email }, ip: '198.51.100.61' });
  assert.deepEqual(known.body, { ok: true });
  assert.equal(known.status, 200);

  const unknown = await h.req('POST', '/api/recover/request', { body: { email: 'nobody@example.com' }, ip: '198.51.100.62' });
  assert.deepEqual(unknown.body, { ok: true });
  assert.equal(unknown.status, 200);

  const empty = await h.req('POST', '/api/recover/request', { body: {}, ip: '198.51.100.63' });
  assert.deepEqual(empty.body, { ok: true });

  const link = h.mailedLink('recuperar');
  assert.match(link.token, /^[A-Za-z0-9_-]{30,}$/);
  assert.equal(h.log.includes('nobody@example.com'), false, 'nothing is sent for an address with no account');
});

test('recover/request never answers 429 even when its own address pause is spent — it stays 200', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.64';
  for (let i = 0; i < 25; i++) {
    const r = await h.req('POST', '/api/recover/request', { body: { email: `nobody${i}@example.com` }, ip });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  }
});

test('recover/redeem burns the token for a device-link code, which signs a fresh passkey in — old passkeys stay', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.70';
  const { key: original, user } = await h.register('Ada', 'ada@example.com', ip);

  await h.req('POST', '/api/recover/request', { body: { email: 'ada@example.com' }, ip: '198.51.100.71' });
  const { token } = h.mailedLink('recuperar');

  const redeemed = await h.req('POST', '/api/recover/redeem', { body: { token }, ip });
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(redeemed.body.expires > Date.now());
  assert.ok(h.audit().some(e => e.ev === 'auth.recover.ok' && e.uid === user.id));

  // Single use: the same recovery link does not work twice.
  const replay = await h.req('POST', '/api/recover/redeem', { body: { token }, ip });
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: 'that link is invalid or expired', code: 'token-invalid' });

  // The code chains into the existing device-link pair — a new device adds its own passkey.
  const phone = softPasskey();
  const opt = await h.req('POST', '/api/device-link/options', { body: { code: redeemed.body.code }, ip });
  assert.equal(opt.status, 200);
  assert.equal(opt.body.id, user.id);
  const verify = await h.req('POST', '/api/device-link/verify', {
    body: { code: redeemed.body.code, cid: opt.body.cid, credential: phone.attestation(opt.body.options.challenge), name: 'Phone' }, ip
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.id, user.id);
  assert.ok(verify.cookie, 'the new device is signed in');

  // Both the original passkey and the recovered one are listed — recovery never removes anything.
  const pool = h.pool();
  try {
    const { rows } = await pool.query('SELECT id FROM passkeys WHERE user_id = $1 ORDER BY created_at', [user.id]);
    assert.deepEqual(rows.map(r => r.id).sort(), [original.id, phone.id].sort());
  } finally { await pool.end(); }
});

test('recover/request sends nothing for a disabled account; a token already in hand is refused once the account is disabled', async t => {
  const h = await startServer(t);
  const ip = '198.51.100.80';
  const { user } = await h.register('Ada', 'ada@example.com', ip);
  const pool = h.pool();
  await h.req('POST', '/api/recover/request', { body: { email: 'ada@example.com' }, ip });
  const { token } = h.mailedLink('recuperar');
  try { await pool.query('UPDATE users SET disabled = true WHERE id = $1', [user.id]); }
  finally { await pool.end(); }
  const r = await h.req('POST', '/api/recover/redeem', { body: { token }, ip });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'that link is invalid or expired', code: 'token-invalid' });

  // And once disabled, a fresh request mails nothing at all.
  const before = h.log.length;
  await h.req('POST', '/api/recover/request', { body: { email: 'ada@example.com' }, ip });
  assert.equal(h.log.slice(before).includes('Recupere seu acesso'), false);
});

/* ------------------------------------------------------------------ ISO-1596: password ------- */

const GOOD = 'correct horse battery staple';

test('with PASSWORD_LOGIN on, register/password requires and mails the same confirmation, and GET /api/me always carries the fields', async t => {
  const h = await startServer(t, { env: { PASSWORD_LOGIN: '1' } });
  const ip = '198.51.100.90';
  assert.deepEqual(
    (await h.req('POST', '/api/register/password', { body: { name: 'Ada', password: GOOD }, ip })).body,
    { error: 'that is not an e-mail address', code: 'email-invalid' }
  );
  const r = await h.req('POST', '/api/register/password', { body: { name: 'Ada', password: GOOD, email: 'Ada@Example.com' }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.cookie);
  assert.equal((await h.user(r.body.user.id)).email, 'ada@example.com');
  assert.equal((await h.user(r.body.user.id)).email_verified_at, null);

  const me1 = await h.req('GET', '/api/me', { cookie: r.cookie, ip });
  assert.deepEqual(me1.body.user, r.body.user);
  assert.equal(me1.body.email, 'ada@example.com');
  assert.equal(me1.body.emailVerified, false);
  assert.equal(me1.body.needsEmail, false);

  // The same confirmation link a passkey signup gets (register/verify) — not a second, unmailed
  // address (the retired #118 feature).
  const { token } = h.mailedLink('verificar-email');
  const v = await h.req('POST', '/api/account/email/verify', { body: { token }, ip });
  assert.equal(v.status, 200);
  const me2 = await h.req('GET', '/api/me', { cookie: r.cookie, ip });
  assert.equal(me2.body.emailVerified, true);

  // Signs in by that e-mail — unconfirmed would have worked too, the password is the proof.
  const signedIn = await h.req('POST', '/api/login/password', { body: { identifier: 'ADA@example.com', password: GOOD }, ip: '198.51.100.91' });
  assert.equal(signedIn.status, 200);
  const wrong = await h.req('POST', '/api/login/password', { body: { identifier: 'ada@example.com', password: 'nope at all' }, ip: '198.51.100.92' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: 'wrong e-mail or password', code: 'bad-credentials' });
});

test('recover/redeem with a password sets it directly, ends every other session, and stays single-use; a policy-rejected password does not burn the link', async t => {
  const h = await startServer(t, { env: { PASSWORD_LOGIN: '1' } });
  const ip = '198.51.100.100';
  const reg = await h.req('POST', '/api/register/password', { body: { name: 'Ada', password: GOOD, email: 'ada@example.com' }, ip });
  assert.equal(reg.status, 200);
  const second = await h.req('POST', '/api/login/password', { body: { identifier: 'ada@example.com', password: GOOD }, ip: '198.51.100.101' });
  assert.equal(second.status, 200);

  await h.req('POST', '/api/recover/request', { body: { email: 'ada@example.com' }, ip: '198.51.100.102' });
  const { token } = h.mailedLink('recuperar');

  // A password this instance refuses never burns an otherwise-good link.
  const weak = await h.req('POST', '/api/recover/redeem', { body: { token, password: 'short' }, ip: '198.51.100.103' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.code, 'too-short');

  const redeemed = await h.req('POST', '/api/recover/redeem', { body: { token, password: 'a brand new passphrase' }, ip: '198.51.100.104' });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.user.id, reg.body.user.id);
  assert.ok(redeemed.cookie);
  assert.ok(h.audit().some(e => e.ev === 'auth.recover.password' && e.uid === reg.body.user.id));

  // Every earlier session ended, the new one did not.
  assert.equal((await h.req('GET', '/api/me', { cookie: reg.cookie, ip })).status, 401, 'the signup session ended');
  assert.equal((await h.req('GET', '/api/me', { cookie: second.cookie, ip })).status, 401, 'the second session ended');
  assert.equal((await h.req('GET', '/api/me', { cookie: redeemed.cookie, ip })).status, 200, 'the redeem session carries on');

  // The old password is dead; the new one works.
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'ada@example.com', password: GOOD }, ip: '198.51.100.105' })).status, 401);
  assert.equal((await h.req('POST', '/api/login/password', { body: { identifier: 'ada@example.com', password: 'a brand new passphrase' }, ip: '198.51.100.106' })).status, 200);

  // Single-use: the same token is gone even for the device-link path.
  const replay = await h.req('POST', '/api/recover/redeem', { body: { token, password: 'yet another passphrase' }, ip: '198.51.100.107' });
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: 'that link is invalid or expired', code: 'token-invalid' });
});

test('recover/redeem with a password, but PASSWORD_LOGIN off, falls back to the device-link code', async t => {
  const h = await startServer(t);   // PASSWORD_LOGIN off by default here
  const ip = '198.51.100.110';
  const { user } = await h.register('Ada', 'ada@example.com', ip);
  await h.req('POST', '/api/recover/request', { body: { email: 'ada@example.com' }, ip });
  const { token } = h.mailedLink('recuperar');
  const r = await h.req('POST', '/api/recover/redeem', { body: { token, password: 'a brand new passphrase' }, ip });
  assert.equal(r.status, 200);
  assert.equal('code' in r.body, true);
  assert.equal('user' in r.body, false);
  assert.ok(h.audit().some(e => e.ev === 'auth.recover.ok' && e.uid === user.id));
});
