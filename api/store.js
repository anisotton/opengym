/* PostgreSQL-backed access for the pieces of db.json / state-<uid>.json converted so far
 * (ISO-1403, Phase 1b): a profile's training data (user_state) and now `users` itself — identity,
 * passwords, admin/disabled flags, session_version. `passkeys` (db.creds), invites, push
 * subscriptions and device links are still db.json for now; `users.invited_by`/`password_reset_by`
 * keep their FK targets but nothing here writes `invited_by` yet (see createUser/upsertUser) since
 * invites have nowhere in Postgres to point at until they move too.
 */

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
    `INSERT INTO users (id, name, email, password_hash, password_set_at, created_at, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user.id, user.name, user.email || null, user.pw?.h || null, user.pw?.set || null, user.created,
      extraOf(user)
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

export async function setEmail(pool, id, email) {
  await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, id]);
}

export async function setDisabled(pool, id, disabled) {
  await pool.query('UPDATE users SET disabled = $1 WHERE id = $2', [disabled, id]);
}

export async function touchLastPull(pool, id, whenMs) {
  await pool.query('UPDATE users SET last_pull_at = $1 WHERE id = $2', [new Date(whenMs), id]);
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
