/* PostgreSQL access: pool, query/transaction helpers, and the migration runner (ISO-1402).
 *
 * server.js does not read or write through this yet — that's ISO-1403 (Phase 1b). This module's
 * only job right now is to connect and get the schema in `./migrations` applied before the API
 * starts listening, so 1b has a database to switch onto.
 *
 * No ORM: one dependency, `pg`, same as the rest of this codebase keeps to plain node:http and a
 * short list of libraries. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Every `NNN_name.sql` file in `dir`, in the order it is applied — the zero-padded numeric
// prefix sorts lexically the same as numerically, which is the only ordering guarantee migration
// file names need to keep.
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
}

// A fixed, arbitrary key: any two processes racing to migrate the same database serialize on it,
// so a second `api` replica booting at the same time waits rather than double-applies. Scoped to
// this migration runner only — nothing else in the app takes advisory locks.
const ADVISORY_LOCK_KEY = 0x6f70656e; // 'open' as hex, just needs to be a stable constant

// Applies every migration in `dir` that `schema_migrations` doesn't already have, in order, each
// in its own transaction. Idempotent: a file already recorded is skipped, so running this twice
// (or from two processes at once, serialized by the advisory lock) is a no-op the second time.
// Returns how many files were newly applied.
export async function runMigrations(pool, dir = MIGRATIONS_DIR) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     text PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      const { rows } = await client.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map(r => r.version));
      let count = 0;
      for (const file of listMigrationFiles(dir)) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed and was rolled back: ${e.message}`);
        }
        count++;
      }
      return count;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Connects and migrates, or throws with a message that says which of the two failed — the boot
// path (server.js) turns that into a clear exit rather than a stack trace.
export async function connectAndMigrate(databaseUrl, dir = MIGRATIONS_DIR) {
  const pool = createPool(databaseUrl);
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end();
    throw new Error(`could not connect to PostgreSQL (DATABASE_URL): ${e.message}`);
  }
  try {
    const count = await runMigrations(pool, dir);
    return { pool, count };
  } catch (e) {
    await pool.end();
    throw e;
  }
}
