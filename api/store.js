/* PostgreSQL-backed access for db.json / state-<uid>.json (ISO-1403, Phase 1b — the last db.json
 * collection, passkey credentials, moved in this pass too): a profile's training data
 * (user_state), `users` itself — identity, passwords, admin/disabled flags, session_version —
 * invites, push subscriptions, device links and now passkeys.
 */

import { makeLinkCode, hashLinkCode, DEVICE_LINK_TTL_MS } from './device-link.js';
import { passkeyName, transportsOf, MAX_PASSKEYS } from './passkeys-store.js';

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
    ...(row.email ? { email: row.email } : {}),
    ...(row.email_verified_at ? { emailVerifiedAt: row.email_verified_at.toISOString() } : {}),
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
    `INSERT INTO users (id, name, email, birth_date, password_hash, password_set_at, created_at, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      user.id, user.name, user.email || null, user.birthDate || null,
      user.pw?.h || null, user.pw?.set || null, user.created, extraOf(user)
    ]
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

// CASCADEs to user_state (and, once they move here too, passkeys/sessions/push_subscriptions).
export async function deleteUser(pool, id) {
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
 * here. `otherWays` (passkeyRemovalRefused/removePasskey) is how many ways besides its passkeys
 * can still sign the profile in (a password, while the instance offers password sign-in);
 * server.js decides that, this only counts.
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

// The count check and the insert are one statement (a subquery in the WHERE), not a separate
// query followed by an INSERT — two additions racing the same account can't both slip past a
// count checked before either had committed. Pass a transaction client in place of `pool` to
// insert alongside the user row a fresh signup creates (registration ceremonies do) — same idea
// as consumeInvite.
export async function insertPasskey(pool, userId, cred) {
  const name = passkeyName(cred.name);
  const row = {
    id: cred.id, userId, publicKey: cred.publicKey, counter: cred.counter || 0,
    transports: transportsOf(cred.transports), created: cred.created || new Date().toISOString(),
    ...(cred.lastUsed ? { lastUsed: cred.lastUsed } : {}), ...(name ? { name } : {})
  };
  let rowCount;
  try {
    ({ rowCount } = await pool.query(
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
}

export async function renamePasskey(pool, userId, credId, name) {
  const { rows } = await pool.query(
    'UPDATE passkeys SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [passkeyName(name) || null, credId, userId]
  );
  return rows.length ? { ok: true, row: rowToPasskey(rows[0]) } : { error: 'passkey not found', code: 'not-found' };
}

// Why removing `credId` would be refused, or null when it could go. On its own so server.js can
// ask before it asks the owner for proof, and again, through removePasskey, once the proof is in.
export async function passkeyRemovalRefused(pool, userId, credId, otherWays = 0) {
  const cred = await getPasskeyById(pool, credId);
  if (!cred || cred.userId !== userId) return { error: 'passkey not found', code: 'not-found' };
  const mine = await countPasskeys(pool, userId);
  if (mine - 1 + otherWays < 1) return { error: 'this passkey is the only way into this profile', code: 'last-way-in' };
  return null;
}

export async function removePasskey(pool, userId, credId, otherWays = 0) {
  const refused = await passkeyRemovalRefused(pool, userId, credId, otherWays);
  if (refused) return refused;
  const { rows } = await pool.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING *', [credId, userId]);
  return { ok: true, row: rowToPasskey(rows[0]) };
}

// A passkey's own counter/last-use, touched by every ceremony that verifies an assertion against
// it (sign-in, a step-up proof) — used to be a mutation of the same in-memory row a lookup handed
// back; now its own write, since a read is never the same object twice.
export async function touchPasskeyUse(pool, id, counter) {
  await pool.query('UPDATE passkeys SET counter = $1, last_used_at = now() WHERE id = $2', [counter, id]);
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
  return { id: row.id, userId: row.user_id, ...row.data, updatedAt: row.updated_at.toISOString() };
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
