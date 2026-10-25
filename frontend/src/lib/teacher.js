/* Pure rules for the student side of the teacher/student feature (ISO-1594/ISO-1610): turning a
 * teacher's assignment (GET /api/account/assignments) into the student's own state, and the
 * consent-screen text shared by the invite-accept and "Meu professor" views. Nothing here talks
 * to the server — the sync loop in store/useStore.js calls these against a draft of `S`.
 */
import { uid } from './format.js'
import { t } from './i18n.js'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])

/* ---------- consent screen (D5): same source of truth on both ends ----------
 * Kept as English strings here (not field names) because the two screens that use this — the
 * invite-accept preview and Settings → "Meu professor" — show the exact wording a student agreed
 * to, not a list the UI assembles from a schema. The *fields* a teacher can ever read are
 * api/teacher.js's own TEACHER_SCOPE/TEACHER_SCOPE_OPTIONAL/TEACHER_SCOPE_NEVER — that module
 * cannot be imported here (it pulls in node:crypto, which does not bundle for the browser), so
 * TEACHER_SCOPE_VERSION below is a manually-kept mirror of api/teacher.js's own constant.
 * teacher.test.js checks the two stay in sync by importing api/teacher.js directly (safe under
 * Node/vitest, never bundled into the app).
 */
export const TEACHER_SCOPE_VERSION = 1;

/**
 * `version`: the scope version the caller is showing (normally TEACHER_SCOPE_VERSION itself).
 * Returns `null` for any other version — the caller's own "scope-outdated" handling (D11)
 * decides what to show instead; this never guesses at a wording for a version it doesn't know.
 */
export function scopeItems(version = TEACHER_SCOPE_VERSION) {
  if (version !== TEACHER_SCOPE_VERSION) return null;
  return {
    version,
    sees: [
      t('Your logged workouts (exercises, sets, weights) — no photos'),
      t('Your routines'),
      t('Custom exercises you use in them'),
      t('Whether you use kg or lb')
    ],
    neverSees: [
      t('Your personal notes on exercises'),
      t('Photos/videos of your workouts'),
      t('Your conversations with the Coach'),
      t('Your settings, e-mail and birth date')
    ]
    // Bodyweight is deliberately in neither list — it is its own opt-in toggle (D12), shown next
    // to this list by the view, not inside it.
  };
}

/* ---------- importing an assignment (D8) ---------- */

// A custom exercise embedded in an assignment keeps its id when the student's own customEx has
// no entry under that id yet, or an identical one already (repeat delivery of the same
// assignment, or two routines from the same teacher reusing the same embedded exercise). Only a
// genuine collision — same id, different exercise — gets remapped to a fresh id, so neither side
// is silently overwritten.
const sameCustomEx = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mergeCustomEx(existing, incoming) {
  const merged = list(existing).slice();
  const byId = new Map(merged.filter(c => c?.id != null).map(c => [c.id, c]));
  const idMap = new Map();
  for (const c of list(incoming)) {
    if (!c || c.id == null) continue;
    const current = byId.get(c.id);
    if (!current) {
      merged.push(c);
      byId.set(c.id, c);
      idMap.set(c.id, c.id);
    } else if (sameCustomEx(current, c)) {
      idMap.set(c.id, c.id);
    } else {
      const freshId = uid();
      const remapped = { ...c, id: freshId };
      merged.push(remapped);
      byId.set(freshId, remapped);
      idMap.set(c.id, freshId);
    }
  }
  return { customEx: merged, idMap };
}

/**
 * `assignment`: one entry of GET /api/account/assignments's `pending` list (`{ id, kind, payload,
 * startsOn, days, endedAt, endReason }`). Returns a new state with the assignment applied —
 * `state` itself is never mutated. Idempotent by `assignment.id`: importing the same assignment
 * twice (a repeated pull before the ack lands) returns `state` unchanged rather than a second
 * copy.
 *
 * `kind: 'routine'`: the payload's own name/ex/customEx (already validated/normalized
 * server-side, api/teacher.js's validateRoutineAssignment — never a live reference to the
 * teacher's library) becomes a new routine, id freshly generated, marked
 * `fromTeacher: { name, assignmentId }`. When the assignment carries `days`, the new routine is
 * also added to `week[d]` for each of them (rev 2) — a "no fixed days" assignment is never added
 * to the plan on its own; the student still sees it as the "Treino atual" on the teacher's side,
 * but nothing here schedules it.
 *
 * `kind: 'program'`: becomes the recommended-Program card (`S.teacherProgram`) instead of a
 * routine — a Program is a recommendation the student opts into, not content to copy into the
 * plan (D7/§3.2).
 */
export function importAssignment(state, assignment) {
  const S = isObj(state) ? state : {};
  if (!isObj(assignment) || !assignment.id) return S;

  if (assignment.kind === 'program') {
    if (S.teacherProgram?.assignmentId === assignment.id) return S; // already imported
    return {
      ...S,
      teacherProgram: {
        programId: assignment.payload?.programId ?? null,
        assignmentId: assignment.id,
        startsOn: assignment.startsOn ?? null,
        days: assignment.days ?? null
      }
    };
  }

  if (assignment.kind !== 'routine') return S;
  const routines = list(S.routines);
  if (routines.some(r => r?.fromTeacher?.assignmentId === assignment.id)) return S; // already imported

  const payload = isObj(assignment.payload) ? assignment.payload : {};
  const { customEx: mergedCustomEx, idMap } = mergeCustomEx(S.customEx, payload.customEx);
  const routine = {
    id: uid(),
    name: payload.name ?? '',
    ex: list(payload.ex).map(e => (idMap.has(e?.id) ? { ...e, id: idMap.get(e.id) } : e)),
    fromTeacher: { name: payload.name ?? '', assignmentId: assignment.id }
  };

  const week = { ...S.week };
  for (const d of list(assignment.days)) {
    const ids = [].concat(week[d] || []);
    if (!ids.includes(routine.id)) week[d] = [...ids, routine.id];
  }

  return { ...S, routines: [...routines, routine], customEx: mergedCustomEx, week };
}

/* ---------- an assignment ending (D8, rev 2) ---------- */

/**
 * `assignmentId`/`endedAt`: the matching fields of an entry from GET /api/account/assignments's
 * `ended` list. Returns a new state — `state` is never mutated. Idempotent: an assignment already
 * marked ended, or one never imported in the first place (routine removed, or it was a program
 * recommendation already cleared), returns `state` unchanged.
 *
 * For a `kind: 'routine'` import: the routine stays (it is the student's now, D14's own wording —
 * "a rotina continua com você") but is taken out of every `week[d]` it was in and gains
 * `fromTeacher.endedAt`, so the Plan/History badge can show "encerrada pelo professor" instead of
 * silently dropping it.
 *
 * For a `kind: 'program'` import: the recommendation card is simply withdrawn (`teacherProgram`
 * cleared) — there is nothing else to mark, since a Program recommendation was never copied
 * anywhere.
 */
export function endAssignment(state, assignmentId, endedAt) {
  const S = isObj(state) ? state : {};
  if (!assignmentId) return S;

  // Reached only when S.teacherProgram is truthy (its own assignmentId just matched), so this
  // is always a real change — never a no-op null-to-null. Explicit `null`, not an omitted key
  // (`{ ...rest }` without `teacherProgram`): store/useStore.js merges this return value onto a
  // draft with `Object.assign`, which only ever touches keys actually present on the source
  // object — an omitted key would leave the draft's old `teacherProgram` sitting there
  // untouched, so the recommendation card would never clear.
  if (S.teacherProgram?.assignmentId === assignmentId) return { ...S, teacherProgram: null };

  const routines = list(S.routines);
  const idx = routines.findIndex(r => r?.fromTeacher?.assignmentId === assignmentId);
  if (idx === -1) return S; // never imported — nothing to end
  const routine = routines[idx];
  if (routine.fromTeacher?.endedAt) return S; // already ended

  const nextRoutines = routines.slice();
  nextRoutines[idx] = { ...routine, fromTeacher: { ...routine.fromTeacher, endedAt } };

  const week = { ...S.week };
  for (const d of Object.keys(week)) {
    const ids = [].concat(week[d] || []).filter(id => id !== routine.id);
    if (ids.length) week[d] = ids; else delete week[d];
  }

  return { ...S, routines: nextRoutines, week };
}

/**
 * The whole student-side pull in one pure call: applies every `pending` assignment
 * (`importAssignment`) then every `ended` one (`endAssignment`), in that order — matching
 * GET /api/account/assignments's own two lists. `state` is never mutated. Idempotent as a
 * batch, the same way each half is on its own: reapplying the same `{ pending, ended }` against
 * the result changes nothing, including the case `endAssignment` on its own could get wrong
 * through a naive merge — a `kind: 'program'` entry appearing in both lists at once (assigned
 * and already ended before the student ever pulled) correctly ends up with `teacherProgram`
 * cleared, not re-imported then left stuck, because this always builds the next `state` by
 * replacing it outright rather than merging partial results back onto a draft.
 */
export function applyAssignments(state, { pending, ended } = {}) {
  let S = isObj(state) ? state : {};
  for (const a of list(pending)) S = importAssignment(S, a);
  for (const a of list(ended)) S = endAssignment(S, a.id, a.endedAt);
  return S;
}
