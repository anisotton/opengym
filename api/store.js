/* PostgreSQL-backed access for the pieces of db.json / state-<uid>.json converted so far
 * (ISO-1403, Phase 1b). Everything else (passkeys, invites, push subscriptions, device links,
 * sessions) is still db.json/in-memory for now — a later run of the same issue finishes that
 * half and this module grows with it.
 *
 * The `users` functions below (createUser onward) are not wired into server.js yet — that is
 * the next slice, a careful rewrite of the auth routes and the helpers they share (loginTarget,
 * setPassword, nameTaken/emailTaken and friends all close over db.users synchronously and call
 * each other, so switching the source under them touches most of the registration/login/password
 * surface at once). Landing the data-access layer on its own first, fully tested against real
 * PostgreSQL, means that rewrite starts from a store that already works rather than debugging
 * both at the same time. `syncUser` (the minimal id+name mirror) stays in use by server.js until
 * that wiring lands and `createUser` takes over as the one place a user row is ever written.
 */

// Mirrors one db.json user into the Postgres `users` table — id and name only, enough to satisfy
// user_state's foreign key. Called at boot for every existing user, and again right after a new
// one is created.
export async function syncUser(pool, user) {
  await pool.query(
    'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
    [user.id, user.name]
  );
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
      user.invitedBy ? { invitedBy: user.invitedBy } : {}
    ]
  );
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
