#!/usr/bin/env node
/* One-time importer: DATA_DIR/db.json + DATA_DIR/state-<uid>.json → PostgreSQL (ISO-1404).
 *
 * Usage: DATA_DIR=... DATABASE_URL=... node scripts/import-json.js [--dry-run]
 *
 * Applies migrations first (same runner as db.js/server.js), then does every insert inside one
 * transaction — either everything lands, or (on a crash) nothing does. `--dry-run` runs the same
 * transaction and rolls it back instead of committing, so the report is accurate without touching
 * the database.
 *
 * Idempotent: every table is upserted on its natural key (users.id, invites.code, passkeys.id,
 * push_subscriptions.endpoint, device_links.hash), so importing the same files twice leaves the
 * database exactly as the first run did. user_state is the one exception the source data itself
 * requires: its row is only replaced when the file's `_rev` is greater than what's already
 * stored, so re-running this script can never overwrite state the API has since written (rev only
 * ever moves forward — see PUT /api/data in server.js).
 *
 * `users.invited_by` and `users.password_reset_by` both reference tables/rows that may not exist
 * yet at the point a given user is inserted (invites.code, another user), so those two columns
 * are left NULL on the first pass and backfilled in a second pass once every user and invite from
 * this import is in place.
 *
 * A record that fails validation, or points at a user that was never found, is skipped and
 * counted — it never aborts the rest of the import. Nothing here deletes or moves the original
 * JSON files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAndMigrate } from '../db.js';

const USER_FIELDS = ['id', 'name', 'email', 'admin', 'disabled', 'sv', 'pw', 'pwReset', 'invitedBy', 'lastPull', 'created'];

function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// db.json's own dates are ISO strings; device-link.js and pwReset.exp/lastPull are epoch ms.
function isoDate(v) { const d = typeof v === 'string' ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
function epochDate(v) { return typeof v === 'number' && Number.isFinite(v) ? new Date(v) : null; }

export function readJsonDb(dataDir) {
  const file = path.join(dataDir, 'db.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = {}; }
  return {
    users: Array.isArray(db.users) ? db.users : [],
    creds: Array.isArray(db.creds) ? db.creds : [],
    subs: Array.isArray(db.subs) ? db.subs : [],
    invites: Array.isArray(db.invites) ? db.invites : [],
    deviceLinks: Array.isArray(db.deviceLinks) ? db.deviceLinks : []
  };
}

export function readStateFiles(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { names = []; }
  return names
    .filter(f => /^state-.+\.json$/.test(f))
    .map(f => {
      const uid = f.slice('state-'.length, -'.json'.length);
      let data = null;
      let parseError = null;
      try { data = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); }
      catch (e) { parseError = e.message; }
      return { uid, file: f, data, parseError };
    });
}

function newCounter() { return { read: 0, inserted: 0, updated: 0, skipped: 0 }; }

// Runs `sql`, which must end in `RETURNING (xmax = 0) AS inserted`, and bumps `counter`.
async function upsert(client, counter, sql, params) {
  const { rows } = await client.query(sql, params);
  if (rows[0]?.inserted) counter.inserted++; else counter.updated++;
}

async function importUsers(client, users, counters, warn) {
  const validIds = new Set();
  for (const u of users) {
    counters.users.read++;
    if (!isRecord(u) || typeof u.id !== 'string' || !u.id || typeof u.name !== 'string' || !u.name) {
      counters.users.skipped++;
      warn(`users: skipped a record missing id/name (${JSON.stringify(u).slice(0, 120)})`);
      continue;
    }
    const extra = {};
    for (const k of Object.keys(u)) if (!USER_FIELDS.includes(k)) extra[k] = u[k];
    await upsert(client, counters.users, `
      INSERT INTO users (id, name, email, admin, disabled, session_version, password_hash,
        password_set_at, password_reset_hash, password_reset_expires_at, last_pull_at, created_at, extra)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, email = EXCLUDED.email, admin = EXCLUDED.admin, disabled = EXCLUDED.disabled,
        session_version = EXCLUDED.session_version, password_hash = EXCLUDED.password_hash,
        password_set_at = EXCLUDED.password_set_at, password_reset_hash = EXCLUDED.password_reset_hash,
        password_reset_expires_at = EXCLUDED.password_reset_expires_at, last_pull_at = EXCLUDED.last_pull_at,
        created_at = EXCLUDED.created_at, extra = EXCLUDED.extra
      RETURNING (xmax = 0) AS inserted
    `, [
      u.id, u.name, u.email || null, u.admin === true, !!u.disabled, Number.isInteger(u.sv) ? u.sv : 0,
      u.pw?.h || null, isoDate(u.pw?.set), u.pwReset?.h || null, epochDate(u.pwReset?.exp),
      epochDate(u.lastPull), isoDate(u.created) || new Date(), extra
    ]);
    validIds.add(u.id);
  }
  return validIds;
}

async function importInvites(client, invites, validUserIds, counters, warn) {
  const validCodes = new Set();
  for (const i of invites) {
    counters.invites.read++;
    if (!isRecord(i) || typeof i.code !== 'string' || !i.code) {
      counters.invites.skipped++;
      warn(`invites: skipped a record missing code (${JSON.stringify(i).slice(0, 120)})`);
      continue;
    }
    let createdBy = i.createdBy || null;
    if (createdBy && !validUserIds.has(createdBy)) { warn(`invites: ${i.code} createdBy ${createdBy} not found, left null`); createdBy = null; }
    let usedBy = i.usedBy || null;
    if (usedBy && !validUserIds.has(usedBy)) { warn(`invites: ${i.code} usedBy ${usedBy} not found, left null`); usedBy = null; }
    await upsert(client, counters.invites, `
      INSERT INTO invites (code, note, created_by, created_at, used_by, used_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (code) DO UPDATE SET
        note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at,
        used_by = EXCLUDED.used_by, used_at = EXCLUDED.used_at
      RETURNING (xmax = 0) AS inserted
    `, [i.code, i.note || null, createdBy, isoDate(i.created) || new Date(), usedBy, isoDate(i.usedAt)]);
    validCodes.add(i.code);
  }
  return validCodes;
}

// Second pass: backfill the two self/cross-referential columns left NULL above, now that every
// user and invite from this import exists.
async function backfillUserReferences(client, users, validUserIds, validInviteCodes, warn) {
  for (const u of users) {
    if (!isRecord(u) || typeof u.id !== 'string' || !validUserIds.has(u.id)) continue;
    if (u.invitedBy) {
      if (validInviteCodes.has(u.invitedBy)) {
        await client.query('UPDATE users SET invited_by = $1 WHERE id = $2', [u.invitedBy, u.id]);
      } else {
        warn(`users: ${u.id} invitedBy ${u.invitedBy} not found, left null`);
      }
    }
    if (u.pwReset?.by) {
      if (validUserIds.has(u.pwReset.by)) {
        await client.query('UPDATE users SET password_reset_by = $1 WHERE id = $2', [u.pwReset.by, u.id]);
      } else {
        warn(`users: ${u.id} pwReset.by ${u.pwReset.by} not found, left null`);
      }
    }
  }
}

async function importPasskeys(client, creds, validUserIds, counters, warn) {
  for (const c of creds) {
    counters.passkeys.read++;
    if (!isRecord(c) || typeof c.id !== 'string' || !c.id || typeof c.publicKey !== 'string' || !c.publicKey || typeof c.userId !== 'string') {
      counters.passkeys.skipped++;
      warn(`passkeys: skipped a record missing id/publicKey/userId (${JSON.stringify(c).slice(0, 120)})`);
      continue;
    }
    if (!validUserIds.has(c.userId)) {
      counters.passkeys.skipped++;
      warn(`passkeys: ${c.id} references unknown user ${c.userId}, skipped`);
      continue;
    }
    await upsert(client, counters.passkeys, `
      INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id, public_key = EXCLUDED.public_key, counter = EXCLUDED.counter,
        transports = EXCLUDED.transports, name = EXCLUDED.name, created_at = EXCLUDED.created_at,
        last_used_at = EXCLUDED.last_used_at
      RETURNING (xmax = 0) AS inserted
    `, [
      c.id, c.userId, c.publicKey, Number.isInteger(c.counter) ? c.counter : 0,
      Array.isArray(c.transports) ? c.transports.filter(t => typeof t === 'string') : [],
      c.name || null, isoDate(c.created) || new Date(), isoDate(c.lastUsed)
    ]);
  }
}

async function importPushSubscriptions(client, subs, validUserIds, counters, warn) {
  for (const s of subs) {
    counters.push_subscriptions.read++;
    if (!isRecord(s) || typeof s.endpoint !== 'string' || !s.endpoint || typeof s.userId !== 'string'
      || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') {
      counters.push_subscriptions.skipped++;
      warn(`push_subscriptions: skipped a record missing endpoint/userId/keys (${JSON.stringify(s).slice(0, 120)})`);
      continue;
    }
    if (!validUserIds.has(s.userId)) {
      counters.push_subscriptions.skipped++;
      warn(`push_subscriptions: endpoint for unknown user ${s.userId}, skipped`);
      continue;
    }
    await upsert(client, counters.push_subscriptions, `
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        device_id = EXCLUDED.device_id, created_at = EXCLUDED.created_at
      RETURNING (xmax = 0) AS inserted
    `, [s.userId, s.endpoint, s.keys.p256dh, s.keys.auth, s.deviceId || null, isoDate(s.created) || new Date()]);
  }
}

async function importDeviceLinks(client, links, validUserIds, counters, warn) {
  for (const l of links) {
    counters.device_links.read++;
    const exp = epochDate(l?.exp);
    if (!isRecord(l) || typeof l.h !== 'string' || !l.h || typeof l.userId !== 'string' || !exp) {
      counters.device_links.skipped++;
      warn(`device_links: skipped a record missing h/userId/exp (${JSON.stringify(l).slice(0, 120)})`);
      continue;
    }
    if (!validUserIds.has(l.userId)) {
      counters.device_links.skipped++;
      warn(`device_links: ${l.h.slice(0, 8)}… references unknown user ${l.userId}, skipped`);
      continue;
    }
    await upsert(client, counters.device_links, `
      INSERT INTO device_links (hash, user_id, expires_at, created_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (hash) DO UPDATE SET
        user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at
      RETURNING (xmax = 0) AS inserted
    `, [l.h, l.userId, exp, epochDate(l.created) || new Date()]);
  }
}

async function importUserState(client, stateFiles, validUserIds, counters, warn) {
  for (const { uid, file, data, parseError } of stateFiles) {
    counters.user_state.read++;
    if (parseError) {
      counters.user_state.skipped++;
      warn(`user_state: ${file} is not valid JSON (${parseError}), skipped`);
      continue;
    }
    if (!isRecord(data)) {
      counters.user_state.skipped++;
      warn(`user_state: ${file} does not contain a JSON object, skipped`);
      continue;
    }
    if (!validUserIds.has(uid)) {
      counters.user_state.skipped++;
      warn(`user_state: ${file} has no matching user ${uid}, skipped (orphan)`);
      continue;
    }
    const rev = Number.isInteger(data._rev) ? data._rev : 0;
    const { rows } = await client.query(`
      INSERT INTO user_state (user_id, state, rev, updated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, rev = EXCLUDED.rev, updated_at = now()
      WHERE EXCLUDED.rev > user_state.rev
      RETURNING (xmax = 0) AS inserted
    `, [uid, data, rev]);
    if (rows.length === 0) counters.user_state.skipped++;
    else if (rows[0].inserted) counters.user_state.inserted++;
    else counters.user_state.updated++;
  }
}

// Does the whole import inside one transaction on `client`. Never commits/rolls back itself —
// the caller decides, so a dry run can inspect the same counts a real run would produce.
export async function runImport(client, dataDir, { warn = () => {} } = {}) {
  const counters = {
    users: newCounter(), invites: newCounter(), passkeys: newCounter(),
    push_subscriptions: newCounter(), device_links: newCounter(), user_state: newCounter()
  };
  const { users, creds, subs, invites, deviceLinks } = readJsonDb(dataDir);
  const stateFiles = readStateFiles(dataDir);

  const validUserIds = await importUsers(client, users, counters, warn);
  const validInviteCodes = await importInvites(client, invites, validUserIds, counters, warn);
  await backfillUserReferences(client, users, validUserIds, validInviteCodes, warn);
  await importPasskeys(client, creds, validUserIds, counters, warn);
  await importPushSubscriptions(client, subs, validUserIds, counters, warn);
  await importDeviceLinks(client, deviceLinks, validUserIds, counters, warn);
  await importUserState(client, stateFiles, validUserIds, counters, warn);

  return counters;
}

export function formatReport(counters, { dryRun } = {}) {
  const rows = Object.entries(counters);
  const width = Math.max(...rows.map(([name]) => name.length));
  const lines = [
    dryRun ? '--dry-run: nothing was persisted' : 'import complete',
    `${'table'.padEnd(width)}  read  inserted  updated  skipped`,
    ...rows.map(([name, c]) => `${name.padEnd(width)}  ${String(c.read).padStart(4)}  ${String(c.inserted).padStart(8)}  ${String(c.updated).padStart(7)}  ${String(c.skipped).padStart(7)}`)
  ];
  return lines.join('\n');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataDir = process.env.DATA_DIR;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dataDir) { console.error('DATA_DIR is required'); process.exit(1); }
  if (!databaseUrl) { console.error('DATABASE_URL is required'); process.exit(1); }

  const { pool } = await connectAndMigrate(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counters = await runImport(client, dataDir, { warn: msg => console.warn('  ' + msg) });
    if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
    console.log(formatReport(counters, { dryRun }));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('import failed, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
