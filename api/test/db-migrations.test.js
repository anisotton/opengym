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

// Lyra's actual starting point: it ran 001 (with the FK — the content it's restored to) and
// 002_email_verification before 003 existed, so the runner's schema_migrations already has both
// recorded by filename and will never re-apply them. Reproduce that exactly, then confirm the
// real runner picks up only 003 on top and the stale FK goes away — the upgrade path, not just
// the fresh-install one above.
test('a database that already ran 001 (with the FK) and 002 converges once 003 is applied on top', async () => {
  await withDb(async pool => {
    const already = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^00[12]_.+\.sql$/.test(f)).sort();
    assert.deepEqual(already, ['001_init.sql', '002_email_verification.sql']);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of already) {
      await pool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
    const { rows: before } = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invites'::regclass AND contype = 'f' AND conname = 'invites_used_by_fkey'
    `);
    assert.equal(before.length, 1, 'the FK from the originally-applied 001 is present, same as on Lyra');

    // 003, 004 (ISO-1393, users.stripe_customer_id) and, since ISO-1447, 005 (stripe_cleanup) —
    // all unrecorded on this database, same as any migration newer than whatever Lyra already ran.
    const count = await runMigrations(pool, MIGRATIONS_DIR);
    assert.equal(count, 3, 'everything after 002 is newly applied — 001 and 002 were already recorded');

    const { rows: after } = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invites'::regclass AND contype = 'f' AND conname = 'invites_used_by_fkey'
    `);
    assert.deepEqual(after, [], 'running 003 on top drops the FK Lyra actually has');
  });
});
