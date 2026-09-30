/* PostgreSQL-backed access for the pieces of db.json / state-<uid>.json converted so far
 * (ISO-1403, Phase 1b). Everything else (auth, passkeys, invites, push subscriptions, device
 * links, sessions) is still db.json/in-memory for now — a later run of the same issue finishes
 * that half and this module grows with it.
 *
 * `user_state.user_id` carries a foreign key to `users(id)` (migrations/001_init.sql), so writing
 * a profile's state needs a matching row there first. Since `users` itself has not moved to
 * Postgres yet, `syncUser` keeps a minimal mirror (id + name only — nothing here reads it back)
 * just so that constraint holds; the row becomes the real thing, untouched, once a future run
 * migrates users for real.
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
