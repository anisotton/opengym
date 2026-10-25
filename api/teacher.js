/* Pure rules for teacher/student roles, the link between them and workout assignments (ISO-1594
 * / ISO-1609). Same split as programs.js/device-link.js/passkeys-store.js: nothing here touches
 * PostgreSQL — store.js (the rows) and server.js (the routes) do that.
 *
 * `teacherView` is the whole point of this file existing: a teacher never reads a student's raw
 * JSONB state, only this allowlisted projection (D5/D6). It is versioned (TEACHER_SCOPE_VERSION)
 * so a wider scope later requires every student to consent again — the accept route stores the
 * version accepted, and a stale one is refused (acceptProblem's sibling check, scope-outdated, is
 * the route's own, since it needs the account's live link to compare against).
 */
import crypto from 'node:crypto';

export const ROLES = ['student', 'teacher'];
export function normalizeRole(v) {
  return ROLES.includes(v) ? v : null;
}

// Same id shape as users.id/programs.id — crypto.randomBytes(12) base64url. Shared by assignments
// and notes, which have no other reason to each carry their own id generator.
export function newId() {
  return crypto.randomBytes(12).toString('base64url');
}

/* ---------- teacher invites (same code math as device-link.js, a different domain) ---------- */

export const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a class forms over weeks, not minutes
export const MAX_ACTIVE_INVITES = 20;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
const CODE_LENGTH = 12;

export function newInviteCode() {
  const raw = Array.from(crypto.randomBytes(CODE_LENGTH), b => ALPHABET[b % ALPHABET.length]).join('');
  return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8);
}
const cleanCode = code => (typeof code === 'string' ? code : '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// A domain-separated hash, distinct from device-link.js's own, so the same raw bytes never collide
// across the two single-use-code tables even if the alphabets ever matched by coincidence.
export const hashInviteCode = code => crypto.createHash('sha256').update('opengym-teacher-invite:' + cleanCode(code)).digest('hex');

/* ---------- the allowlisted projection a teacher is ever handed (D5/D6) ---------- */

export const TEACHER_SCOPE_VERSION = 1;
export const TEACHER_SCOPE = ['workouts', 'routines', 'customEx', 'unit'];
export const TEACHER_SCOPE_OPTIONAL = ['bodyweight'];
export const TEACHER_SCOPE_NEVER = ['exNotes', 'media', 'coach', 'settings', 'email', 'birthDate'];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const records = v => (Array.isArray(v) ? v.filter(isObj) : []);
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const WORKOUT_KEYS = ['id', 'd', 'start', 'end', 'name', 'entries', 'routineIds', 'routineId', 'prs', 'excludeFromProgression'];
const ENTRY_KEYS = ['id', 'sets', 'topW', 'target', 'rid', 'noProg', 'planned', 'sg'];
const ROUTINE_KEYS = ['id', 'name', 'emoji', 'prog', 'ex', 'fromTeacher', 'fromProgramId'];
const EX_IN_ROUTINE_KEYS = ['id', 'sets', 'reps', 'sec', 'mode', 'weight', 'prog', 'superset'];
const CUSTOM_EX_KEYS = ['id', 'name', 'muscle', 'emoji'];

function viewWorkout(w) {
  const v = pick(w, WORKOUT_KEYS);
  if (Array.isArray(v.entries)) v.entries = records(v.entries).map(e => pick(e, ENTRY_KEYS));
  return v;
}
function viewRoutine(r) {
  const v = pick(r, ROUTINE_KEYS);
  if (Array.isArray(v.ex)) v.ex = records(v.ex).map(e => pick(e, EX_IN_ROUTINE_KEYS));
  return v;
}

/**
 * `state`: a student's raw document (user_state.state). `opts.bodyweight`: whether the student's
 * opt-in (teacher_links.share_bodyweight) is currently on — read fresh by the caller on every
 * request (D10), never cached. Everything not explicitly copied here — exNotes, media, coach,
 * settings, the account's own email/birthDate — simply never reaches the return value: this
 * builds a brand new object field by field, rather than filtering a copy of `state`.
 */
export function teacherView(state, { bodyweight = false } = {}) {
  const S = isObj(state) ? state : {};
  const workouts = records(S.workouts).map(viewWorkout);
  const routines = records(S.routines).map(viewRoutine);
  const usedIds = new Set();
  for (const w of workouts) for (const e of records(w.entries)) if (e.id) usedIds.add(e.id);
  for (const r of routines) for (const e of records(r.ex)) if (e.id) usedIds.add(e.id);
  const customEx = records(S.customEx).filter(c => usedIds.has(c.id)).map(c => pick(c, CUSTOM_EX_KEYS));
  return {
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    workouts, routines, customEx,
    ...(bodyweight ? { bodyweight: records(S.bodyweight).map(b => pick(b, ['d', 'w'])) } : {})
  };
}

/* ---------- accepting an invite ---------- */

/**
 * `invite`: the just-claimed row (`{ teacherId, expiresAt }`) or null for a code that did not
 * exist/was already used — the route's atomic DELETE … RETURNING already told the two apart.
 * `student`: the signed-in account accepting. `existingLink`: whatever `teacher_links` row the
 * student already has, if any. scope-outdated is deliberately not checked here: it compares the
 * caller's claimed `scopeVersion` against TEACHER_SCOPE_VERSION, a check the route makes before
 * ever touching the invite, so a stale app never burns a class code for nothing.
 */
export function acceptProblem({ invite, student, now = Date.now(), existingLink }) {
  if (!invite) return 'invite-invalid';
  if (invite.expiresAt <= now) return 'invite-expired';
  if (invite.teacherId === student.id) return 'self-invite';
  if (existingLink) return 'already-has-teacher';
  return null;
}

/* ---------- assigning a routine ---------- */

export const ROUTINE_NAME_MIN = 1, ROUTINE_NAME_MAX = 120;
export const ROUTINE_EX_MIN = 1, ROUTINE_EX_MAX = 40;
export const ROUTINE_PAYLOAD_MAX_BYTES = 64 * 1024;
const BUILTIN_EX_ID_RE = /^\d{4}$/;
const EX_MODES = ['reps', 'time'];
const fail = (field, error) => ({ ok: false, field, error });
const collapse = v => String(v ?? '').replace(/\s+/g, ' ').trim();

function validateEmbeddedCustomEx(list) {
  if (list == null) return { ok: true, value: [], ids: new Set() };
  if (!Array.isArray(list) || list.length > ROUTINE_EX_MAX) return fail('customEx', 'customEx must be a short list');
  const ids = new Set();
  const value = [];
  for (const c of list) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || ids.has(c.id)) return fail('customEx', 'each custom exercise needs a unique id');
    const name = collapse(c.name);
    if (!name || name.length > 60) return fail('customEx', 'each custom exercise needs a 1-60 character name');
    ids.add(c.id);
    value.push({ id: c.id, name, ...(c.muscle ? { muscle: String(c.muscle).slice(0, 40) } : {}) });
  }
  return { ok: true, value, ids };
}

function validateExercise(ex, customIds) {
  if (!isObj(ex) || typeof ex.id !== 'string') return fail('ex', 'every exercise needs an id');
  if (!BUILTIN_EX_ID_RE.test(ex.id) && !customIds.has(ex.id)) return fail('ex', 'exercise id is neither a built-in id nor an embedded custom exercise');
  const sets = ex.sets;
  if (!Number.isInteger(sets) || sets < 1 || sets > 20) return fail('ex', 'sets must be an integer 1-20');
  const mode = EX_MODES.includes(ex.mode) ? ex.mode : (ex.sec != null ? 'time' : 'reps');
  const value = { id: ex.id, sets, mode };
  if (mode === 'time') {
    if (!Number.isInteger(ex.sec) || ex.sec < 1 || ex.sec > 7200) return fail('ex', 'sec must be an integer 1-7200');
    value.sec = ex.sec;
  } else {
    if (!Number.isInteger(ex.reps) || ex.reps < 1 || ex.reps > 200) return fail('ex', 'reps must be an integer 1-200');
    value.reps = ex.reps;
    if (ex.weight != null) {
      if (typeof ex.weight !== 'number' || !Number.isFinite(ex.weight) || ex.weight < 0 || ex.weight > 2000) {
        return fail('ex', 'weight must be a number 0-2000');
      }
      value.weight = ex.weight;
    }
  }
  if (typeof ex.prog === 'string' && ex.prog) value.prog = ex.prog.slice(0, 20);
  if (ex.superset) value.superset = String(ex.superset).slice(0, 8);
  return { ok: true, value };
}

/**
 * `routine`: the request body's own shape — `{ name, ex, customEx? }`. Returns a normalized
 * snapshot (never a live reference back to the teacher's library, D16) or `{ ok: false, field,
 * error }`. The embedded `customEx` list is validated first so `validateExercise` has every id a
 * `ex[].id` may legally point at.
 */
export function validateRoutineAssignment(routine) {
  const body = isObj(routine) ? routine : {};
  const name = collapse(body.name);
  if (name.length < ROUTINE_NAME_MIN || name.length > ROUTINE_NAME_MAX) {
    return fail('name', `name must be ${ROUTINE_NAME_MIN}-${ROUTINE_NAME_MAX} characters`);
  }
  const customResult = validateEmbeddedCustomEx(body.customEx);
  if (!customResult.ok) return customResult;
  const exList = Array.isArray(body.ex) ? body.ex : [];
  if (exList.length < ROUTINE_EX_MIN || exList.length > ROUTINE_EX_MAX) {
    return fail('ex', `ex must have ${ROUTINE_EX_MIN}-${ROUTINE_EX_MAX} exercises`);
  }
  const ex = [];
  for (const e of exList) {
    const r = validateExercise(e, customResult.ids);
    if (!r.ok) return r;
    ex.push(r.value);
  }
  const value = { name, ex, ...(customResult.value.length ? { customEx: customResult.value } : {}) };
  if (JSON.stringify(value).length > ROUTINE_PAYLOAD_MAX_BYTES) return fail('ex', 'routine is too large');
  return { ok: true, value };
}

/* ---------- scheduling an assignment ---------- */

export const SCHEDULE_PAST_DAYS = 7, SCHEDULE_FUTURE_DAYS = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localISO(d);
};
function localISO(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * `{ startsOn, days }`: the request body's own fields. `now`: injectable for tests. Returns
 * `{ ok: true, value: { startsOn, days } }` (`days` normalized to `null` or a sorted, deduped
 * list of 0-6) or `{ ok: false, field, error }`.
 */
export function validateSchedule({ startsOn, days } = {}, now = new Date()) {
  if (typeof startsOn !== 'string' || !DATE_RE.test(startsOn)) return fail('startsOn', 'startsOn must be YYYY-MM-DD');
  const today = localISO(now);
  const earliest = addDays(today, -SCHEDULE_PAST_DAYS), latest = addDays(today, SCHEDULE_FUTURE_DAYS);
  if (startsOn < earliest || startsOn > latest) return fail('startsOn', `startsOn must be within ${SCHEDULE_PAST_DAYS} days in the past and ${SCHEDULE_FUTURE_DAYS} days in the future`);
  if (days == null) return { ok: true, value: { startsOn, days: null } };
  if (!Array.isArray(days) || days.length < 1 || days.length > 7) return fail('days', 'days must be a list of 1-7 weekdays');
  const uniq = [...new Set(days)];
  if (uniq.length !== days.length || !uniq.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return fail('days', 'days must be unique integers 0-6');
  }
  return { ok: true, value: { startsOn, days: uniq.sort((a, b) => a - b) } };
}

/* ---------- notes (D13) ---------- */

export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES_PER_STUDENT = 500;

export function validateNote(body) {
  const v = String(body ?? '').trim();
  if (!v) return { ok: false, code: 'note-empty', error: 'note cannot be empty' };
  if (v.length > MAX_NOTE_CHARS) return { ok: false, code: 'note-too-long', error: `note must be at most ${MAX_NOTE_CHARS} characters` };
  return { ok: true, value: v };
}

/* ---------- summary & adherence (D15) ---------- */

export const IDLE_DAYS = 7;
export const ADHERENCE_WINDOW_DAYS = 28;

const toLocalISO = v => (v instanceof Date ? localISO(v) : localISO(new Date(v)));
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const mondayOf = iso => addDays(iso, -((new Date(iso + 'T12:00:00').getDay() + 6) % 7));

function computeAdherence(view, assignment, today) {
  if (!assignment || assignment.kind !== 'routine' || !assignment.days || !assignment.days.length) return null;
  const windowStart = assignment.startsOn > addDays(today, -(ADHERENCE_WINDOW_DAYS - 1))
    ? assignment.startsOn : addDays(today, -(ADHERENCE_WINDOW_DAYS - 1));
  const endAt = assignment.endedAt ? toLocalISO(assignment.endedAt) : today;
  const windowEnd = endAt < today ? endAt : today;
  if (windowStart > windowEnd) return null;
  const assignedRoutineIds = new Set(records(view?.routines).filter(r => r?.fromTeacher?.assignmentId === assignment.id).map(r => r.id));
  const workoutDates = new Set();
  for (const w of records(view?.workouts)) {
    if (!w?.d || w.d < windowStart || w.d > windowEnd) continue;
    const ids = [].concat(w.routineIds || (w.routineId ? [w.routineId] : []));
    if (ids.some(id => assignedRoutineIds.has(id))) workoutDates.add(w.d);
  }
  let expected = 0;
  for (let d = windowStart; d <= windowEnd; d = addDays(d, 1)) {
    if (d === today && !workoutDates.has(today)) continue; // today only counts once it already has a workout
    const dow = new Date(d + 'T12:00:00').getDay();
    if (assignment.days.includes(dow)) expected++;
  }
  if (!expected) return null;
  return { done: workoutDates.size, expected, ratio: Math.min(1, workoutDates.size / expected) };
}

/**
 * `view`: a `teacherView(...)` result — never the raw state (D15). `assignment`: the student's
 * active assignment (`{ id, kind, startsOn, days, endedAt }`) or null. `now`: a Date, injectable
 * for tests. `opts.acceptedAt`: when nothing has ever been logged, idleDays counts from the
 * link's own acceptance instead of from a workout that does not exist.
 */
export function studentSummary(view, assignment, now = new Date(), { acceptedAt } = {}) {
  const dates = records(view?.workouts).map(w => w?.d).filter(Boolean).sort();
  const lastWorkoutAt = dates.length ? dates[dates.length - 1] : null;
  const today = toLocalISO(now);
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const workoutsThisWeek = dates.filter(d => d >= monday && d <= sunday).length;
  const since = lastWorkoutAt || (acceptedAt ? toLocalISO(acceptedAt) : null);
  const idleDays = since != null ? daysBetween(since, today) : null;
  const idle = idleDays != null && idleDays >= IDLE_DAYS;
  return { lastWorkoutAt, workoutsThisWeek, adherence: computeAdherence(view, assignment, today), idleDays, idle };
}
