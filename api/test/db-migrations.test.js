/* The migration runner (db.js, ISO-1402): applies files in order, is idempotent on a second run,
 * and rolls back a broken migration rather than leaving the schema half-changed. Needs a real
 * PostgreSQL — provisionTestDatabase() (helpers.mjs) throws a clear error without
 * TEST_DATABASE_URL, rather than letting this suite pretend to pass without one. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool, runMigrations, MIGRATIONS_DIR } from '../db.js';
import { provisionTestDatabase } from './helpers.mjs';

function migrationDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

async function withDb(fn) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const pool = createPool(databaseUrl);
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await cleanup();
  }
}

test('applies every migration in order and records each one', async () => {
  await withDb(async pool => {
    const dir = migrationDir({
      '001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));'
    });
    const count = await runMigrations(pool, dir);
    assert.equal(count, 2);
    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows.map(r => r.version), ['001_a.sql', '002_b.sql']);
    // both tables actually exist
    await pool.query('INSERT INTO a (id) VALUES (1)');
    await pool.query('INSERT INTO b (id, a_id) VALUES (1, 1)');
  });
});

test('running the same migrations twice applies nothing the second time', async () => {
  await withDb(async pool => {
    const dir = migrationDir({ '001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);' });
    assert.equal(await runMigrations(pool, dir), 1);
    assert.equal(await runMigrations(pool, dir), 0);
    const { rows } = await pool.query('SELECT count(*) FROM schema_migrations');
    assert.equal(rows[0].count, '1');
  });
});

test('a broken migration is rolled back and never recorded as applied', async () => {
  await withDb(async pool => {
    const dir = migrationDir({
      '001_ok.sql': 'CREATE TABLE ok (id int PRIMARY KEY);',
      '002_bad.sql': 'CREATE TABLE broken (id int PRIMARY KEY); INSERT INTO nope_this_table_does_not_exist VALUES (1);'
    });
    await assert.rejects(runMigrations(pool, dir), /002_bad\.sql/);
    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    assert.deepEqual(rows.map(r => r.version), ['001_ok.sql']);
    // 002_bad.sql's CREATE TABLE broken ran before the failing INSERT — the whole file's
    // transaction must have rolled back together, so it must not exist either.
    const { rows: tables } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    assert.deepEqual(tables.map(t => t.table_name), ['ok', 'schema_migrations']);
  });
});

// ISO-1409: 001_init.sql shipped with a foreign key on invites.used_by, then ISO-1403 edited that
// already-applied file in place to drop it instead of shipping a new migration — the runner never
// re-applies a recorded file, so an environment that had already run 001 (Lyra) kept the FK while
// a fresh install (which only ever saw the edited 001) never had it. 001_init.sql is back to the
// content it was actually applied with, and 002 is the migration that should have shipped instead
// — this is the "migrated from zero" half of that fix: both files applied in order must converge
// on no FK, regardless of what 001 originally said.
test('a database migrated from zero has no foreign key on invites.used_by', async () => {
  await withDb(async pool => {
    await runMigrations(pool, MIGRATIONS_DIR);
    const { rows } = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invites'::regclass AND contype = 'f' AND conname = 'invites_used_by_fkey'
    `);
    assert.deepEqual(rows, [], 'invites_used_by_fkey must not exist after a fresh migration run');
  });
});
