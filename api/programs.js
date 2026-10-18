/* Pure rules for the admin Program catalog (ISO-1485) — validation, normalization and the diff
 * that becomes a program_events row. Nothing here touches PostgreSQL or the filesystem; store.js
 * (the rows) and server.js (the routes, the cover file) do that. Same split device-link.js and
 * passkeys-store.js already use between "the shape a thing may take" (here) and "the row itself".
 *
 * "Program" is the only name this entity goes by in code, routes, SQL and docs — see
 * docs/ADMIN_PROGRAMS.md §1 for why "training" never appears here: Workout already means a
 * logged session and Routine already means a user's own exercise list, both elsewhere in this
 * codebase.
 */
import crypto from 'node:crypto';

export const CATEGORIES = ['strength', 'hypertrophy', 'conditioning', 'mobility', 'general'];
export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
export const STATUSES = ['draft', 'published'];

export const CATEGORY_LABELS = {
  strength: 'Strength', hypertrophy: 'Hypertrophy', conditioning: 'Conditioning',
  mobility: 'Mobility', general: 'General fitness'
};
export const DIFFICULTY_LABELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

export const TITLE_MIN = 3, TITLE_MAX = 120;
export const DESCRIPTION_MAX = 5000;
export const SESSION_MINUTES_MIN = 1, SESSION_MINUTES_MAX = 600;
export const COVER_ALT_MIN = 3, COVER_ALT_MAX = 200;
export const COVER_WIDTH_MIN = 640, COVER_HEIGHT_MIN = 360, COVER_DIM_MAX = 4000;

// Same id shape as users.id (migrations/001_init.sql) — crypto.randomBytes(12) base64url.
export function newProgramId() {
  return crypto.randomBytes(12).toString('base64url');
}

// Trim + collapse internal whitespace: "  Hips   & T-spine " -> "Hips & T-spine". Applied before
// length-checking and before the DB's lower()-based uniqueness check, so two titles that differ
// only by stray whitespace collide instead of silently coexisting.
export function normalizeTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim();
}

const fail = (field, message) => ({ ok: false, field, error: message });

/**
 * `input`: the raw request body for create/update. With `partial: true` (update) only the fields
 * actually present are validated and returned; create (the default) requires every one.
 * Returns `{ ok: true, value }` with every field normalized, or `{ ok: false, field, error }` for
 * the first problem — server.js turns that straight into `400 {error, field}`.
 */
export function validateProgram(input, { partial = false } = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const value = {};
  const has = k => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('title')) {
    const title = normalizeTitle(body.title);
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return fail('title', `title must be ${TITLE_MIN}-${TITLE_MAX} characters`);
    }
    value.title = title;
  }
  if (!partial || has('description')) {
    const description = typeof body.description === 'string' ? body.description : '';
    if (description.length > DESCRIPTION_MAX) return fail('description', `description must be at most ${DESCRIPTION_MAX} characters`);
    value.description = description;
  }
  if (!partial || has('category')) {
    if (!CATEGORIES.includes(body.category)) return fail('category', `category must be one of ${CATEGORIES.join(', ')}`);
    value.category = body.category;
  }
  if (!partial || has('difficulty')) {
    if (!DIFFICULTIES.includes(body.difficulty)) return fail('difficulty', `difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    value.difficulty = body.difficulty;
  }
  if (!partial || has('sessionMinutes')) {
    const n = body.sessionMinutes;
    if (!Number.isInteger(n) || n < SESSION_MINUTES_MIN || n > SESSION_MINUTES_MAX) {
      return fail('sessionMinutes', `sessionMinutes must be an integer ${SESSION_MINUTES_MIN}-${SESSION_MINUTES_MAX}`);
    }
    value.sessionMinutes = n;
  }
  if (!partial || has('status')) {
    const status = has('status') ? body.status : 'draft';
    if (!STATUSES.includes(status)) return fail('status', `status must be one of ${STATUSES.join(', ')}`);
    value.status = status;
  }
  return { ok: true, value };
}

// Required whenever a cover is present; must describe the image rather than restate the title or
// the filename — the one lazy fallback this blocks ("cover", "img_2034.jpg", the title again).
const FILENAME_LIKE = /\.(jpe?g|png|webp|gif|heic|avif)$|^(img|cover|image|photo|dsc)[_-]?\d*$/i;
export function validateCoverAlt(alt, title) {
  const v = String(alt ?? '').trim();
  if (v.length < COVER_ALT_MIN || v.length > COVER_ALT_MAX) return fail('coverAlt', `coverAlt must be ${COVER_ALT_MIN}-${COVER_ALT_MAX} characters`);
  if (title && v.toLowerCase() === normalizeTitle(title).toLowerCase()) return fail('coverAlt', 'coverAlt must describe the image, not repeat the title');
  if (FILENAME_LIKE.test(v)) return fail('coverAlt', 'coverAlt must describe the image, not name the file');
  return { ok: true, value: v };
}

// The dimensions the client reports for its own already-cropped 16:9 image. Enforced again here
// because nothing server-side ever decodes the bytes to check them itself (see server.js's cover
// route) — a lie here only mis-sizes a `<img>` box, never anything that reads the file as more
// than opaque bytes.
export function validateCoverDims(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < COVER_WIDTH_MIN || h < COVER_HEIGHT_MIN || w > COVER_DIM_MAX || h > COVER_DIM_MAX) {
    return fail('cover', `cover must be at least ${COVER_WIDTH_MIN}x${COVER_HEIGHT_MIN} and at most ${COVER_DIM_MAX}x${COVER_DIM_MAX}`);
  }
  return { ok: true, value: { width: w, height: h } };
}

// program_events.changes — {field: [before, after]}. `description`'s own content collapses to
// the string 'changed' (plan §2.4): the point of this trail is who/when/what changed, not a
// 5000-character diff inline in every edit's history.
const SUMMARIZE_ONLY = new Set(['description']);
export function diffForEvent(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const b = before?.[k], a = after?.[k];
    if (b === a) continue;
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    changes[k] = SUMMARIZE_ONLY.has(k) ? 'changed' : [b ?? null, a ?? null];
  }
  return changes;
}

// PROGRAM_TRASH_DAYS / PROGRAM_COVER_MAX_MB — same "a value that doesn't parse falls back to its
// default" rule as media.js's mediaLimits: a typo in the env must not turn retention or the size
// cap off.
export function programConfig(env = process.env) {
  const num = (key, def, min) => {
    const raw = env[key];
    if (raw == null || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    trashDays: num('PROGRAM_TRASH_DAYS', 30, 0),   // 0 = never auto-purge
    coverMaxMB: num('PROGRAM_COVER_MAX_MB', 5, 0.001)
  };
}

// The server's own check on the typed confirmation (POST /api/admin/program/purge) — never trust
// the client-side gate alone. Exported so frontend/src/lib/programs.js mirrors the exact same rule
// rather than re-deriving it.
export function titleMatchesForPurge(typed, title) {
  const t = normalizeTitle(title);
  return t.length > 0 && normalizeTitle(typed) === t;
}
