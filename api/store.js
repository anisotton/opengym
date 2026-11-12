/* PostgreSQL-backed access for db.json / state-<uid>.json (ISO-1403, Phase 1b — the last db.json
 * collection, passkey credentials, moved in this pass too): a profile's training data
 * (user_state), `users` itself — identity, passwords, admin/disabled flags, session_version —
 * invites, push subscriptions, device links and now passkeys.
 */

import { makeLinkCode, hashLinkCode, DEVICE_LINK_TTL_MS } from './device-link.js';
import { passkeyName, transportsOf, MAX_PASSKEYS } from './passkeys-store.js';
import { newProgramId, diffForEvent, titleMatchesForPurge } from './programs.js';
import { newId, acceptProblem, MAX_ACTIVE_INVITES, MAX_NOTES_PER_STUDENT } from './teacher.js';
import { withTransaction } from './db.js';

// The lock insertPasskey's cap check already takes, keyed on the account rather than any one
// table: whether a password or a passkey still signs a profile in is decided across both the
// `users` and `passkeys` tables, so a count-then-act confined to just one of them (even inside
// its own transaction) can still race a concurrent one on the other table — each reads the other
// table's pre-commit state and both removals go through, exactly the ISO-1592 bug. Serializing
// every such check-then-act on this one lock makes the second caller wait for the first's commit
// (or rollback) before it reads anything, so it always sees the first's result rather than a
// snapshot from before it landed. `pool.release` exists only on a checked-out client, never on
// the Pool itself, which is what tells a caller already inside someone else's transaction (passes
// that transaction's client here) apart from one that still needs its own.
async function withWayInLock(pool, userId, run) {
  const body = async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    return run(client);
  };
  return typeof pool.release === 'function' ? body(pool) : withTransaction(pool, body);
}

// { state, rev } — state is null and rev is 0 for a profile that has never pushed, exactly what
// GET /api/data returned for a state file that did not exist yet.
export async function getUserState(pool, userId) {
  const { rows } = await pool.query('SELECT state, rev FROM user_state WHERE user_id = $1', [userId]);
  return rows.length ? { state: rows[0].state, rev: Number(rows[0].rev) } : { state: null, rev: 0 };
}

// Just the revision — one narrow column, never the (possibly multi-MB) state jsonb. This is what
// used to need the file-stat cache in server.js; a plain query here already does not pay to parse
// the document, so the cache had nothing left to save and is gone.
export async function getUserStateRev(pool, userId) {
  const { rows } = await pool.query('SELECT rev FROM user_state WHERE user_id = $1', [userId]);
  return rows.length ? Number(rows[0].rev) : 0;
}

// Optimistic write with a lock-free compare-and-set: `decide(cur, curRev)` inspects the row this
// call just read and returns either `{ conflict: true }` (curRev did not match the caller's
// baseRev — nothing is written) or `{ state: nextState }`, the exact document to store. The
// UPDATE is conditioned on the `curRev` this call read; if a concurrent writer for the same user
// landed first, zero rows match and the loop re-reads and calls `decide` again with the fresh
// row — so a real race is resolved as a conflict against the *latest* state, never a lost update,
// and two profiles never block each other the way a row lock would.
export async function putUserState(pool, userId, decide) {
  for (;;) {
    const { rows } = await pool.query('SELECT state, rev FROM user_state WHERE user_id = $1', [userId]);
    const cur = rows.length ? rows[0].state : null;
    const curRev = rows.length ? Number(rows[0].rev) : 0;
    const decision = decide(cur, curRev);
    if (decision.conflict) return { conflict: true, rev: curRev, state: cur };
    const nextRev = curRev + 1;
    if (rows.length) {
      const { rowCount } = await pool.query(
        'UPDATE user_state SET state = $1, rev = $2, updated_at = now() WHERE user_id = $3 AND rev = $4',
        [decision.state, nextRev, userId, curRev]
      );
      if (rowCount === 0) continue; // lost the race — another write landed first, retry against it
    } else {
      const { rowCount } = await pool.query(
        'INSERT INTO user_state (user_id, state, rev) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
        [userId, decision.state, nextRev]
      );
      if (rowCount === 0) continue; // someone else's first write beat us to it, retry against it
    }
    return { conflict: false, rev: nextRev, state: decision.state };
  }
}

/* ---------- users (not wired into server.js yet — see the module comment above) ---------- */

// Maps a `users` row back to the same shape server.js has always built from db.json: `pw`/
// `pwReset` as the nested objects hasPassword()/resetCodeMatches() expect, epoch-ms numbers for
// `lastPull`/`pwReset.exp` (the columns are timestamptz; db.json always held these as numbers),
// an ISO string for `created` (db.json's own format), and optional fields only present when set
// — `'email' in user` and friends are exactly as meaningful as they were on the file-backed
// object. `extra` holds `lastReminder` (no dedicated column) and, for now, `invitedBy` too — see
// createUser for why.
function rowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    created: row.created_at.toISOString(),
    admin: row.admin,
    disabled: row.disabled,
    sv: row.session_version,
    role: row.role,
    ...(row.email ? { email: row.email } : {}),
    ...(row.email_verified_at ? { emailVerifiedAt: row.email_verified_at.toISOString() } : {}),
    ...(row.terms_accepted_version ? { termsAcceptedVersion: row.terms_accepted_version } : {}),
    ...(row.terms_accepted_at ? { termsAcceptedAt: row.terms_accepted_at.toISOString() } : {}),
    ...(row.birth_date ? { birthDate: row.birth_date.toISOString().slice(0, 10) } : {}),
    ...(row.stripe_customer_id ? { stripeCustomerId: row.stripe_customer_id } : {}),
    ...(row.invited_by || row.extra?.invitedBy ? { invitedBy: row.invited_by || row.extra.invitedBy } : {}),
    ...(row.password_hash
      ? { pw: { h: row.password_hash, set: row.password_set_at.toISOString() } }
      : {}),
    ...(row.password_reset_hash
      ? { pwReset: { h: row.password_reset_hash, exp: row.password_reset_expires_at.getTime(), by: row.password_reset_by } }
      : {}),
    ...(row.last_pull_at ? { lastPull: row.last_pull_at.getTime() } : {}),
    ...(row.extra?.lastReminder ? { lastReminder: row.extra.lastReminder } : {})
  };
}

export async function getUserById(pool, id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows.length ? rowToUser(rows[0]) : null;
}

// Every user, oldest first — db.json's own array order, since nothing ever sorted it. Small
// instances only: callers that today do `db.users.find(...)`/`.some(...)` (name/e-mail
// uniqueness, sign-in lookup) call this once and reuse the same predicates against the array,
// rather than this module re-deriving nameKey()'s normalisation in SQL.
export async function getAllUsers(pool) {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at');
  return rows.map(rowToUser);
}

// `user`: { id, name, created, email?, pw?: { h, set }, invitedBy? } — the exact shape
// registration already builds. A duplicate id or e-mail is the caller's to have ruled out first
// (both are real constraints here too, as a backstop, and surface as a thrown error).
//
// `invitedBy` goes into `extra`, not the `invited_by` column: that column has a foreign key on
// invites(code), and invites have not moved to PostgreSQL yet (a later slice) — an invite code
// that is only ever in db.json cannot be referenced from a Postgres row. `extra` holds it until
// then, same as `lastReminder`; rowToUser reads either place.
export async function createUser(pool, user) {
  await pool.query(
    `INSERT INTO users (id, name, email, birth_date, password_hash, password_set_at, created_at, extra,
       terms_accepted_version, terms_accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      user.id, user.name, user.email || null, user.birthDate || null,
      user.pw?.h || null, user.pw?.set || null, user.created, extraOf(user),
      user.termsAcceptedVersion || null, user.termsAcceptedAt || null
    ]
  );
}

// Records the Terms/Privacy version an existing account accepted and when (ISO-1390). Called for
// accounts that predate the acceptance step, or when LEGAL_VERSION moves on and they re-accept.
export async function setTermsAccepted(pool, id, version, at) {
  await pool.query(
    'UPDATE users SET terms_accepted_version = $2, terms_accepted_at = $3 WHERE id = $1',
    [id, version, at]
  );
}

function extraOf(user) {
  return {
    ...(user.invitedBy ? { invitedBy: user.invitedBy } : {}),
    ...(user.lastReminder ? { lastReminder: user.lastReminder } : {})
  };
}

// Upsert, full shape — boot's one-time backfill of every user already in db.json into Postgres,
// same fields createUser writes for a brand new one plus the ones only an existing account can
// already have (admin, disabled, session_version, a reset in progress, lastPull/lastReminder).
// ON CONFLICT so re-running boot (a restart) is a no-op once every user is a real row here rather
// than db.json's copy — server.js still updates db.json too until the routes below stop reading
// it, so the two must not drift apart in between.
//
// `password_reset_by` is left for backfillPasswordResetBy below, not set here: it is
// self-referential (users.id), and db.json's users arrive in no particular order — the admin who
// issued a pending reset may not have a row yet when the user holding that reset is upserted.
// Same two-pass shape as scripts/import-json.js, for the same reason.
export async function upsertUser(pool, user) {
  await pool.query(
    `INSERT INTO users (id, name, email, admin, disabled, session_version, password_hash,
       password_set_at, password_reset_hash, password_reset_expires_at, last_pull_at, created_at, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, email = EXCLUDED.email, admin = EXCLUDED.admin, disabled = EXCLUDED.disabled,
       session_version = EXCLUDED.session_version, password_hash = EXCLUDED.password_hash,
       password_set_at = EXCLUDED.password_set_at, password_reset_hash = EXCLUDED.password_reset_hash,
       password_reset_expires_at = EXCLUDED.password_reset_expires_at, last_pull_at = EXCLUDED.last_pull_at,
       created_at = EXCLUDED.created_at, extra = EXCLUDED.extra`,
    [
      user.id, user.name, user.email || null, user.admin === true, !!user.disabled,
      Number.isInteger(user.sv) ? user.sv : 0, user.pw?.h || null, user.pw?.set || null,
      user.pwReset?.h || null, user.pwReset?.exp ? new Date(user.pwReset.exp) : null,
      user.lastPull ? new Date(user.lastPull) : null, user.created, extraOf(user)
    ]
  );
}

// Second pass: only meaningful for a user upsertUser just gave a password_reset_hash to, and only
// once every user from the same boot pass has a row — see upsertUser above. A no-op (0 rows) for
// anyone without a pending reset, or without a `by` to record. `by` naming an admin outside this
// same db.json (deleted since, or a test fixture that only seeds one side of the pair) cannot
// satisfy the column's foreign key — left unset rather than failing the whole boot over what was
// always just a display value ("who issued this code").
export async function backfillPasswordResetBy(pool, id, by) {
  if (!by) return;
  try {
    await pool.query('UPDATE users SET password_reset_by = $1 WHERE id = $2 AND password_reset_hash IS NOT NULL', [by, id]);
  } catch (e) {
    if (e.code !== '23503') throw e; // not foreign_key_violation — a real problem, not a dangling by
  }
}

// setPassword's `delete user.pwReset` alongside `user.pw = {...}` in one statement: a fresh
// password and a pending reset can never both be live.
export async function setPassword(pool, id, pw) {
  await pool.query(
    `UPDATE users SET password_hash = $1, password_set_at = $2,
       password_reset_hash = NULL, password_reset_expires_at = NULL, password_reset_by = NULL
     WHERE id = $3`,
    [pw.h, pw.set, id]
  );
}

export async function removePassword(pool, id) {
  await pool.query('UPDATE users SET password_hash = NULL, password_set_at = NULL WHERE id = $1', [id]);
}

async function hasLivePassword(client, id) {
  const { rows } = await client.query('SELECT password_hash FROM users WHERE id = $1', [id]);
  return rows.length > 0 && rows[0].password_hash !== null;
}

// removePassword with the "never the last way in" rule built in, atomically: server.js used to
// check hasPassword()/passkeyCount() against a snapshot taken before proveOwner's await (a slow
// hash, or a WebAuthn ceremony), so a passkey removal landing in that window left nothing. Both
// the password and the passkey count are read fresh here, inside the per-account lock
// removePasskey now takes too (ISO-1592), so whichever of the two commits second always sees the
// other's result rather than a pre-race read. `googleCounts` is GOOGLE_LOGIN (ISO-1597) — a server
// setting, not account data, so it is safe for the caller to hand in from before any await;
// whether this account currently *has* a linked Google identity is account data, read fresh here
// instead, under the same lock, same split as removePasskey's own `passwordCounts`.
export async function removePasswordUnlessLast(pool, id, googleCounts = false) {
  const run = async client => {
    if (!(await hasLivePassword(client, id))) return { ok: true }; // already gone — nothing to refuse
    const { rows } = await client.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1', [id]);
    const otherWays = rows[0].n + (googleCounts && await hasLiveOAuthIdentity(client, id, 'google') ? 1 : 0);
    if (otherWays < 1) return { error: 'the password is the only way into this profile', code: 'last-way-in' };
    await client.query('UPDATE users SET password_hash = NULL, password_set_at = NULL WHERE id = $1', [id]);
    return { ok: true };
  };
  return withWayInLock(pool, id, run);
}

// A sign-in re-hashing an existing password at today's cost parameters — not a new password: only
// the hash changes, password_set_at stays what it was.
export async function rehashPassword(pool, id, h) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [h, id]);
}

// The admin reset route's `delete u.pw; u.pwReset = {...}` — same one-statement guarantee as
// setPassword, the other direction: issuing a reset code always drops whatever password was live.
export async function setPasswordReset(pool, id, reset) {
  await pool.query(
    `UPDATE users SET password_hash = NULL, password_set_at = NULL,
       password_reset_hash = $1, password_reset_expires_at = $2, password_reset_by = $3
     WHERE id = $4`,
    [reset.h, new Date(reset.exp), reset.by, id]
  );
}

// Returns the new value, the way `user.sv = sessionVersion(user) + 1` always left it on hand —
// computed in SQL rather than read-then-write, so two concurrent bumps (a password change and a
// "sign out everywhere" landing together) both count instead of one clobbering the other.
export async function bumpSessionVersion(pool, id) {
  const { rows } = await pool.query(
    'UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version',
    [id]
  );
  return rows[0]?.session_version;
}

// Always clears email_verified_at too, whichever way this is called: a changed address has not
// been proven to belong to anyone (ISO-1397's confirmation link is what sets it back,
// markEmailVerified below), and removing the address (email === null) leaves nothing to have been
// verified. The one-statement guarantee is the same reason setPassword clears pwReset alongside
// password_hash: the two must never read inconsistent with each other.
export async function setEmail(pool, id, email) {
  await pool.query('UPDATE users SET email = $1, email_verified_at = NULL WHERE id = $2', [email, id]);
}

// The confirmation link's own claim (POST /api/account/email/verify), once the token it carried
// has already been consumed (consumeEmailToken) — never set on its own, since nothing else here
// has proven the address belongs to the account.
export async function markEmailVerified(pool, id) {
  await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [id]);
}

export async function setDisabled(pool, id, disabled) {
  await pool.query('UPDATE users SET disabled = $1 WHERE id = $2', [disabled, id]);
}

export async function touchLastPull(pool, id, whenMs) {
  await pool.query('UPDATE users SET last_pull_at = $1 WHERE id = $2', [new Date(whenMs), id]);
}

// Set once, the first time an account checks out (billing.js creates the Stripe customer lazily,
// on that first POST /api/billing/checkout) — never reassigned after. The column's own UNIQUE
// constraint (migrations/004) is what lets every webhook handler below resolve an event straight
// back to an account from `event.data.object.customer` alone, with no dependency on `metadata`
// surviving whichever event type Stripe happens to send.
export async function setStripeCustomerId(pool, id, customerId) {
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, id]);
}

export async function getUserIdByStripeCustomer(pool, customerId) {
  const { rows } = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
  return rows.length ? rows[0].id : null;
}

export async function setLastReminder(pool, id, date) {
  await pool.query(
    "UPDATE users SET extra = jsonb_set(extra, '{lastReminder}', to_jsonb($1::text)) WHERE id = $2",
    [date, id]
  );
}

// CASCADEs to user_state, passkeys/sessions/push_subscriptions, (ISO-1597) oauth_identities, and
// (ISO-1609) teacher_links/teacher_notes/teacher_invites of a deleted teacher — but not
// teacher_assignments.teacher_id,
// which is ON DELETE SET NULL rather than CASCADE (a student's assignment history has to survive
// the teacher who made it being gone). Ending every active link first, before the row goes, is
// what actually closes out each one's assignment (end_reason 'role-revoked') — D14's rule that
// losing the teacher role ends the active assignment applies just as much to deleting the
// account outright, the most permanent way that role is lost. Called with `pool` or a
// transaction client (same duck-typing as consumeInvite/insertPasskey); deleteAccount (server.js)
// always passes the latter, so this runs in the same transaction as the row's own delete.
export async function deleteUser(pool, id) {
  await endAllLinksOfTeacher(pool, id, 'role-revoked');
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

/* ---------- sessions ----------
 * One row per cookie/bearer token actually issued by a login or registration ceremony, so
 * POST /api/logout can revoke the one that made the request instead of the account's every
 * session ("sign out everywhere" — POST /api/logout/all — still works the old way, by bumping
 * users.session_version, which invalidates every session at once regardless of these rows).
 * server.js embeds the row's id in the signed cookie payload; a cookie with no id in it (minted
 * by a build before this table existed, or forged directly in a test without a real login) has
 * nothing here to revoke and is read as valid by session_version alone, same as always.
 */

export async function createSession(pool, { userId, expiresAt, userAgent }) {
  const { rows } = await pool.query(
    'INSERT INTO sessions (user_id, expires_at, user_agent) VALUES ($1, $2, $3) RETURNING id',
    [userId, new Date(expiresAt), userAgent ? String(userAgent).slice(0, 300) : null]
  );
  return rows[0].id;
}

// null for an id that was never a session (or the row aged out — nothing prunes this table yet;
// out of scope here) — sessionOf treats that the same as a revoked or expired one.
export async function getSession(pool, id) {
  const { rows } = await pool.query('SELECT user_id, revoked_at FROM sessions WHERE id = $1', [id]);
  return rows.length ? { userId: rows[0].user_id, revoked: rows[0].revoked_at != null } : null;
}

export async function revokeSession(pool, id) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

/* ---------- invites ----------
 * `created_by` carries a foreign key on users(id) — `used_by` deliberately does not (see
 * migrations/001_init.sql): a burned code has to stay burned even after the account that burned
 * it is deleted, or admin/user/delete would quietly free it back up on an invite-only instance.
 * consumeInvite still only takes a userId that already exists, though — a registration route has
 * to create its user row before consuming the invite that let them in, and the two need to commit
 * or fail together (an invite consumed by a request whose user row then never landed would be
 * burned for nothing). Pass a transaction client in place of `pool` to any of these — they only
 * ever call `.query` on it, so a `db.js` withTransaction client duck-types as one.
 */

function rowToInvite(row) {
  return {
    code: row.code,
    ...(row.note ? { note: row.note } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    created: row.created_at.toISOString(),
    ...(row.used_by ? { usedBy: row.used_by, usedAt: row.used_at.toISOString() } : {})
  };
}

export async function createInvite(pool, { code, note, createdBy }) {
  await pool.query(
    'INSERT INTO invites (code, note, created_by) VALUES ($1, $2, $3)',
    [code, note || null, createdBy || null]
  );
}

export async function getAllInvites(pool) {
  const { rows } = await pool.query('SELECT * FROM invites ORDER BY created_at');
  return rows.map(rowToInvite);
}

export async function codeExists(pool, code) {
  const { rows } = await pool.query('SELECT 1 FROM invites WHERE code = $1', [code]);
  return rows.length > 0;
}

// A read-only check, for the two points server.js wants to know "is this still good" without
// claiming it: /api/register/options (before the WebAuthn ceremony even starts) and the
// INVITE_ONLY gate on /api/register/password. Not the thing that makes a code single-use — that's
// consumeInvite, called once, right before the user it let in is a real row.
export async function inviteIsValid(pool, code) {
  const { rows } = await pool.query('SELECT 1 FROM invites WHERE code = $1 AND used_by IS NULL', [code]);
  return rows.length > 0;
}

// Atomic single-use claim: `used_by IS NULL` in the WHERE clause is what db.json's `!i.usedBy`
// check meant back when a read and a write couldn't be interleaved by another request — two
// requests racing the same code now race this UPDATE instead, and only one matches a row. Returns
// whether THIS call was the one that won.
export async function consumeInvite(pool, code, userId) {
  const { rowCount } = await pool.query(
    'UPDATE invites SET used_by = $1, used_at = now() WHERE code = $2 AND used_by IS NULL',
    [userId, code]
  );
  return rowCount > 0;
}

// Revoking is deletion (matches db.json — there was never a `.revoked` flag, see migrations/001).
// Refuses a code already used, same as before: freeing it would quietly let someone else in on
// it, and the account it already let in stays in either way.
export async function revokeInvite(pool, code) {
  const { rowCount } = await pool.query('DELETE FROM invites WHERE code = $1 AND used_by IS NULL', [code]);
  return rowCount > 0;
}

// Boot's one-time migration of whatever db.json still holds, same idea as upsertUser. Preserves
// the original createdAt/usedAt rather than stamping now() — this is importing history, not
// issuing or consuming a code live. `createdBy` naming a user this db.json doesn't have (deleted
// since, or a test fixture missing it) can't satisfy the foreign key on that column — retried with
// it dropped rather than failing the whole boot over what is, in the end, just a display value.
// `usedBy` carries no such constraint (see the comment above this section) and never needs a retry.
export async function upsertInvite(pool, { code, note, createdBy, created, usedBy, usedAt }) {
  const values = [
    code, note || null, createdBy || null, created ? new Date(created) : new Date(),
    usedBy || null, usedAt ? new Date(usedAt) : null
  ];
  const sql = `
    INSERT INTO invites (code, note, created_by, created_at, used_by, used_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (code) DO UPDATE SET
      note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at,
      used_by = EXCLUDED.used_by, used_at = EXCLUDED.used_at`;
  try {
    await pool.query(sql, values);
  } catch (e) {
    if (e.code !== '23503') throw e; // not foreign_key_violation
    await pool.query(sql, [values[0], values[1], null, values[3], values[4], values[5]]);
  }
}

/* ---------- push subscriptions ----------
 * One row per browser/device, keyed on its own `endpoint` (unique) rather than on the user —
 * `user_id` is just which account a send belongs to. `upsertSub`'s ON CONFLICT (endpoint) is the
 * same "the client re-sends its subscription on every boot" upsert db.json always did: the SET
 * clause never touches created_at, so a row's original created date survives being sent again.
 */

function rowToSub(row) {
  return {
    userId: row.user_id, endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth },
    ...(row.device_id ? { deviceId: row.device_id } : {}),
    created: row.created_at.toISOString()
  };
}

export async function upsertSub(pool, { userId, endpoint, keys, deviceId, created }) {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_id, created_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()))
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device_id = EXCLUDED.device_id`,
    [userId, endpoint, keys.p256dh, keys.auth, deviceId || null, created ? new Date(created) : null]
  );
}

// MAX_SUBS_PER_USER enforcement: drop the oldest rows of this user beyond `max`, keeping the
// newest — same intent as db.json's `mine.slice(0, ...)` did, now as one DELETE.
export async function capUserSubs(pool, userId, max) {
  await pool.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
     )`,
    [userId, max]
  );
}

export async function getUserSubs(pool, userId) {
  const { rows } = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  return rows.map(rowToSub);
}

// The reminder tick's own filter, done once per tick rather than once per user (getUserSubs in a
// loop would be a query per account every 10 s) — same shape db.subs.some(...) let it check
// in memory before this moved.
export async function getUserIdsWithPush(pool) {
  const { rows } = await pool.query('SELECT DISTINCT user_id FROM push_subscriptions');
  return new Set(rows.map(r => r.user_id));
}

export async function hasPush(pool, userId) {
  const { rows } = await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
  return rows.length > 0;
}

export async function subStatus(pool, userId, endpoint) {
  const { rows } = await pool.query(
    'SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]
  );
  return rows.length > 0;
}

// Send-time pruning (a dead or refused endpoint) and Settings' unsubscribe both just need the
// row gone — the first by endpoint alone (sendPush already filtered to the one user's rows), the
// second scoped to the caller's own account so one user can never unsubscribe another's device.
export async function deleteSub(pool, endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function unsubscribe(pool, userId, endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/* ---------- device links ----------
 * One row per profile — `createDeviceLink` clears any earlier one first, same "a new one replaces
 * the one before" rule db.json's own code always had. Expired rows are never read back
 * (`expires_at > now()` on every lookup) rather than actively swept on a timer; the opportunistic
 * deletes below just keep the table from growing forever on an instance nobody restarts often.
 */

function rowToDeviceLink(row) {
  return { h: row.hash, userId: row.user_id, exp: row.expires_at.getTime(), created: row.created_at.getTime() };
}

// → { code, link }. The code is returned once and never stored — only its hash is.
export async function createDeviceLink(pool, userId, ttlMs = DEVICE_LINK_TTL_MS) {
  await pool.query('DELETE FROM device_links WHERE expires_at <= now()');
  await pool.query('DELETE FROM device_links WHERE user_id = $1', [userId]);
  const code = makeLinkCode();
  const hash = hashLinkCode(code);
  const now = Date.now();
  const exp = new Date(now + ttlMs);
  // created_at passed explicitly rather than left to the column's own now() default, so the
  // returned link and a fresh findDeviceLink read of the same row always agree to the millisecond.
  await pool.query(
    'INSERT INTO device_links (hash, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4)',
    [hash, userId, exp, new Date(now)]
  );
  return { code, link: { h: hash, userId, exp: exp.getTime(), created: now } };
}

// The live link a code belongs to, or null — a wrong code, a used one and an expired one all look
// the same from outside. Finding a link does not use it up; burnDeviceLink does. A fresh call
// with the same code answering non-null again only ever proves the link was *still there when
// this query ran* — not that it will still be there once whatever runs after it gets around to
// burning it. A second call racing in between can find the exact same "still there" answer, so
// checking existence again is not a substitute for claiming the row atomically (burnDeviceLink's
// own rowCount) before doing anything the claim is meant to gate.
export async function findDeviceLink(pool, code) {
  const { rows } = await pool.query(
    'SELECT * FROM device_links WHERE hash = $1 AND expires_at > now()', [hashLinkCode(code)]
  );
  return rows.length ? rowToDeviceLink(rows[0]) : null;
}

// The atomic single-use claim: whether *this* call was the one that deleted the row, same
// DELETE-and-check-rowCount shape as revokeInvite. A caller that burns before doing the work the
// burn is meant to gate (not after) is the only way two requests racing the same code can ever
// be told apart — the row is gone for the second one before it does anything with what it found.
export async function burnDeviceLink(pool, hash) {
  const { rowCount } = await pool.query('DELETE FROM device_links WHERE hash = $1', [hash]);
  return rowCount > 0;
}

// Every unused link of a profile, for the moments its sessions end: an unused link is a way in
// waiting to be taken, like a pairing code. Says whether anything went, so a caller can skip work
// that depends on it.
export async function dropDeviceLinks(pool, userId) {
  const { rowCount } = await pool.query('DELETE FROM device_links WHERE user_id = $1', [userId]);
  return rowCount > 0;
}

// Boot's one-time migration of whatever db.json still holds. Already-expired links are imported
// same as any other row — findDeviceLink's own `expires_at > now()` never returns them — rather
// than filtered here, so this has one less thing to get right at the one moment a bug in it would
// be hardest to notice.
export async function upsertDeviceLink(pool, { h, userId, exp, created }) {
  await pool.query(
    `INSERT INTO device_links (hash, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
    [h, userId, new Date(exp), new Date(created)]
  );
}

/* ---------- passkeys ----------
 * `passkeyName`/`transportsOf` (passkeys-store.js) shape what a name or a transports list may
 * keep; everything DB-shaped — the rows, the count, the "never lose the last way in" rule — is
 * here. `otherWays` (passkeyRemovalRefused) is how many ways besides its passkeys can still sign
 * the profile in (a password, while the instance offers password sign-in) — server.js's own
 * cheap pre-proof guess, since a wrong one there costs at most a prompt. `removePasskey` takes
 * `passwordCounts` (PASSWORD_LOGIN, a server setting server.js still owns) but decides for itself
 * whether a password currently exists — account data, read fresh under its own lock rather than
 * handed in — because that is the one answer this profile's access actually depends on
 * (ISO-1592).
 */

function rowToPasskey(row) {
  return {
    id: row.id, userId: row.user_id, publicKey: row.public_key, counter: Number(row.counter),
    transports: row.transports || [],
    ...(row.name ? { name: row.name } : {}),
    created: row.created_at.toISOString(),
    ...(row.last_used_at ? { lastUsed: row.last_used_at.toISOString() } : {})
  };
}

// What the owner sees of their passkeys: never the public key, which nothing on screen needs.
export async function listPasskeys(pool, userId) {
  const { rows } = await pool.query('SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(rowToPasskey).map(c => ({
    id: c.id, name: c.name || null, created: c.created || null, lastUsed: c.lastUsed || null,
    transports: c.transports
  }));
}

export async function getPasskeyById(pool, id) {
  const { rows } = await pool.query('SELECT * FROM passkeys WHERE id = $1', [id]);
  return rows.length ? rowToPasskey(rows[0]) : null;
}

export async function countPasskeys(pool, userId) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1', [userId]);
  return rows[0].n;
}

// The count check and the insert used to be one statement (a subquery in the INSERT's WHERE) on
// the theory that two additions racing the same account couldn't both slip past a count checked
// before either had committed — but a plain SELECT count(*) takes no lock, so two concurrent
// connections each get their own READ COMMITTED snapshot and can both see the same pre-race count
// and both pass. withWayInLock's advisory lock forces the second one to wait for the first to
// commit (or roll back) before it takes its own count, so it sees the row the first one just
// added. Pass a transaction client in place of `pool` to insert alongside the user row a fresh
// signup creates (registration ceremonies do) — same idea as consumeInvite; the lock then lives
// for the rest of that transaction rather than one of its own.
export async function insertPasskey(pool, userId, cred) {
  const name = passkeyName(cred.name);
  const row = {
    id: cred.id, userId, publicKey: cred.publicKey, counter: cred.counter || 0,
    transports: transportsOf(cred.transports), created: cred.created || new Date().toISOString(),
    ...(cred.lastUsed ? { lastUsed: cred.lastUsed } : {}), ...(name ? { name } : {})
  };
  const run = async client => {
    let rowCount;
    try {
      ({ rowCount } = await client.query(
        `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8
         WHERE (SELECT count(*) FROM passkeys WHERE user_id = $2) < $9`,
        [row.id, row.userId, row.publicKey, row.counter, row.transports, row.name || null,
          new Date(row.created), row.lastUsed ? new Date(row.lastUsed) : null, MAX_PASSKEYS]
      ));
    } catch (e) {
      if (e.code === '23505') return { error: 'credential already registered', code: 'credential-exists' }; // unique_violation
      throw e;
    }
    if (rowCount === 0) return { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
    return { ok: true, row };
  };
  return withWayInLock(pool, userId, run);
}

export async function renamePasskey(pool, userId, credId, name) {
  const { rows } = await pool.query(
    'UPDATE passkeys SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [passkeyName(name) || null, credId, userId]
  );
  return rows.length ? { ok: true, row: rowToPasskey(rows[0]) } : { error: 'passkey not found', code: 'not-found' };
}

// Why removing `credId` would be refused, or null when it could go. `otherWays` is a plain count
// handed in by the caller — on its own so server.js can ask before it asks the owner for proof, a
// deliberately cheap, non-atomic pre-check: a stale answer here only costs an unnecessary prompt
// or skips one, never a wrong removal, because removePasskey below decides again, for real.
export async function passkeyRemovalRefused(pool, userId, credId, otherWays = 0) {
  const cred = await getPasskeyById(pool, credId);
  if (!cred || cred.userId !== userId) return { error: 'passkey not found', code: 'not-found' };
  const mine = await countPasskeys(pool, userId);
  if (mine - 1 + otherWays < 1) return { error: 'this passkey is the only way into this profile', code: 'last-way-in' };
  return null;
}

// The authoritative check, atomic. `passwordCounts` is PASSWORD_LOGIN and `googleCounts` is
// GOOGLE_LOGIN (ISO-1597) — server settings, not account data, so they're safe for the caller to
// hand in from before any await; whether this account currently *has* a password or a linked
// Google identity is account data, and is read fresh here instead, inside the same per-account
// lock removePasswordUnlessLast/removeOAuthIdentityUnlessLast take, so none of the three ever see
// "one of the others still covers me" for the same instant (ISO-1592 — server.js used to pass a
// password flag read from a user snapshot taken before proveOwner's await, exactly the gap a
// concurrent removal could land in).
export async function removePasskey(pool, userId, credId, passwordCounts = false, googleCounts = false) {
  const run = async client => {
    const otherWays = (passwordCounts && await hasLivePassword(client, userId) ? 1 : 0)
      + (googleCounts && await hasLiveOAuthIdentity(client, userId, 'google') ? 1 : 0);
    const refused = await passkeyRemovalRefused(client, userId, credId, otherWays);
    if (refused) return refused;
    const { rows } = await client.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING *', [credId, userId]);
    return { ok: true, row: rowToPasskey(rows[0]) };
  };
  return withWayInLock(pool, userId, run);
}

// A passkey's own counter/last-use, touched by every ceremony that verifies an assertion against
// it (sign-in, a step-up proof) — used to be a mutation of the same in-memory row a lookup handed
// back; now its own write, since a read is never the same object twice.
export async function touchPasskeyUse(pool, id, counter) {
  await pool.query('UPDATE passkeys SET counter = $1, last_used_at = now() WHERE id = $2', [counter, id]);
}

/* ---------- oauth identities (ISO-1597) ----------
 * One row per linked external account — today always `provider = 'google'`. `(provider, subject)`
 * is the row's own primary key (one Google account is never linked to two profiles) and
 * `(provider, user_id)` is uniquely indexed (one Google per profile) — both enforced by
 * migrations/009, which is the real backstop against two requests racing the same link; the
 * `23505` catch in insertOAuthIdentity is just this call's half of reporting that race cleanly.
 * `otherWays`/`removeOAuthIdentityUnlessLast` follow the exact same "never the last way in" shape
 * as removePassword/removePasskey above, under the same per-account advisory lock, so a Google
 * unlink racing a password or passkey removal always sees the other's committed result rather
 * than a pre-race snapshot.
 */

function rowToOAuthIdentity(row) {
  return {
    provider: row.provider, subject: row.subject, userId: row.user_id,
    ...(row.email ? { email: row.email } : {}),
    created: row.created_at.toISOString(),
    ...(row.last_used_at ? { lastUsed: row.last_used_at.toISOString() } : {})
  };
}

async function hasLiveOAuthIdentity(client, userId, provider) {
  const { rows } = await client.query(
    'SELECT 1 FROM oauth_identities WHERE user_id = $1 AND provider = $2', [userId, provider]
  );
  return rows.length > 0;
}

// Pass a transaction client in place of `pool` to insert alongside the user row a fresh Google
// signup creates (POST /api/register/google) — same idea as insertPasskey/createEmailToken.
export async function insertOAuthIdentity(pool, { provider, subject, userId, email }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO oauth_identities (provider, subject, user_id, email, last_used_at)
       VALUES ($1,$2,$3,$4, now()) RETURNING *`,
      [provider, subject, userId, email || null]
    );
    return { ok: true, row: rowToOAuthIdentity(rows[0]) };
  } catch (e) {
    if (e.code === '23505') return { error: 'already linked', code: 'already-linked' }; // unique_violation
    throw e;
  }
}

export async function findOAuthIdentityBySubject(pool, provider, subject) {
  const { rows } = await pool.query(
    'SELECT * FROM oauth_identities WHERE provider = $1 AND subject = $2', [provider, subject]
  );
  return rows.length ? rowToOAuthIdentity(rows[0]) : null;
}

export async function findOAuthIdentityByUser(pool, provider, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM oauth_identities WHERE provider = $1 AND user_id = $2', [provider, userId]
  );
  return rows.length ? rowToOAuthIdentity(rows[0]) : null;
}

export async function touchOAuthIdentityUse(pool, provider, subject) {
  await pool.query('UPDATE oauth_identities SET last_used_at = now() WHERE provider = $1 AND subject = $2', [provider, subject]);
}

// The authoritative, atomic unlink — same shape as removePasswordUnlessLast. `passwordCounts` is
// PASSWORD_LOGIN, read fresh (account data) under the lock exactly like removePasskey's own flag.
export async function removeOAuthIdentityUnlessLast(pool, userId, provider, passwordCounts = false) {
  const run = async client => {
    if (!(await hasLiveOAuthIdentity(client, userId, provider))) return { ok: true }; // already gone
    const { rows } = await client.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1', [userId]);
    const otherWays = rows[0].n + (passwordCounts && await hasLivePassword(client, userId) ? 1 : 0);
    if (otherWays < 1) return { error: 'connecting with Google is the only way into this profile', code: 'last-way-in' };
    await client.query('DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return { ok: true };
  };
  return withWayInLock(pool, userId, run);
}

/* ---------- e-mail tokens (ISO-1397) ----------
 * Confirmation ('verify') and "I lost my access" ('recover') share one table, told apart by
 * `purpose` — see migrations/002_email_verification.sql and email-tokens.js (the token itself:
 * a random value, and the one-way hash this module ever sees). A fresh token of a purpose
 * invalidates whichever one of that purpose was still live for the account first, so "resend"
 * really does make the one mailed out before it dead, and a signup followed by two resends never
 * leaves two links that both still work.
 */

// The one call that creates a token: register/verify (purpose 'verify', right after the account
// itself exists), "resend", POST /api/account/email for an account that had none, and
// POST /api/recover/request (purpose 'recover'). Pass a transaction client in place of `pool` to
// create one alongside the user row a fresh signup creates — same idea as insertPasskey.
export async function createEmailToken(pool, userId, purpose, tokenHash, ttlMs) {
  await pool.query(
    'UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
    [userId, purpose]
  );
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
    [userId, purpose, tokenHash, expiresAt]
  );
  return { expiresAt: expiresAt.getTime() };
}

// The atomic single-use claim, same UPDATE-and-check-rowCount shape as consumeInvite: a token
// already used or expired matches no row, and two requests racing the same token can never both
// win — whichever runs this UPDATE second finds nothing left to claim. Returns the owning user's
// id, or null for a token that was never valid, already used, or has expired.
export async function consumeEmailToken(pool, tokenHash, purpose) {
  const { rows } = await pool.query(
    `UPDATE email_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [tokenHash, purpose]
  );
  return rows.length ? rows[0].user_id : null;
}

/* ---------- billing (Stripe, Phase 3 — ISO-1393) ----------
 * `subscriptions`/`stripe_events` were created empty in migrations/001_init.sql, on purpose, for
 * this module to shape now. One row per Stripe subscription id, never reused: a user who cancels
 * and later resubscribes gets a second row, not an update of the first, which is what makes
 * `hasEverSubscribed` below a true "ever", not "currently" — the R$1,99 intro price is once per
 * account for good (issue rule), not once per subscription. `data` carries everything server.js's
 * status route and 402 gate read — status, plan, priceId, current_period_end, cancel_at_period_end,
 * trial_end, and firstFullCharge once invoice.paid reports one — as one jsonb blob rather than a
 * column each, since Phase 3 is the first and only reader/writer of this shape and a later column
 * would mean a later migration either way.
 */

function rowToSubscription(row) {
  return { id: row.id, userId: row.user_id, ...row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

// The merge is shallow (`||`, not deep): every caller in billing.js passes the fields it knows
// changed, not the whole record, so a field an event type never touches (e.g. `plan` on an
// invoice.paid) survives untouched rather than being wiped back to undefined.
export async function upsertSubscription(pool, id, userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (id, user_id, data, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (id) DO UPDATE SET data = subscriptions.data || EXCLUDED.data, updated_at = now()
     RETURNING *`,
    [id, userId, data]
  );
  return rowToSubscription(rows[0]);
}

export async function getSubscriptionById(pool, id) {
  const { rows } = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows.length ? rowToSubscription(rows[0]) : null;
}

// The row GET /api/billing/status and the PUT /api/data 402 gate both read: a cancel-and-resubscribe
// leaves more than one row for the account, and the most recently touched one is always the one
// that reflects where the account actually stands.
export async function getLatestSubscription(pool, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [userId]
  );
  return rows.length ? rowToSubscription(rows[0]) : null;
}

// The admin billing ficha (ISO-1619/ISO-1624 T2a): every row this account has ever had — current
// subscription first, every legacy (cancelled, superseded) one after — newest-touched first. A
// cancel-and-resubscribe account has more than one row (the module comment above explains why:
// one row per Stripe subscription id, never reused), and the ficha is explicit that it shows all
// of them, not just getLatestSubscription's single pick.
export async function getSubscriptionsForUser(pool, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC', [userId]
  );
  return rows.map(rowToSubscription);
}

// Still in the R$1,99 first period, next (full-price) charge within 3 days, not yet mailed about
// it — server.js's own periodic tick (billing.js's tickFirstPeriodNotices). There is no Stripe
// trial in this design (ISO-1392), so there is no `trial_will_end` webhook to hook the warning
// e-mail off; this is that notice's replacement, checked on our own clock instead of Stripe's.
// `firstPeriodNoticeSent` is set once a hook call succeeds, the same "never send it twice" shape
// as every other one-time claim in this file, just without needing atomicity — one instance, one
// tick at a time (server.js never runs two of these concurrently).
export async function getSubscriptionsDueForFirstPeriodNotice(pool) {
  const { rows } = await pool.query(`
    SELECT * FROM subscriptions
    WHERE data->>'firstPeriod' = 'true'
      AND data->>'status' = 'active'
      AND data->>'firstPeriodNoticeSent' IS NULL
      AND (data->>'currentPeriodEnd')::timestamptz <= now() + interval '3 days'
      AND (data->>'currentPeriodEnd')::timestamptz > now()
  `);
  return rows.map(rowToSubscription);
}

// Whether this account has ever had a subscription row at all, regardless of its current status —
// the once-per-account R$1,99 intro price check (POST /api/billing/checkout): true forever once
// true once, so cancelling and coming back always prices at the plan's full recurring rate.
export async function hasEverSubscribed(pool, userId) {
  const { rows } = await pool.query('SELECT 1 FROM subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
  return rows.length > 0;
}

// The atomic single-use claim, same INSERT ... ON CONFLICT DO NOTHING-and-check-rowCount shape as
// every other claim in this file (consumeInvite, burnDeviceLink, consumeEmailToken): whichever
// request's INSERT actually lands is the one that gets to apply the event's effect, so a Stripe
// retry (or the exact same event forwarded twice by `stripe listen`) finds its id already a row and
// stops at a 200 without touching `subscriptions` a second time.
export async function claimStripeEvent(pool, { id, type, data }) {
  const { rowCount } = await pool.query(
    'INSERT INTO stripe_events (id, type, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
    [id, type, data]
  );
  return rowCount > 0;
}

// The inverse of the claim above — called only when applying the event's effect threw after the
// claim already landed (server.js's webhook route), so Stripe's own retry of this exact event.id
// gets a real second attempt instead of finding it already claimed and skipping straight to a
// no-op 200. Never called after a successful apply: a claim that already did its job stays, same
// as every other one-time claim in this file.
export async function unclaimStripeEvent(pool, id) {
  await pool.query('DELETE FROM stripe_events WHERE id = $1', [id]);
}

/* ---------- Stripe account-deletion outbox (ISO-1447, Phase 4 — LGPD) ----------
 * See migrations/005_stripe_cleanup.sql for why this table carries no personal data and why the
 * insert below has to run on the same transaction client deleteAccount (server.js) uses for the
 * user row's own delete.
 */

function rowToStripeCleanup(row) {
  return {
    id: row.id, customerId: row.customer_id, subscriptionIds: row.subscription_ids || [],
    attempts: row.attempts
  };
}

// `client` is a withTransaction client, same idea as consumeInvite/insertPasskey: this has to
// commit or roll back together with the DELETE FROM users right next to it. Returns the row
// (with its id) so a caller that wants to try the Stripe side immediately, right after the
// transaction commits, has something to pass attemptStripeCleanup without a re-read.
export async function insertStripeCleanup(client, { customerId, subscriptionIds }) {
  const { rows } = await client.query(
    'INSERT INTO stripe_cleanup (customer_id, subscription_ids) VALUES ($1, $2) RETURNING *',
    [customerId, subscriptionIds || []]
  );
  return rowToStripeCleanup(rows[0]);
}

// Oldest first — whichever pending cleanup's backoff (bumpStripeCleanupFailure) has elapsed.
export async function getStripeCleanupDue(pool, limit = 20) {
  const { rows } = await pool.query(
    'SELECT * FROM stripe_cleanup WHERE next_attempt_at <= now() ORDER BY id LIMIT $1', [limit]
  );
  return rows.map(rowToStripeCleanup);
}

export async function deleteStripeCleanup(pool, id) {
  await pool.query('DELETE FROM stripe_cleanup WHERE id = $1', [id]);
}

// Exponential, capped at an hour — a prolonged Stripe outage backs off instead of hammering their
// API every tick. `last_error` is kept only for an operator reading the table by hand; nothing
// here reads it back.
export async function bumpStripeCleanupFailure(pool, id, errorMessage) {
  await pool.query(
    `UPDATE stripe_cleanup SET attempts = attempts + 1, last_error = $2,
       next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 minute')
     WHERE id = $1`,
    [id, String(errorMessage || '').slice(0, 300)]
  );
}

/* ---------- billing catalog (ISO-1623) ----------
 * The admin-facing mirror of Stripe's Prices (migrations/010_billing_catalog.sql). Reads here
 * never trust `process.env.STRIPE_PRICE_*` — that's billing.js's own legacy fallback, kept only
 * for an instance whose catalog hasn't been seeded yet (plan §6.2). A price row is returned in
 * whatever `state` it's in; callers that need "sellable right now" filter for `state = 'current'`
 * themselves (billing.js's resolvePlanForCheckout), while a lookup for a subscription already on
 * the books (planFromPrice, nextChargeAmountCents) deliberately does not — a `retired` Price must
 * stay legible for whoever is still being billed off it.
 */
function rowToBillingPrice(row) {
  return {
    id: row.id, planId: row.plan_id, kind: row.kind, unitAmount: row.unit_amount, currency: row.currency,
    interval: row.interval, intervalCount: row.interval_count, livemode: row.livemode,
    stripeProductId: row.stripe_product_id, state: row.state, createdBy: row.created_by,
    createdAt: row.created_at, publishedAt: row.published_at, retiredAt: row.retired_at, decisionRef: row.decision_ref
  };
}
function rowToBillingPlan(row) {
  return {
    id: row.id, display: row.display, interval: row.interval, intervalCount: row.interval_count,
    sortOrder: row.sort_order, available: row.available, currentPriceId: row.current_price_id,
    introPriceId: row.intro_price_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export async function isBillingCatalogSeeded(pool) {
  const { rows } = await pool.query('SELECT 1 FROM billing_plans LIMIT 1');
  return rows.length > 0;
}

export async function getPriceById(pool, id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM billing_prices WHERE id = $1', [id]);
  return rows.length ? rowToBillingPrice(rows[0]) : null;
}

// Any state — see the module comment on why a retired Price still answers here.
export async function getPlanIdForPrice(pool, priceId) {
  if (!priceId) return null;
  const { rows } = await pool.query(
    "SELECT plan_id FROM billing_prices WHERE id = $1 AND kind = 'recurring' AND plan_id IS NOT NULL", [priceId]
  );
  return rows.length ? rows[0].plan_id : null;
}

// The shared first-period Price, whichever plan's Checkout is about to use it — there is exactly
// one `current` intro Price at a time (seedBillingCatalog below never creates a second).
export async function getCurrentIntroPrice(pool) {
  const { rows } = await pool.query("SELECT * FROM billing_prices WHERE kind = 'intro' AND state = 'current' LIMIT 1");
  return rows.length ? rowToBillingPrice(rows[0]) : null;
}

// ISO-1630 (T1a loose end): whether `priceId` is THE account-wide first-period Price — checked
// against `kind = 'intro'` in ANY state (a retired intro Price still named a first period for
// whoever was actually sold it, same reasoning as getPlanIdForPrice above), falling back to
// STRIPE_PRICE_INTRO only while the catalog has never been seeded. applyStripeEvent (billing.js)
// used to compare straight against `process.env.STRIPE_PRICE_INTRO`, which stopped being true the
// moment an admin minted a new intro Price through the catalog instead of the env var.
export async function isIntroPrice(pool, priceId) {
  if (!priceId) return false;
  if (await isBillingCatalogSeeded(pool)) {
    const { rows } = await pool.query("SELECT 1 FROM billing_prices WHERE id = $1 AND kind = 'intro'", [priceId]);
    return rows.length > 0;
  }
  return priceId === process.env.STRIPE_PRICE_INTRO;
}

// The upcoming full-plan charge during a first period (billing.js's nextChargeAmountCents): the
// plan's *current* recurring Price, never the intro Price the subscription's own item still is.
export async function getCurrentPriceAmountForPlan(pool, planId) {
  const { rows } = await pool.query(
    "SELECT bpr.unit_amount FROM billing_plans bpl JOIN billing_prices bpr ON bpr.id = bpl.current_price_id WHERE bpl.id = $1",
    [planId]
  );
  return rows.length ? rows[0].unit_amount : null;
}

// Checkout's own gate (plan §4): a plan the catalog knows about, regardless of `available` — the
// caller decides what "sellable" means from `available` and the linked Price's own `state`.
export async function getCatalogPlan(pool, id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM billing_plans WHERE id = $1', [id]);
  return rows.length ? rowToBillingPlan(rows[0]) : null;
}

// GET /api/billing/plans: only `available` plans, each with its current Price's amount (and the
// intro Price's amount, if this plan offers one) already resolved in centavos — the one query the
// route needs, rather than N follow-up lookups.
export async function getAvailablePlans(pool) {
  const { rows } = await pool.query(`
    SELECT p.*, cp.unit_amount AS amount_cents, ip.unit_amount AS intro_amount_cents
    FROM billing_plans p
    JOIN billing_prices cp ON cp.id = p.current_price_id
    LEFT JOIN billing_prices ip ON ip.id = p.intro_price_id
    WHERE p.available = true
    ORDER BY p.sort_order
  `);
  return rows.map(r => ({ ...rowToBillingPlan(r), amountCents: r.amount_cents, introAmountCents: r.intro_amount_cents }));
}

// The once-at-boot seed (billing.js's seedCatalogFromEnv) — called only when isBillingCatalogSeeded
// is still false, so this never runs against a catalog an admin has already started editing.
// `plans` is ordered (sort_order = its index + 1); each entry's own Price and the one shared
// `intro` Price are inserted `current` right away — unlike every later Price (T1b's "nova versão
// de valor"), there is no draft step here: these are exactly the Prices already live in Stripe via
// the env vars, not something this boot step is creating.
export async function seedBillingCatalog(pool, { plans, intro }) {
  return withTransaction(pool, async client => {
    let introId = null;
    if (intro) {
      await client.query(
        `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state, published_at)
         VALUES ($1, NULL, 'intro', $2, $3, $4, $5, $6, $7, 'current', now())`,
        [intro.id, intro.unitAmount, intro.currency, intro.interval, intro.intervalCount, intro.livemode, intro.stripeProductId]
      );
      introId = intro.id;
    }
    for (const [i, plan] of plans.entries()) {
      await client.query(
        `INSERT INTO billing_plans (id, display, interval, interval_count, sort_order, available, intro_price_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [plan.id, plan.display, plan.price.interval, plan.price.intervalCount, i + 1, introId]
      );
      await client.query(
        `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state, published_at)
         VALUES ($1, $2, 'recurring', $3, $4, $5, $6, $7, $8, 'current', now())`,
        [plan.price.id, plan.id, plan.price.unitAmount, plan.price.currency, plan.price.interval, plan.price.intervalCount, plan.price.livemode, plan.price.stripeProductId]
      );
      await client.query('UPDATE billing_plans SET current_price_id = $1 WHERE id = $2', [plan.price.id, plan.id]);
    }
  });
}

/* ---------- billing catalog admin (ISO-1619/ISO-1630) ----------
 * Everything the admin catalog routes (server.js) need beyond the read path above. Every write
 * that also touches Stripe (create/availability/new price version/publish) is orchestrated from
 * billing.js, not here — this file stays pure DB, same split as the rest of the module. A version-
 * gated write is a lock-free compare-and-set (`UPDATE ... WHERE version = $n`), same shape as
 * `user_state.rev` (CLAUDE.md) rather than `FOR UPDATE`: the row lock would otherwise have to stay
 * open across the Stripe network call in between, which this deliberately avoids.
 */

// Any row's stripe_product_id — every Price this app has ever known about (seeded or admin-
// created) shares the one Product `scripts/stripe-setup.mjs` creates, so the first row answers for
// all of them. Null only on a totally fresh install whose catalog has never been seeded or
// hand-created — the admin create/reconcile routes refuse with `no-product` rather than minting a
// second Product Stripe-side.
export async function getBillingProductId(pool) {
  const { rows } = await pool.query('SELECT stripe_product_id FROM billing_prices LIMIT 1');
  return rows.length ? rows[0].stripe_product_id : null;
}

export async function nextPlanSortOrder(pool) {
  const { rows } = await pool.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM billing_plans');
  return rows[0].n;
}

// The full admin view (GET /api/admin/billing/catalog): every plan regardless of `available`,
// every Price regardless of `state`, and how many live `subscriptions` rows are billed off each
// Price — read off the same jsonb `priceId` the 402 gate and the webhook already trust, not a
// second source of truth. `liveWritesDisabled` is server.js's own job (it needs `BILLING_ADMIN_LIVE`,
// an env var this file has no business reading).
export async function listCatalogAdmin(pool) {
  const [{ rows: plans }, { rows: prices }, { rows: counts }] = await Promise.all([
    pool.query('SELECT * FROM billing_plans ORDER BY sort_order'),
    pool.query('SELECT * FROM billing_prices ORDER BY created_at'),
    pool.query("SELECT data->>'priceId' AS price_id, count(*)::int AS n FROM subscriptions WHERE data->>'priceId' IS NOT NULL GROUP BY 1")
  ]);
  const countByPrice = Object.fromEntries(counts.map(r => [r.price_id, r.n]));
  const pricesByPlan = {};
  const introPrices = [];
  for (const row of prices) {
    const price = { ...rowToBillingPrice(row), subscriptionCount: countByPrice[row.id] || 0 };
    if (row.kind === 'intro') introPrices.push(price);
    else (pricesByPlan[row.plan_id] ||= []).push(price);
  }
  return {
    plans: plans.map(p => ({ ...rowToBillingPlan(p), prices: pricesByPlan[p.id] || [] })),
    introPrices
  };
}

// "Criar oferta" (plan §3): a brand-new plan, `available=false`, with its first Price already a
// `draft` — mirrors seedBillingCatalog's own INSERT shape, minus the `current`/`published_at` this
// one deliberately withholds. One transaction so a crash between the two INSERTs can never leave a
// plan with no Price at all. `23505` on the plan id is reported, not thrown — an admin re-submitting
// the same slug after a first attempt failed partway (the Stripe Price already exists, caught by
// the idempotency claim instead) must see a clean 409, not a 500.
export async function insertDraftPlanAndPrice(pool, plan, price) {
  return withTransaction(pool, async client => {
    try {
      await client.query(
        `INSERT INTO billing_plans (id, display, interval, interval_count, sort_order, available, intro_price_id)
         VALUES ($1,$2,$3,$4,$5,false,$6)`,
        [plan.id, plan.display, plan.interval, plan.intervalCount, plan.sortOrder, plan.introPriceId]
      );
    } catch (e) {
      if (e.code === '23505') return { error: 'a plan with this id already exists', code: 'id-taken' };
      throw e;
    }
    await client.query(
      `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state, created_by, decision_ref)
       VALUES ($1,$2,'recurring',$3,$4,$5,$6,$7,$8,'draft',$9,$10)`,
      [price.id, plan.id, price.unitAmount, price.currency, price.interval, price.intervalCount, price.livemode, price.stripeProductId, price.createdBy, price.decisionRef || null]
    );
    const { rows: [row] } = await client.query('SELECT * FROM billing_plans WHERE id = $1', [plan.id]);
    return { ok: true, plan: rowToBillingPlan(row) };
  });
}

// "Editar apresentação" (plan §3): display text only, never price/interval/availability — the
// compare-and-set contract GET/PUT /api/data already gives the client (`stale` + the current row,
// not a silent overwrite).
export async function updatePlanDisplay(pool, id, version, display) {
  const { rows } = await pool.query(
    'UPDATE billing_plans SET display = $1, version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING *',
    [display, id, version]
  );
  if (rows.length) return { ok: true, plan: rowToBillingPlan(rows[0]) };
  const current = await getCatalogPlan(pool, id);
  return current ? { error: 'changed since you loaded it', code: 'stale', current } : { error: 'no such plan', code: 'not-found' };
}

// "Reordenar em lote" (POST .../order): `order` must name exactly the current plan set — a partial
// list would leave the plans it omits at whatever sort_order they already had, silently
// interleaved with the reordered ones. Does not touch `version` (plan §3: this route "não passa
// pelo live gate", and it is not a financial action either — nothing here is logged to
// billing_admin_actions).
export async function reorderPlans(pool, order) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT id FROM billing_plans');
    const known = new Set(rows.map(r => r.id));
    if (order.length !== known.size || !order.every(id => known.has(id))) {
      return { error: 'order must name exactly the current set of plans', code: 'invalid-order' };
    }
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE billing_plans SET sort_order = $1 WHERE id = $2', [i + 1, id]);
    }
    const { rows: plans } = await client.query('SELECT * FROM billing_plans ORDER BY sort_order');
    return { ok: true, plans: plans.map(rowToBillingPlan) };
  });
}

// "Ativar/desativar plano": the DB half of the compare-and-set — billing.js calls Stripe first
// (`prices.update` on the plan's current Price) and only reaches this once that succeeded, so a
// version race lost *here* (after Stripe already flipped) is reported as `stale-after-stripe`,
// distinct from the ordinary `stale` a caller can just retry against the fresh row.
export async function setPlanAvailabilityRow(pool, id, version, available) {
  const { rows } = await pool.query(
    'UPDATE billing_plans SET available = $1, version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING *',
    [available, id, version]
  );
  if (rows.length) return { ok: true, plan: rowToBillingPlan(rows[0]) };
  const current = await getCatalogPlan(pool, id);
  return current ? { error: 'changed since you loaded it', code: 'stale', current } : { error: 'no such plan', code: 'not-found' };
}

// "Nova versão de valor": a second (or later) `draft` Price for a plan that already has a
// `current` one — never touches the plan row itself (publishing is the separate, explicit act that
// does). `decisionRef` is the free-text pointer migrations/010 reserves for exactly this.
export async function insertDraftPrice(pool, price) {
  const { rows } = await pool.query(
    `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state, created_by, decision_ref)
     VALUES ($1,$2,'recurring',$3,$4,$5,$6,$7,$8,'draft',$9,$10) RETURNING *`,
    [price.id, price.planId, price.unitAmount, price.currency, price.interval, price.intervalCount, price.livemode, price.stripeProductId, price.createdBy, price.decisionRef || null]
  );
  return rowToBillingPrice(rows[0]);
}

// "Publicar versão": the DB half, after billing.js has already told Stripe to activate the new
// Price and deactivate the old one. One transaction flips both Prices' `state` (the immutability
// trigger allows exactly this column) and the plan's `current_price_id` together — a subscriber
// still billed off the now-`retired` Price keeps reading its name/amount forever (ISO-1619
// principle #2; nothing here migrates a subscriber onto the new Price, by design — grandfathering).
export async function publishPriceVersionRows(pool, { planId, version, newPriceId, oldPriceId }) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM billing_plans WHERE id = $1 AND version = $2 FOR UPDATE', [planId, version]);
    if (!rows.length) {
      const current = await getCatalogPlan(pool, planId);
      return current ? { error: 'changed since you loaded it (Stripe already switched)', code: 'stale-after-stripe', current } : { error: 'no such plan', code: 'not-found' };
    }
    // The old Price has to give up `current` before the new one can claim it — the partial
    // unique index (`billing_prices_one_current_per_plan`) allows at most one `current` row per
    // plan_id at any instant, so doing this the other way round would collide with the row this
    // is about to replace instead of the row it is replacing it with.
    if (oldPriceId) await client.query("UPDATE billing_prices SET state = 'retired', retired_at = now() WHERE id = $1", [oldPriceId]);
    await client.query("UPDATE billing_prices SET state = 'current', published_at = now() WHERE id = $1", [newPriceId]);
    const { rows: [plan] } = await client.query(
      'UPDATE billing_plans SET current_price_id = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING *',
      [newPriceId, planId]
    );
    return { ok: true, plan: rowToBillingPlan(plan) };
  });
}

// Reconcile (plan §3): a Price Stripe knows about that this app doesn't yet — tagged with this
// app's own `metadata.bf_plan` (so a Price created by hand in the Dashboard for something else
// entirely is never swept in by accident) — is adopted as a `draft`, never auto-published: `active`
// in Stripe is not the same claim as "this is the plan's `current` Price" in our own catalog, and
// only "publicar versão" gets to make that claim. `ON CONFLICT DO NOTHING` guards two concurrent
// reconciles, not the normal case (the caller already filtered to unknown ids).
export async function insertReconciledDraftPrice(pool, price) {
  const { rows } = await pool.query(
    `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state)
     VALUES ($1,$2,'recurring',$3,$4,$5,$6,$7,$8,'draft')
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [price.id, price.planId, price.unitAmount, price.currency, price.interval, price.intervalCount, price.livemode, price.stripeProductId]
  );
  return rows.length ? rowToBillingPrice(rows[0]) : null;
}

// A subscription billed off a priceId this catalog has never heard of (pre-ISO-1623 history, or a
// Price minted outside the admin flow) — reconcile's other half. Never invents an amount: the
// caller reads it straight off Stripe (`stripe.prices.retrieve`) before this is called.
export async function getUnknownSubscriptionPriceIds(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT data->>'priceId' AS price_id FROM subscriptions
    WHERE data->>'priceId' IS NOT NULL AND data->>'priceId' NOT IN (SELECT id FROM billing_prices)
  `);
  return rows.map(r => r.price_id);
}

// Recorded `retired` straight away — read off Stripe, grandfathered, never sellable again
// (plan_id is whichever plan its own `metadata.bf_plan` names, if this catalog still has that
// plan; NULL otherwise — exactly the "never invents a value" rule, applied to the linkage too).
export async function insertReconciledRetiredPrice(pool, price) {
  const { rows } = await pool.query(
    `INSERT INTO billing_prices (id, plan_id, kind, unit_amount, currency, interval, interval_count, livemode, stripe_product_id, state, retired_at)
     VALUES ($1,$2,'recurring',$3,$4,$5,$6,$7,$8,'retired', now())
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [price.id, price.planId, price.unitAmount, price.currency, price.interval, price.intervalCount, price.livemode, price.stripeProductId]
  );
  return rows.length ? rowToBillingPrice(rows[0]) : null;
}

/* ---------- billing admin actions (ISO-1619/ISO-1630) ----------
 * The audit trail + idempotency claim every *financial* admin action (one that touches Stripe)
 * writes to — migrations/010's own `reason text NOT NULL CHECK (length(reason) >= 10)` is what
 * actually enforces the "reason ≥ 10" rule from the plan, not application code. `claimBillingAdminAction`
 * is the same INSERT ... ON CONFLICT (idempotency_key) DO NOTHING-and-check-rowCount shape as
 * `claimStripeEvent` above: whichever request's INSERT lands gets to call Stripe; a replay of the
 * same Idempotency-Key (the same confirm dialog submitted twice, a client retry after a dropped
 * response) finds the row already there and is hand back its stored result instead.
 */
function rowToBillingAdminAction(row) {
  return {
    id: Number(row.id), idempotencyKey: row.idempotency_key, actorId: row.actor_id, targetUserId: row.target_user_id,
    action: row.action, reason: row.reason, request: row.request, before: row.before, after: row.after,
    stripeIds: row.stripe_ids, status: row.status, error: row.error,
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at ? row.completed_at.toISOString() : null
  };
}

export async function claimBillingAdminAction(pool, { idempotencyKey, actorId, targetUserId, action, reason, request }) {
  const { rows } = await pool.query(
    `INSERT INTO billing_admin_actions (idempotency_key, actor_id, target_user_id, action, reason, request, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [idempotencyKey, actorId, targetUserId || null, action, reason, JSON.stringify(request || {})]
  );
  if (rows.length) return { claimed: true, row: rowToBillingAdminAction(rows[0]) };
  const existing = await pool.query('SELECT * FROM billing_admin_actions WHERE idempotency_key = $1', [idempotencyKey]);
  return { claimed: false, row: rowToBillingAdminAction(existing.rows[0]) };
}

export async function finishBillingAdminAction(pool, id, { status, before, after, stripeIds, error }) {
  const { rows } = await pool.query(
    `UPDATE billing_admin_actions SET status = $2, before = $3, after = $4, stripe_ids = $5, error = $6, completed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, before ?? null, after ?? null, JSON.stringify(stripeIds || {}), error || null]
  );
  return rowToBillingAdminAction(rows[0]);
}

export async function listBillingAdminActions(pool, limit = 100) {
  const { rows } = await pool.query('SELECT * FROM billing_admin_actions ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(rowToBillingAdminAction);
}

// The ficha's own history panel (ISO-1624 T2a) — one account's financial actions, not the
// instance-wide feed listBillingAdminActions above serves the catalog's own actions tab with.
// `target_user_id` is ON DELETE SET NULL (migrations/010), so this is naturally empty again once
// the account itself is gone — the rows persist (LGPD-reviewed: no personal data beyond an id),
// just no longer reachable by this lookup.
export async function listBillingAdminActionsForUser(pool, userId, limit = 50) {
  const { rows } = await pool.query(
    'SELECT * FROM billing_admin_actions WHERE target_user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]
  );
  return rows.map(rowToBillingAdminAction);
}

/* ---------- programs (ISO-1485) ----------
 * The admin-curated catalog — not a user's own training data, see docs/ADMIN_PROGRAMS.md §1.
 * `rev` is the same optimistic-concurrency shape as user_state.rev: every mutator below reads the
 * row with `FOR UPDATE` (so a second writer waits instead of racing a lock-free retry, unlike
 * putUserState — a personal catalog has none of that function's concurrency volume) and checks
 * the caller's rev against what it finds. Every mutator also writes exactly one program_events
 * row, in the same transaction as the row change it describes — see migrations/007_programs.sql
 * for why that table carries no foreign key. `actor` is `{ id, name } | null`; recordEvent's own
 * default ('system') is only ever used by purgeExpiredPrograms.
 */

function rowToProgram(row) {
  const hasCover = row.cover_file != null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    difficulty: row.difficulty,
    sessionMinutes: row.session_minutes,
    status: row.status,
    rev: Number(row.rev),
    ...(hasCover ? {
      coverFile: row.cover_file, coverMime: row.cover_mime,
      coverWidth: row.cover_width, coverHeight: row.cover_height, coverBytes: row.cover_bytes,
      coverAlt: row.cover_alt,
      ...(row.cover_updated_at ? { coverUpdatedAt: row.cover_updated_at.toISOString() } : {}),
      ...(row.cover_updated_by ? { coverUpdatedBy: row.cover_updated_by } : {})
    } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    updatedAt: row.updated_at.toISOString(),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
    ...(row.deleted_by ? { deletedBy: row.deleted_by } : {})
  };
}

function rowToProgramEvent(row) {
  return {
    id: Number(row.id), programId: row.program_id, programTitle: row.program_title,
    action: row.action, actorId: row.actor_id, actorName: row.actor_name,
    at: row.at.toISOString(), changes: row.changes || {}
  };
}

async function recordEvent(client, { programId, programTitle, action, actor, changes }) {
  await client.query(
    `INSERT INTO program_events (program_id, program_title, action, actor_id, actor_name, changes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [programId, programTitle, action, actor?.id || null, actor?.name || 'system', JSON.stringify(changes || {})]
  );
}

// Every row whose cover_file is still referenced — including a trashed program's, which still
// needs its file (restoring brings it right back). Called both as a standalone check (the cover
// routes, below) and against a `client` mid-transaction (purge, which has just deleted the one row
// that might have been the last reference).
export async function coverStillReferenced(pool, file) {
  const { rows } = await pool.query('SELECT 1 FROM programs WHERE cover_file = $1 LIMIT 1', [file]);
  return rows.length > 0;
}

// `q` is escaped for ILIKE's own wildcards (%, _, \) before going into the pattern — a search for
// a literal "%" or "_" must not act as a wildcard, and parameterization alone doesn't stop that
// (it only stops SQL injection, a different problem). `trash` selects the lixeira instead of the
// active catalog; `status` is ignored there, since a trashed program's status no longer means
// anything about what's visible (see server.js's own read path).
export async function listPrograms(pool, { q, category, difficulty, status, trash } = {}) {
  const clauses = [trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params = [];
  if (q) {
    params.push('%' + String(q).replace(/[%_\\]/g, c => '\\' + c) + '%');
    clauses.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  if (category) { params.push(category); clauses.push(`category = $${params.length}`); }
  if (difficulty) { params.push(difficulty); clauses.push(`difficulty = $${params.length}`); }
  if (status && !trash) { params.push(status); clauses.push(`status = $${params.length}`); }
  const order = trash ? 'deleted_at DESC' : 'updated_at DESC';
  const { rows } = await pool.query(`SELECT * FROM programs WHERE ${clauses.join(' AND ')} ORDER BY ${order}`, params);
  return rows.map(rowToProgram);
}

export async function getProgram(pool, id) {
  const { rows } = await pool.query('SELECT * FROM programs WHERE id = $1', [id]);
  return rows.length ? rowToProgram(rows[0]) : null;
}

export async function listProgramEvents(pool, programId, limit = 50) {
  const { rows } = await pool.query(
    'SELECT * FROM program_events WHERE program_id = $1 ORDER BY at DESC, id DESC LIMIT $2',
    [programId, limit]
  );
  return rows.map(rowToProgramEvent);
}

// `value` is already the normalized, validated shape validateProgram() (programs.js) returns —
// this never re-validates, only persists. The unique index on lower(title) (partial, active rows
// only) is what actually enforces the no-duplicate-title rule; the 23505 catch here is just this
// call's half of reporting that race as a clean 409 instead of a 500.
export async function createProgram(pool, value, actor) {
  const id = newProgramId();
  return withTransaction(pool, async client => {
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `INSERT INTO programs (id, title, description, category, difficulty, session_minutes, status, created_by, updated_by, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8, CASE WHEN $7 = 'published' THEN now() ELSE NULL END)
         RETURNING *`,
        [id, value.title, value.description, value.category, value.difficulty, value.sessionMinutes, value.status, actor?.id || null]
      ));
    } catch (e) {
      if (e.code === '23505') return { error: 'a program with this title already exists', code: 'title-taken' };
      throw e;
    }
    await recordEvent(client, {
      programId: id, programTitle: row.title, action: 'create', actor,
      changes: {
        title: [null, row.title], category: [null, row.category], difficulty: [null, row.difficulty],
        sessionMinutes: [null, row.session_minutes], status: [null, row.status]
      }
    });
    return { ok: true, row: rowToProgram(row) };
  });
}

// Compare-and-set by rev, same contract GET/PUT /api/data already gives the client: a stale
// `rev` loses with `{code: 'stale', current}` rather than silently overwriting a concurrent edit.
// A no-op save (every field already equal to what's submitted) writes nothing and bumps nothing —
// there is no event for a save that changed nothing. Logged as 'publish'/'unpublish' instead of
// 'update' only when status is the one and only thing that moved — an edit that changes the
// description *and* publishes in the same save is logged as 'update' (its `changes` still shows
// both).
export async function updateProgram(pool, id, rev, value, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (before.deleted_at) return { error: 'this program is in the trash', code: 'in-trash' };
    if (Number(before.rev) !== Number(rev)) return { error: 'changed since you loaded it', code: 'stale', current: rowToProgram(before) };
    const next = {
      title: value.title ?? before.title,
      description: value.description ?? before.description,
      category: value.category ?? before.category,
      difficulty: value.difficulty ?? before.difficulty,
      session_minutes: value.sessionMinutes ?? before.session_minutes,
      status: value.status ?? before.status
    };
    const unchanged = Object.entries(next).every(([k, v]) => before[k] === v);
    if (unchanged) return { ok: true, row: rowToProgram(before), action: null };
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `UPDATE programs SET title=$1, description=$2, category=$3, difficulty=$4, session_minutes=$5,
           status=$6, rev = rev + 1, updated_at = now(), updated_by = $7,
           published_at = CASE WHEN $6 = 'published' AND published_at IS NULL THEN now() ELSE published_at END
         WHERE id = $8
         RETURNING *`,
        [next.title, next.description, next.category, next.difficulty, next.session_minutes, next.status, actor?.id || null, id]
      ));
    } catch (e) {
      if (e.code === '23505') return { error: 'a program with this title already exists', code: 'title-taken' };
      throw e;
    }
    // Only the fields a human actually edits go into the diff — not rev/updated_at/published_at,
    // which move as a side effect of any save and would otherwise make a pure status toggle look
    // like a multi-field 'update' instead of the 'publish'/'unpublish' it actually was.
    const editable = r => ({
      title: r.title, description: r.description, category: r.category, difficulty: r.difficulty,
      sessionMinutes: r.session_minutes, status: r.status
    });
    const changes = diffForEvent(editable(before), editable(row));
    const onlyStatusChanged = Object.keys(changes).length === 1 && 'status' in changes;
    const action = onlyStatusChanged ? (row.status === 'published' ? 'publish' : 'unpublish') : 'update';
    await recordEvent(client, { programId: id, programTitle: row.title, action, actor, changes });
    return { ok: true, row: rowToProgram(row), action };
  });
}

export async function trashProgram(pool, id, rev, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (before.deleted_at) return { error: 'already in the trash', code: 'in-trash' };
    if (Number(before.rev) !== Number(rev)) return { error: 'changed since you loaded it', code: 'stale', current: rowToProgram(before) };
    const { rows: [row] } = await client.query(
      'UPDATE programs SET deleted_at = now(), deleted_by = $1, rev = rev + 1 WHERE id = $2 RETURNING *',
      [actor?.id || null, id]
    );
    await recordEvent(client, { programId: id, programTitle: row.title, action: 'trash', actor, changes: {} });
    return { ok: true, row: rowToProgram(row) };
  });
}

// Always comes back as a draft (plan §2.1) — republishing is its own, explicit act. Can collide
// with an active program's title if one was created or restored in the meantime; reported the
// same way create/update do.
export async function restoreProgram(pool, id, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (!before.deleted_at) return { error: 'not in the trash', code: 'not-in-trash' };
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `UPDATE programs SET deleted_at = NULL, deleted_by = NULL, status = 'draft', rev = rev + 1,
           updated_at = now(), updated_by = $1
         WHERE id = $2 RETURNING *`,
        [actor?.id || null, id]
      ));
    } catch (e) {
      if (e.code === '23505') return { error: 'another program already has this title', code: 'title-taken' };
      throw e;
    }
    await recordEvent(client, { programId: id, programTitle: row.title, action: 'restore', actor, changes: {} });
    return { ok: true, row: rowToProgram(row) };
  });
}

// Only from the trash, and only with the title typed back exactly (titleMatchesForPurge,
// programs.js) — the server's own half of that confirmation, never trusting the client's gate
// alone. `coverFile`/`coverStillReferenced` tell the caller whether to unlink the file on disk;
// the row (and, with it, the one reference that might have been keeping the file alive) is
// already gone by the time this returns.
export async function purgeProgram(pool, id, confirmTitle, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (!before.deleted_at) return { error: 'only a program in the trash can be purged', code: 'not-in-trash' };
    if (!titleMatchesForPurge(confirmTitle, before.title)) {
      return { error: 'the typed title does not match', code: 'confirm-mismatch' };
    }
    await client.query('DELETE FROM programs WHERE id = $1', [id]);
    await recordEvent(client, { programId: id, programTitle: before.title, action: 'purge', actor, changes: {} });
    const coverStill = before.cover_file ? await coverStillReferenced(client, before.cover_file) : false;
    return { ok: true, title: before.title, coverFile: before.cover_file || null, coverStillReferenced: coverStill };
  });
}

// The hourly/boot tick (server.js). `days` of 0 means "never auto-purge" (plan §2.3) — checked by
// the caller before this is reached, but re-checked here too since nothing stops a direct call.
// Each candidate purges in its own transaction (not one big one for the whole batch): a personal
// instance purges a handful of rows at a time at most, and one bad row must not roll back every
// other one that was fine. Re-reads with the same cutoff under FOR UPDATE before deleting, so a
// program restored between the candidate scan and its own turn is left alone.
export async function purgeExpiredPrograms(pool, days, now = Date.now()) {
  if (!days) return [];
  const cutoff = new Date(now - days * 86400000);
  const { rows: candidates } = await pool.query(
    'SELECT id FROM programs WHERE deleted_at IS NOT NULL AND deleted_at < $1', [cutoff]
  );
  const purged = [];
  for (const { id } of candidates) {
    const result = await withTransaction(pool, async client => {
      const { rows } = await client.query(
        'SELECT * FROM programs WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2 FOR UPDATE',
        [id, cutoff]
      );
      if (!rows.length) return null;
      const before = rows[0];
      await client.query('DELETE FROM programs WHERE id = $1', [id]);
      await recordEvent(client, { programId: id, programTitle: before.title, action: 'purge_auto', actor: null, changes: {} });
      const coverStill = before.cover_file ? await coverStillReferenced(client, before.cover_file) : false;
      return { id, title: before.title, coverFile: before.cover_file || null, coverStillReferenced: coverStill };
    });
    if (result) purged.push(result);
  }
  return purged;
}

// `cover`: { file, mime, width, height, bytes, alt } — already validated and the file already on
// disk by the time this runs (server.js writes the bytes first; a row that then fails to commit
// just leaves an orphan for the sweep to collect, never a row pointing at nothing). `oldFile`/
// `oldStillReferenced` tell the caller whether to unlink the file the cover is replacing.
export async function setProgramCover(pool, id, rev, cover, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (before.deleted_at) return { error: 'this program is in the trash', code: 'in-trash' };
    if (Number(before.rev) !== Number(rev)) return { error: 'changed since you loaded it', code: 'stale', current: rowToProgram(before) };
    const oldFile = before.cover_file;
    const { rows: [row] } = await client.query(
      `UPDATE programs SET cover_file=$1, cover_mime=$2, cover_width=$3, cover_height=$4, cover_bytes=$5,
         cover_alt=$6, cover_updated_at=now(), cover_updated_by=$7, rev = rev + 1
       WHERE id = $8 RETURNING *`,
      [cover.file, cover.mime, cover.width, cover.height, cover.bytes, cover.alt, actor?.id || null, id]
    );
    await recordEvent(client, { programId: id, programTitle: row.title, action: 'cover_set', actor, changes: { cover: [oldFile || null, cover.file] } });
    const replaced = oldFile && oldFile !== cover.file;
    const oldStillReferenced = replaced ? await coverStillReferenced(client, oldFile) : false;
    return { ok: true, row: rowToProgram(row), oldFile: replaced ? oldFile : null, oldStillReferenced };
  });
}

export async function clearProgramCover(pool, id, rev, actor) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return { error: 'no such program', code: 'not-found' };
    const before = rows[0];
    if (before.deleted_at) return { error: 'this program is in the trash', code: 'in-trash' };
    if (Number(before.rev) !== Number(rev)) return { error: 'changed since you loaded it', code: 'stale', current: rowToProgram(before) };
    if (!before.cover_file) return { error: 'no cover to remove', code: 'no-cover' };
    const oldFile = before.cover_file;
    const { rows: [row] } = await client.query(
      `UPDATE programs SET cover_file=NULL, cover_mime=NULL, cover_width=NULL, cover_height=NULL,
         cover_bytes=NULL, cover_alt=NULL, cover_updated_at=now(), cover_updated_by=$1, rev = rev + 1
       WHERE id = $2 RETURNING *`,
      [actor?.id || null, id]
    );
    await recordEvent(client, { programId: id, programTitle: row.title, action: 'cover_remove', actor, changes: { cover: [oldFile, null] } });
    const oldStillReferenced = await coverStillReferenced(client, oldFile);
    return { ok: true, row: rowToProgram(row), oldFile, oldStillReferenced };
  });
}

// Every cover file any row (including the trash) still points at — the sweep's allow-list for
// deciding which files under DATA_DIR/program-covers are orphans (server.js).
export async function getAllCoverFiles(pool) {
  const { rows } = await pool.query('SELECT DISTINCT cover_file FROM programs WHERE cover_file IS NOT NULL');
  return new Set(rows.map(r => r.cover_file));
}

// Boot's one-time migration of whatever db.json still holds.
export async function upsertPasskey(pool, { id, userId, publicKey, counter, transports, name, created, lastUsed }) {
  await pool.query(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id, public_key = EXCLUDED.public_key, counter = EXCLUDED.counter,
       transports = EXCLUDED.transports, name = EXCLUDED.name, created_at = EXCLUDED.created_at,
       last_used_at = EXCLUDED.last_used_at`,
    [id, userId, publicKey, counter || 0, transportsOf(transports), name || null,
      created ? new Date(created) : new Date(), lastUsed ? new Date(lastUsed) : null]
  );
}

/* ---------- teacher/student roles, links, assignments & notes (ISO-1594/ISO-1609) ----------
 * `endLink` is the one place a teacher/student relationship actually ends, whatever the reason
 * (the student unlinking, the teacher removing them, or the teacher losing their role) — one
 * transaction that drops the link, records the event, erases the pair's notes (D13: a note never
 * outlives the relationship that justified it) and closes out any still-active assignment. Every
 * route that can end a link calls this rather than open-coding its effects a second time.
 */

// Sequential, not Promise.all: a single client runs one statement at a time (concurrent queries
// on the same connection are deprecated in `pg` and due to go away), and there is no dependency
// between these worth racing anyway — all four commit or roll back together either way.
async function endLinkTx(client, studentId, teacherId, reason) {
  const assignmentEndReason = reason === 'role-revoked' ? 'role-revoked' : 'unlinked';
  await client.query('DELETE FROM teacher_links WHERE student_id = $1', [studentId]);
  await client.query(
    'INSERT INTO teacher_link_events (student_id, teacher_id, action, reason) VALUES ($1,$2,$3,$4)',
    [studentId, teacherId, 'end', reason]
  );
  await client.query('DELETE FROM teacher_notes WHERE student_id = $1', [studentId]);
  await client.query(
    'UPDATE teacher_assignments SET ended_at = now(), end_reason = $2 WHERE student_id = $1 AND ended_at IS NULL',
    [studentId, assignmentEndReason]
  );
}

// `reason`: 'by-student' | 'by-teacher' | 'role-revoked'. A student with no link at all (already
// gone, or never had one) is a no-op, not an error — DELETE /api/account/teacher answers the same
// 200 either way.
export async function endLink(pool, studentId, reason) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query('SELECT teacher_id FROM teacher_links WHERE student_id = $1', [studentId]);
    if (!rows.length) return { ok: true };
    await endLinkTx(client, studentId, rows[0].teacher_id, reason);
    return { ok: true };
  });
}

// Every student still linked to `teacherId`, ended the same way role-revoke does. Shared by
// setUserRole's revoke branch and deleteUser below — the two other ways (besides a student
// unlinking themselves) a teacher/student relationship ends, and D14's own rule ("desvincular ou
// retirar o papel encerra a ativa") makes no exception for account deletion being a third. A
// teacher with no students at all finds zero rows and is a no-op.
async function endAllLinksOfTeacher(client, teacherId, reason) {
  const { rows } = await client.query('SELECT student_id FROM teacher_links WHERE teacher_id = $1', [teacherId]);
  for (const { student_id } of rows) await endLinkTx(client, student_id, teacherId, reason);
}

// Grant is a plain column flip; revoke ends every link this account still teaches (the same
// transaction the row flip is in) and drops its own invites — a half-revoked teacher (still
// linked to students, say) is not a state this leaves on a failure partway through.
export async function setUserRole(pool, id, role) {
  if (role === 'teacher') {
    await pool.query("UPDATE users SET role = 'teacher' WHERE id = $1", [id]);
    return;
  }
  await withTransaction(pool, async client => {
    await client.query("UPDATE users SET role = 'student' WHERE id = $1", [id]);
    await endAllLinksOfTeacher(client, id, 'role-revoked');
    await client.query('DELETE FROM teacher_invites WHERE teacher_id = $1', [id]);
  });
}

export async function countStudentsOfTeacher(pool, teacherId) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM teacher_links WHERE teacher_id = $1', [teacherId]);
  return rows[0].n;
}

/* ---------- teacher invites ---------- */

// Not atomic against a concurrent create from the same account (unlike MAX_PASSKEYS, this isn't
// a "last way in" style security property — at most one invite over the cap could slip through a
// true race, which costs nothing but an extra, otherwise-ordinary row).
export async function createTeacherInvite(pool, teacherId, { hash, note, expiresAt }) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM teacher_invites WHERE teacher_id = $1 AND expires_at > now()', [teacherId]
  );
  if (rows[0].n >= MAX_ACTIVE_INVITES) {
    return { error: `a teacher can have at most ${MAX_ACTIVE_INVITES} active invites`, code: 'invite-limit' };
  }
  await pool.query(
    'INSERT INTO teacher_invites (hash, teacher_id, note, expires_at) VALUES ($1,$2,$3,$4)',
    [hash, teacherId, note || null, new Date(expiresAt)]
  );
  return { ok: true };
}

function rowToTeacherInvite(row) {
  return { hash: row.hash, ...(row.note ? { note: row.note } : {}), created: row.created_at.toISOString(), expires: row.expires_at.getTime() };
}

export async function listTeacherInvites(pool, teacherId) {
  const { rows } = await pool.query(
    'SELECT * FROM teacher_invites WHERE teacher_id = $1 AND expires_at > now() ORDER BY created_at DESC', [teacherId]
  );
  return rows.map(rowToTeacherInvite);
}

export async function revokeTeacherInvite(pool, teacherId, hash) {
  const { rowCount } = await pool.query('DELETE FROM teacher_invites WHERE hash = $1 AND teacher_id = $2', [hash, teacherId]);
  return rowCount > 0;
}

// Read-only, for the preview a student sees before deciding to accept — does not use the code up.
export async function peekTeacherInvite(pool, hash) {
  const { rows } = await pool.query(
    'SELECT ti.teacher_id, u.name AS teacher_name FROM teacher_invites ti JOIN users u ON u.id = ti.teacher_id WHERE ti.hash = $1 AND ti.expires_at > now()',
    [hash]
  );
  return rows.length ? { teacherId: rows[0].teacher_id, teacherName: rows[0].teacher_name } : null;
}

/* ---------- the link itself ---------- */

function rowToLink(row) {
  return {
    studentId: row.student_id, teacherId: row.teacher_id, scopeVersion: row.scope_version,
    shareBodyweight: row.share_bodyweight, acceptedAt: row.accepted_at.toISOString()
  };
}

export async function getTeacherLink(pool, studentId) {
  const { rows } = await pool.query('SELECT * FROM teacher_links WHERE student_id = $1', [studentId]);
  return rows.length ? rowToLink(rows[0]) : null;
}

// requireStudentOf's own read — scoped to the one teacher asking, so a student linked to someone
// else answers exactly like one with no link at all (D11: one uniform refusal either way).
export async function getLinkForTeacher(pool, teacherId, studentId) {
  const { rows } = await pool.query('SELECT * FROM teacher_links WHERE student_id = $1 AND teacher_id = $2', [studentId, teacherId]);
  return rows.length ? rowToLink(rows[0]) : null;
}

export async function listStudentsOfTeacher(pool, teacherId) {
  const { rows } = await pool.query('SELECT * FROM teacher_links WHERE teacher_id = $1 ORDER BY accepted_at', [teacherId]);
  return rows.map(rowToLink);
}

class AcceptProblem extends Error {
  constructor(code) { super(code); this.code = code; }
}

// One transaction: claim the code (DELETE … RETURNING, same atomic-claim shape as
// consumeInvite/burnDeviceLink), re-check every acceptProblem() rule against what was actually
// claimed, and only then insert the link and its event(s). Any refusal throws AcceptProblem,
// which rolls the claim back too — a code that didn't let anyone in is not spent (D11's matrix:
// "convite não consumido" on already-has-teacher).
export async function acceptTeacherInvite(pool, { hash, student, scopeVersion, shareBodyweight, now = Date.now() }) {
  try {
    return await withTransaction(pool, async client => {
      const claimed = await client.query('DELETE FROM teacher_invites WHERE hash = $1 RETURNING teacher_id, expires_at', [hash]);
      const invite = claimed.rows.length
        ? { teacherId: claimed.rows[0].teacher_id, expiresAt: claimed.rows[0].expires_at.getTime() }
        : null;
      const { rows: linkRows } = await client.query('SELECT teacher_id FROM teacher_links WHERE student_id = $1', [student.id]);
      const existingLink = linkRows.length ? { teacherId: linkRows[0].teacher_id } : null;
      const problem = acceptProblem({ invite, student, now, existingLink });
      if (problem) throw new AcceptProblem(problem);
      await client.query(
        'INSERT INTO teacher_links (student_id, teacher_id, scope_version, share_bodyweight) VALUES ($1,$2,$3,$4)',
        [student.id, invite.teacherId, scopeVersion, shareBodyweight === true]
      );
      await client.query(
        "INSERT INTO teacher_link_events (student_id, teacher_id, action, scope_version) VALUES ($1,$2,'accept',$3)",
        [student.id, invite.teacherId, scopeVersion]
      );
      if (shareBodyweight === true) {
        await client.query(
          "INSERT INTO teacher_link_events (student_id, teacher_id, action) VALUES ($1,$2,'bodyweight-on')",
          [student.id, invite.teacherId]
        );
      }
      return { ok: true, teacherId: invite.teacherId };
    });
  } catch (e) {
    if (e instanceof AcceptProblem) return { error: e.code, code: e.code };
    throw e;
  }
}

// The opt-in a student flips any time from "Meu professor" (D12) — never on the teacher's own
// say-so. A student with no teacher at all gets `not-found`, same code DELETE-less routes use.
export async function setShareBodyweight(pool, studentId, share) {
  return withTransaction(pool, async client => {
    const { rows } = await client.query(
      'UPDATE teacher_links SET share_bodyweight = $2 WHERE student_id = $1 RETURNING teacher_id', [studentId, share === true]
    );
    if (!rows.length) return { error: 'no teacher linked', code: 'not-found' };
    await client.query(
      'INSERT INTO teacher_link_events (student_id, teacher_id, action) VALUES ($1,$2,$3)',
      [studentId, rows[0].teacher_id, share === true ? 'bodyweight-on' : 'bodyweight-off']
    );
    return { ok: true };
  });
}

/* ---------- assignments (D14) ---------- */

function rowToAssignment(row) {
  const d = row.starts_on;
  const startsOn = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : d;
  return {
    id: row.id, teacherId: row.teacher_id, studentId: row.student_id, kind: row.kind, payload: row.payload,
    startsOn, days: row.days || null, createdAt: row.created_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null, endReason: row.end_reason || null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    endAckedAt: row.end_acked_at ? row.end_acked_at.toISOString() : null
  };
}

export async function getActiveAssignment(pool, studentId) {
  const { rows } = await pool.query('SELECT * FROM teacher_assignments WHERE student_id = $1 AND ended_at IS NULL', [studentId]);
  return rows.length ? rowToAssignment(rows[0]) : null;
}

// Trading one assignment for another (or making the first one) is one transaction: end whatever
// is active (`end_reason = 'replaced'`), then insert the new row. Two such calls racing the same
// student can both run the UPDATE (the second simply matches nothing once the first commits), but
// only one INSERT can ever satisfy teacher_assignments_one_active — the loser's unique_violation
// is this function's own half of the 409 the route answers (D14).
export async function assignToStudent(pool, { teacherId, studentId, kind, payload, startsOn, days }) {
  return withTransaction(pool, async client => {
    await client.query(
      "UPDATE teacher_assignments SET ended_at = now(), end_reason = 'replaced' WHERE student_id = $1 AND ended_at IS NULL",
      [studentId]
    );
    const id = newId();
    try {
      await client.query(
        'INSERT INTO teacher_assignments (id, teacher_id, student_id, kind, payload, starts_on, days) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, teacherId, studentId, kind, payload, startsOn, days && days.length ? days : null]
      );
    } catch (e) {
      if (e.code === '23505') return { error: 'another assignment is already active for this student', code: 'assignment-conflict' };
      throw e;
    }
    return { ok: true, row: await getActiveAssignment(client, studentId) };
  });
}

export async function endAssignment(pool, teacherId, studentId) {
  const { rowCount } = await pool.query(
    "UPDATE teacher_assignments SET ended_at = now(), end_reason = 'ended' WHERE teacher_id = $1 AND student_id = $2 AND ended_at IS NULL",
    [teacherId, studentId]
  );
  if (!rowCount) return { error: 'no active assignment', code: 'no-active-assignment' };
  return { ok: true };
}

export async function listAssignmentHistory(pool, studentId, limit = 10) {
  const { rows } = await pool.query(
    'SELECT * FROM teacher_assignments WHERE student_id = $1 AND ended_at IS NOT NULL ORDER BY created_at DESC LIMIT $2',
    [studentId, limit]
  );
  return rows.map(rowToAssignment);
}

// What the student's own pull reads (GET /api/account/assignments), independent of whether a
// link still exists — a student who just unlinked still has to be told their teacher's last
// assignment ended (the "ended" half below never needs the link, only the row).
export async function getPendingAndEndedAssignments(pool, studentId) {
  const [pending, ended] = await Promise.all([
    pool.query('SELECT * FROM teacher_assignments WHERE student_id = $1 AND ended_at IS NULL AND delivered_at IS NULL', [studentId]),
    pool.query(
      'SELECT * FROM teacher_assignments WHERE student_id = $1 AND ended_at IS NOT NULL AND delivered_at IS NOT NULL AND end_acked_at IS NULL',
      [studentId]
    )
  ]);
  return { pending: pending.rows.map(rowToAssignment), ended: ended.rows.map(rowToAssignment) };
}

// Marks whichever half of the ack this assignment is still waiting on — delivered (the app
// imported it) or end-acked (the app noticed it ended). Scoped to the caller's own id; an
// assignment of another student's is exactly as absent as one that does not exist (D11's spirit,
// applied to the student's own routes too).
export async function ackAssignment(pool, studentId, id) {
  const { rows } = await pool.query('SELECT ended_at FROM teacher_assignments WHERE id = $1 AND student_id = $2', [id, studentId]);
  if (!rows.length) return { error: 'no such assignment', code: 'not-found' };
  if (rows[0].ended_at == null) {
    await pool.query('UPDATE teacher_assignments SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL', [id]);
  } else {
    await pool.query('UPDATE teacher_assignments SET end_acked_at = now() WHERE id = $1 AND end_acked_at IS NULL', [id]);
  }
  return { ok: true };
}

/* ---------- notes (D13) ---------- */

function rowToNote(row) {
  return { id: row.id, body: row.body, created: row.created_at.toISOString(), updated: row.updated_at.toISOString() };
}

export async function listNotes(pool, teacherId, studentId) {
  const { rows } = await pool.query(
    'SELECT * FROM teacher_notes WHERE teacher_id = $1 AND student_id = $2 ORDER BY created_at DESC', [teacherId, studentId]
  );
  return rows.map(rowToNote);
}

// A plain `count(*) < cap` in the INSERT's own WHERE (the subquery trick MAX_PASSKEYS uses) takes
// no lock by itself — see insertPasskey's own comment on exactly this: two concurrent connections
// each get their own READ COMMITTED snapshot of the count and can both pass. The advisory lock,
// keyed on the pair, is what actually serializes two notes racing the same teacher+student: the
// second one waits for the first to commit (or roll back) before it takes its own count.
export async function createNote(pool, teacherId, studentId, body) {
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [teacherId + ':' + studentId]);
    const { rows: [{ n }] } = await client.query(
      'SELECT count(*)::int AS n FROM teacher_notes WHERE teacher_id = $1 AND student_id = $2', [teacherId, studentId]
    );
    if (n >= MAX_NOTES_PER_STUDENT) return { error: `a teacher can have at most ${MAX_NOTES_PER_STUDENT} notes per student`, code: 'notes-limit' };
    const id = newId();
    await client.query('INSERT INTO teacher_notes (id, teacher_id, student_id, body) VALUES ($1,$2,$3,$4)', [id, teacherId, studentId, body]);
    const { rows: [row] } = await client.query('SELECT * FROM teacher_notes WHERE id = $1', [id]);
    return { ok: true, row: rowToNote(row) };
  });
}

// The WHERE filters by teacher_id *and* student_id, not just the note's own id: a note id from
// another pair (another teacher, or the same teacher's note about a different student) matches
// nothing here, same uniform `note-not-found` either way (D11's shape, carried into notes).
export async function updateNote(pool, teacherId, studentId, noteId, body) {
  const { rows } = await pool.query(
    'UPDATE teacher_notes SET body = $1, updated_at = now() WHERE id = $2 AND teacher_id = $3 AND student_id = $4 RETURNING *',
    [body, noteId, teacherId, studentId]
  );
  if (!rows.length) return { error: 'no such note', code: 'note-not-found' };
  return { ok: true, row: rowToNote(rows[0]) };
}

export async function deleteNote(pool, teacherId, studentId, noteId) {
  const { rowCount } = await pool.query(
    'DELETE FROM teacher_notes WHERE id = $1 AND teacher_id = $2 AND student_id = $3', [noteId, teacherId, studentId]
  );
  return rowCount > 0;
}
