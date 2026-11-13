/* Shared scaffolding for the api tests.
 *
 * Every module under coach/ resolves DATA_DIR at import time (the same way server.js does),
 * so a test that wants its own data directory has to set the variable before the first
 * import. Hence dynamic imports everywhere below, and one helper that does it in the right
 * order. node:test runs each file in its own process, so one directory per file is enough.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/* The port a spawned server.js actually bound.
 *
 * Never pick one for it. Opening a listener on 0, reading the port, closing it and handing the
 * number to a child that binds it a process start later leaves a window the kernel re-issues
 * ephemeral ports inside -- 8 repeats in 400 open/close rounds on this box -- and a dozen test
 * files spawn servers at once, so two draw the same number, one child loses the bind and dies,
 * and the other file's server answers on it: a different data dir, a db.json without the test's
 * user, and a 401 where the answer belongs. It cost one unreproducible failure before anyone
 * looked.
 *
 * So the child picks its own port (PORT=0) and says which on its boot line. That line cannot be
 * printed before the socket is bound, which makes it the readiness signal as well -- no polling
 * /api/health, and no waiting on a server that died at boot either.
 *
 * `tail` supplies whatever the caller has collected of the child's output, for the message.
 */
export function boundPort(child, tail = () => '') {
  return new Promise((resolve, reject) => {
    let seen = '';
    const give = setTimeout(() => reject(new Error(`server never announced a port:\n${tail() || seen}`)), 20000);
    const look = d => {
      seen += d;
      const m = /gym-api on :(\d+)/.exec(seen);
      if (!m) return;
      clearTimeout(give);
      child.stdout.off('data', look);
      resolve(+m[1]);
    };
    child.stdout.on('data', look);
    child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${tail() || seen}`)); });
  });
}

export function tempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-test-'));
  fs.writeFileSync(path.join(dir, 'secret'), 'a'.repeat(64), { mode: 0o600 });
  process.env.DATA_DIR = dir;
  return dir;
}

/* Spawning server.js for a test (ISO-1403). DATABASE_URL is mandatory now — GET/PUT /api/data has
 * nothing else to read or write — so every test that starts a real server needs a database, not
 * just the ones that previously cared about PostgreSQL. `spawnApi` is the one place that does
 * both provisioning and spawning, so a test file states its DATA_DIR/db.json fixture and its env
 * overrides and gets a running server back; `t.after` teardown (kill the child, drop the
 * database) is registered here too, so a test cannot forget it.
 *
 * `dataDir`, if omitted, is a fresh tempData() — most callers only care about DATABASE_URL being
 * there; a handful seed their own db.json first and pass the directory in.
 */
export async function spawnApi(t, { dataDir, env = {}, nodeArgs = [], ipc = false } = {}) {
  const dir = dataDir || tempData();
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  t.after(cleanup);
  const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // `nodeArgs` go before server.js (server-presence.test.js preloads a fake clock with --import);
  // `ipc` adds the channel such a preload is driven through (child.send / 'message').
  const child = spawn(process.execPath, [...nodeArgs, 'server.js'], {
    cwd: API, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
      DATABASE_URL: databaseUrl, ...env
    }
  });
  // Exposed so a test can simulate the database disappearing out from under a running server
  // (health.test.js) — terminates backends and drops the database right now rather than waiting
  // for teardown. Safe to call again afterwards: cleanup() itself is `DROP DATABASE IF EXISTS`.
  const h = { log: '', dataDir: dir, databaseUrl, dropDatabase: cleanup };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  // API_TEST_LOG=1 mirrors the child's output to the runner's stderr: a 500 whose stack only
  // reached h.log is otherwise invisible unless the failing assertion happens to print it.
  if (process.env.API_TEST_LOG) { child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr); }
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.child = child;
  return h;
}

// A direct Postgres connection to a spawned server's own database — for tests that assert on the
// user_state row itself (a 409's payload is one thing; that nothing was written on a refused PUT
// is another). Caller's job to end() it, or better, hand it to t.after.
export function testPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function seedUserState(databaseUrl, userId, state, rev = 1) {
  const p = new pg.Pool({ connectionString: databaseUrl });
  try {
    await p.query(
      'INSERT INTO user_state (user_id, state, rev) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET state = $2, rev = $3',
      [userId, state, rev]
    );
  } finally {
    await p.end();
  }
}

/* PostgreSQL harness (ISO-1402). TEST_DATABASE_URL points at an admin/maintenance connection
 * (typically the `postgres` database of a throwaway server — see scripts/test-with-pg.sh); each
 * caller gets its own randomly-named database, so parallel test files never see each other's
 * rows. Only the tests that actually exercise the database call this — everything else runs
 * exactly as before, DATABASE_URL unset, server.js skipping PostgreSQL entirely. */

// Missing TEST_DATABASE_URL is a clear, thrown failure, not a silent skip: a test that calls
// this and gets no database back would otherwise look green while testing nothing.
function adminUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set — run this test through `npm run test:pg` ' +
      '(api/scripts/test-with-pg.sh), which starts an ephemeral PostgreSQL and sets it, ' +
      'or export it yourself pointing at a disposable server.'
    );
  }
  return url;
}

// A fresh, empty database — migrations are the caller's job (usually db.js's runMigrations).
// Postgres identifiers can't be bound as query parameters, but the name is ours, hex-only, so
// interpolating it directly is safe.
export async function provisionTestDatabase() {
  const base = adminUrl();
  const name = 'opengym_test_' + crypto.randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString: base });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = '/' + name;
  return {
    databaseUrl: url.toString(),
    async cleanup() {
      const admin2 = new pg.Pool({ connectionString: base });
      try {
        // Drop any lingering connections first — a database with an open session cannot be
        // dropped, and a test that crashed mid-query would otherwise leak it forever.
        await admin2.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name]
        );
        await admin2.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await admin2.end();
      }
    }
  };
}

/** `n` days before today, as the `YYYY-MM-DD` the coach's review window compares against
 *  (`reviewWindow` in coach/core/payload.js). Fixtures below are built on this, not on a
 *  calendar date, so they stay inside the 12-week window no matter when the suite runs. */
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/* Fixture dates that follow the calendar.
 *
 * The Coach reads a window that ends today (MAX_WEEKS back from now), so a literal fixture date
 * walks out of it one day and every review test reads an empty log: ten tests failed on
 * 2026-10-12 for no other reason than the date. D() moves a fixture date by whole weeks, the
 * same number for every date in a run, so the newest fixture day (FIXTURE_ANCHOR) lands in the
 * last seven days before today (UTC, as the payload's own dates are). Weekdays and the gaps
 * between fixture dates stay exactly as written, and nothing lands in the future.
 * Write fixtures as D('2026-07-20'), and assertions about them the same way. */
export const FIXTURE_ANCHOR = '2026-07-20';
const DAY_MS = 86400000;
const shiftWeeks = (() => {
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const anchor = Date.parse(FIXTURE_ANCHOR + 'T00:00:00Z');
  return Math.floor((today - DAY_MS - anchor) / (7 * DAY_MS));
})();
export function D(iso) {
  const t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  return new Date(t + shiftWeeks * 7 * DAY_MS).toISOString().slice(0, 10) + String(iso).slice(10);
}

/** A profile that has consented and has some history — the usual starting point. */
export function sampleState(over = {}) {
  return {
    unit: 'kg', lang: 'en', effort: 'rpe', targetW: 80,
    coach: { consent: { agreedAt: new Date().toISOString(), version: 1 }, profile: { goal: 'muscle', daysPerWeek: 3, equipment: ['dumbbell'] } },
    routines: [{
      id: 'r1', name: 'Full body A', emoji: '💪', prog: 'linear',
      ex: [
        { id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' },
        { id: '0007', sets: 3, sec: 45, mode: 'time' }
      ]
    }],
    week: { 1: 'r1', 3: 'r1', 5: 'r1' },
    dayPlan: {},
    exWeights: { '0001': { w: 20 } },
    bodyweight: [{ d: daysAgo(19), w: 78 }, { d: daysAgo(0), w: 78.5 }],
    customEx: [],
    workouts: [{
      id: 'w1', d: daysAgo(0), name: 'Full body A', start: 1000, end: 1000 + 45 * 60000, vol: 600, prs: [],
      entries: [{
        id: '0001', target: { sets: 3, reps: 10, weight: 20 },
        sets: [{ w: 20, r: 10, done: true, rpe: 9.5 }, { w: 20, r: 9, done: true, rpe: 10 }, { w: 20, r: 8, done: true, rpe: 10 }]
      }]
    }],
    ...over
  };
}

/* A software authenticator: a P-256 key that makes attestations ("none") and assertions the way
   a browser's would, for tests that need a passkey ceremony or a passkey step-up (proveOwner).
   `row(userId)` is its db.creds entry. */
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();
// Just enough CBOR for an attestation object: a map of text keys to text, bytes or an empty map.
const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);

export function softPasskey(ORIGIN = 'http://localhost:8080') {
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
    // What navigator.credentials.create() hands back, serialised the way lib/api.js does.
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
    assertion(challenge, { origin = ORIGIN } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
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

