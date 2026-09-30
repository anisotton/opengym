/* server.js's PostgreSQL boot path (ISO-1402): connects and migrates before listening when
 * DATABASE_URL is set, refuses to boot on a connection/migration failure, and does not reapply
 * migrations on a second boot against the same database. DATABASE_URL unset (every other test
 * file in this suite) is covered implicitly — none of them fail, and none of them talk to
 * PostgreSQL at all. Needs a real PostgreSQL — provisionTestDatabase() throws a clear error
 * without TEST_DATABASE_URL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { provisionTestDatabase } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-db-boot-'));
  fs.writeFileSync(path.join(dir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return dir;
}

function spawnServer(env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env }
  });
}

test('connects, migrates and serves /api/health when DATABASE_URL is set', async t => {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  t.after(cleanup);
  const dataDir = tempDir();
  const child = spawnServer({ DATA_DIR: dataDir, DATABASE_URL: databaseUrl });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  assert.match(log, /postgres ready \(\d+ migrations? applied\)/);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, users: 0 });
});

test('a second boot against the same database applies zero new migrations', async t => {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  t.after(cleanup);

  async function bootOnce() {
    const dataDir = tempDir();
    const child = spawnServer({ DATA_DIR: dataDir, DATABASE_URL: databaseUrl });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    await boundPort(child, () => log);
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
    return log;
  }

  const first = await bootOnce();
  assert.match(first, /postgres ready \((\d+) migrations? applied\)/);
  const firstCount = +first.match(/postgres ready \((\d+)/)[1];
  assert.ok(firstCount > 0, 'the first boot against a fresh database applies at least one migration');

  const second = await bootOnce();
  assert.match(second, /postgres ready \(0 migrations applied\)/);
});

test('refuses to boot — never opens a port — when DATABASE_URL cannot be reached', async t => {
  const dataDir = tempDir();
  // Port 1 is never a real PostgreSQL in a test environment; the connection attempt fails fast.
  const child = spawnServer({ DATA_DIR: dataDir, DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nope' });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const [code] = await new Promise(resolve => child.once('exit', (c, s) => resolve([c, s])));
  assert.equal(code, 1);
  assert.match(log, /postgres connection\/migration failed/);
  assert.doesNotMatch(log, /gym-api on :/);
});
