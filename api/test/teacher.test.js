/* Pure rules for teacher/student roles (ISO-1594/ISO-1609) — no PostgreSQL, no server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRole, teacherView, acceptProblem, validateRoutineAssignment, validateSchedule,
  validateNote, studentSummary, newInviteCode, hashInviteCode, IDLE_DAYS
} from '../teacher.js';

test('normalizeRole accepts only the two known roles', () => {
  assert.equal(normalizeRole('teacher'), 'teacher');
  assert.equal(normalizeRole('student'), 'student');
  assert.equal(normalizeRole('admin'), null);
  assert.equal(normalizeRole(undefined), null);
});

test('newInviteCode/hashInviteCode: stable hash, dashes/case/spacing ignored', () => {
  const code = newInviteCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(hashInviteCode(code), hashInviteCode(code.toLowerCase()));
  assert.equal(hashInviteCode(code), hashInviteCode(' ' + code.replace(/-/g, ' ') + ' '));
  assert.notEqual(hashInviteCode(code), hashInviteCode(newInviteCode()));
});

/* ---------------------------------------------------------------- teacherView */

const FULL_STATE = {
  unit: 'kg',
  email: 'student@example.com',
  birthDate: '2000-01-01',
  exNotes: { '0001': 'knee feels off' },
  coach: { consent: { agreedAt: '2026-01-01' } },
  settings: { theme: 'dark' },
  bodyweight: [{ d: '2026-10-01', w: 80 }],
  customEx: [
    { id: 'c1', name: 'Belt squat', muscle: 'legs', media: { hash: 'deadbeef' } },
    { id: 'c2', name: 'Unused one', muscle: 'legs' }
  ],
  routines: [{
    id: 'r1', name: 'Full body A', emoji: '💪', prog: 'linear',
    fromTeacher: { teacherId: 't1', assignmentId: 'a1' },
    ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20 }, { id: 'c1', sets: 2, reps: 8, mode: 'reps' }]
  }],
  workouts: [{
    id: 'w1', d: '2026-10-05', start: 1000, end: 2000, name: 'Full body A',
    bw: 81.2, note: 'felt great today', routineIds: ['r1'],
    media: [{ hash: 'cafebabe' }],
    entries: [{ id: '0001', sets: [{ w: 20, r: 10, done: true }], note: 'pin 7', target: { sets: 3, reps: 10 } }]
  }]
};

test('teacherView with the bodyweight flag off: nothing sensitive leaks, customEx is filtered to what is used', () => {
  const v = teacherView(FULL_STATE, { bodyweight: false });
  assert.equal(v.unit, 'kg');
  assert.equal('bodyweight' in v, false);
  assert.equal('exNotes' in v, false);
  assert.equal('coach' in v, false);
  assert.equal('settings' in v, false);
  assert.equal('email' in v, false);
  assert.equal('birthDate' in v, false);
  assert.deepEqual(v.customEx.map(c => c.id), ['c1'], 'c2 is never referenced by a workout or routine');
  assert.equal('media' in v.customEx[0], false);
  assert.equal('media' in v.workouts[0], false);
  assert.equal('bw' in v.workouts[0], false, 'body weight stays out of the workout even unflagged');
  assert.equal('note' in v.workouts[0], false, 'a personal session note is not training data the teacher needs');
  assert.equal('note' in v.workouts[0].entries[0], false);
  assert.equal(v.routines[0].fromTeacher.assignmentId, 'a1', 'fromTeacher survives — adherence depends on it');
});

test('teacherView with the bodyweight flag on: only bodyweight appears, everything else stays out', () => {
  const v = teacherView(FULL_STATE, { bodyweight: true });
  assert.deepEqual(v.bodyweight, [{ d: '2026-10-01', w: 80 }]);
  assert.equal('exNotes' in v, false);
  assert.equal('coach' in v, false);
  assert.equal('bw' in v.workouts[0], false, 'the per-workout snapshot is still not the same thing as the opted-in log');
});

test('teacherView on an empty/garbage state does not throw', () => {
  assert.deepEqual(teacherView(null), { unit: 'kg', workouts: [], routines: [], customEx: [] });
  assert.deepEqual(teacherView({ workouts: 'nope', routines: null }), { unit: 'kg', workouts: [], routines: [], customEx: [] });
});

/* ---------------------------------------------------------------- acceptProblem */

test('acceptProblem: every refusal code', () => {
  const student = { id: 's1' };
  assert.equal(acceptProblem({ invite: null, student }), 'invite-invalid');
  assert.equal(acceptProblem({ invite: { teacherId: 't1', expiresAt: 100 }, student, now: 200 }), 'invite-expired');
  assert.equal(acceptProblem({ invite: { teacherId: 's1', expiresAt: 200 }, student, now: 100 }), 'self-invite');
  assert.equal(acceptProblem({ invite: { teacherId: 't1', expiresAt: 200 }, student, now: 100, existingLink: { teacherId: 't2' } }), 'already-has-teacher');
  assert.equal(acceptProblem({ invite: { teacherId: 't1', expiresAt: 200 }, student, now: 100 }), null);
});

/* ---------------------------------------------------------------- validateRoutineAssignment */

test('validateRoutineAssignment: a full valid routine, built-in exercise', () => {
  const r = validateRoutineAssignment({ name: '  Full  Body  A ', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: 'Full Body A', ex: [{ id: '0001', sets: 3, mode: 'reps', reps: 10, weight: 20 }] });
});

test('validateRoutineAssignment: an embedded custom exercise is accepted by id, a non-embedded one is not', () => {
  const ok = validateRoutineAssignment({ name: 'X', ex: [{ id: 'custom1', sets: 3, reps: 10 }], customEx: [{ id: 'custom1', name: 'Belt squat' }] });
  assert.equal(ok.ok, true);
  const bad = validateRoutineAssignment({ name: 'X', ex: [{ id: 'custom1', sets: 3, reps: 10 }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'ex');
});

test('validateRoutineAssignment: name, exercise count and numeric bounds', () => {
  assert.equal(validateRoutineAssignment({ name: '', ex: [{ id: '0001', sets: 1, reps: 1 }] }).field, 'name');
  assert.equal(validateRoutineAssignment({ name: 'x'.repeat(121), ex: [{ id: '0001', sets: 1, reps: 1 }] }).field, 'name');
  assert.equal(validateRoutineAssignment({ name: 'X', ex: [] }).field, 'ex');
  assert.equal(validateRoutineAssignment({ name: 'X', ex: Array.from({ length: 41 }, () => ({ id: '0001', sets: 1, reps: 1 })) }).field, 'ex');
  assert.equal(validateRoutineAssignment({ name: 'X', ex: [{ id: '0001', sets: 0, reps: 1 }] }).field, 'ex');
  assert.equal(validateRoutineAssignment({ name: 'X', ex: [{ id: '0001', sets: 1, reps: 1, weight: -1 }] }).field, 'ex');
  assert.equal(validateRoutineAssignment({ name: 'X', ex: [{ id: '0001', sets: 1, sec: 30 }] }).ok, true, 'a timed exercise needs sec, not reps');
});

/* ---------------------------------------------------------------- validateSchedule */

test('validateSchedule: startsOn bounds and days normalization', () => {
  const now = new Date('2026-06-15T12:00:00');
  assert.equal(validateSchedule({ startsOn: '2026-06-10' }, now).ok, true, 'within 7 days in the past');
  assert.equal(validateSchedule({ startsOn: '2026-06-01' }, now).field, 'startsOn', 'too far in the past');
  assert.equal(validateSchedule({ startsOn: '2026-08-14' }, now).ok, true, 'within 60 days in the future');
  assert.equal(validateSchedule({ startsOn: '2026-08-20' }, now).field, 'startsOn', 'too far in the future');
  assert.equal(validateSchedule({ startsOn: 'nope' }, now).field, 'startsOn');
  const r = validateSchedule({ startsOn: '2026-06-15', days: [3, 1, 5] }, now);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.days, [1, 3, 5], 'sorted');
  assert.equal(validateSchedule({ startsOn: '2026-06-15', days: [1, 1] }, now).field, 'days', 'duplicates are refused, not silently deduped');
  assert.equal(validateSchedule({ startsOn: '2026-06-15', days: [7] }, now).field, 'days');
  assert.equal(validateSchedule({ startsOn: '2026-06-15', days: [] }, now).field, 'days');
  assert.deepEqual(validateSchedule({ startsOn: '2026-06-15' }, now).value.days, null);
});

/* ---------------------------------------------------------------- validateNote */

test('validateNote: trims, refuses empty and over-length', () => {
  assert.deepEqual(validateNote('  hello  '), { ok: true, value: 'hello' });
  assert.equal(validateNote('   ').code, 'note-empty');
  assert.equal(validateNote('x'.repeat(4001)).code, 'note-too-long');
  assert.equal(validateNote('x'.repeat(4000)).ok, true);
});

/* ---------------------------------------------------------------- studentSummary */

function view(workouts) { return { routines: [{ id: 'r1', fromTeacher: { assignmentId: 'a1' } }], workouts }; }
const assignment = (over = {}) => ({ id: 'a1', kind: 'routine', startsOn: '2026-06-01', days: [1, 3, 5], endedAt: null, ...over });

test('studentSummary: no workout at all — idle counts from acceptedAt', () => {
  const now = new Date('2026-06-15T12:00:00');
  const s = studentSummary(view([]), null, now, { acceptedAt: '2026-06-08T12:00:00' });
  assert.equal(s.lastWorkoutAt, null);
  assert.equal(s.workoutsThisWeek, 0);
  assert.equal(s.idleDays, 7);
  assert.equal(s.idle, true, 'idle at exactly IDLE_DAYS');
  assert.equal(s.adherence, null, 'no assignment at all');
});

test('studentSummary: idle is false just under IDLE_DAYS', () => {
  const now = new Date('2026-06-15T12:00:00');
  const s = studentSummary(view([{ d: '2026-06-09' }]), null, now);
  assert.equal(s.idleDays, 6);
  assert.equal(s.idle, false);
});

test('studentSummary: a workout for another routine does not count toward adherence', () => {
  const now = new Date('2026-06-08T12:00:00'); // Monday
  const w = [{ d: '2026-06-03', routineIds: ['other'] }]; // Wednesday, wrong routine
  const s = studentSummary(view(w), assignment(), now);
  assert.equal(s.adherence.done, 0);
});

test('studentSummary: two workouts the same day count once; adherence ratio is capped and the window respects ended_at', () => {
  const now = new Date('2026-06-08T12:00:00'); // Monday
  const w = [
    { d: '2026-06-03', routineIds: ['r1'] }, { d: '2026-06-03', routineIds: ['r1'] }, // Wed, twice
    { d: '2026-06-05', routineIds: ['r1'] } // Fri
  ];
  const s = studentSummary(view(w), assignment(), now);
  assert.equal(s.adherence.done, 2, 'same-day duplicate counts once');
  assert.ok(s.adherence.expected >= 2);
  assert.ok(s.adherence.ratio <= 1);
});

test('studentSummary: adherence is null without an active assignment, for a program, or with no days', () => {
  const now = new Date('2026-06-08T12:00:00');
  assert.equal(studentSummary(view([]), null, now).adherence, null);
  assert.equal(studentSummary(view([]), assignment({ kind: 'program' }), now).adherence, null);
  assert.equal(studentSummary(view([]), assignment({ days: null }), now).adherence, null);
});

test('studentSummary: a future startsOn has nothing elapsed yet (expected 0 -> null)', () => {
  const now = new Date('2026-06-01T12:00:00');
  const s = studentSummary(view([]), assignment({ startsOn: '2026-07-01' }), now);
  assert.equal(s.adherence, null);
});

test('studentSummary: an ended assignment closes the adherence window at ended_at', () => {
  const now = new Date('2026-06-20T12:00:00');
  const w = [{ d: '2026-06-03', routineIds: ['r1'] }, { d: '2026-06-17', routineIds: ['r1'] }]; // after the end
  const s = studentSummary(view(w), assignment({ endedAt: '2026-06-10T00:00:00Z' }), now);
  assert.equal(s.adherence.done, 1, 'the workout logged after ended_at falls outside the window');
});

test('studentSummary: workoutsThisWeek respects the Monday-Sunday boundary, including a Sunday "now"', () => {
  const sunday = new Date('2026-06-14T12:00:00'); // Sunday
  const w = [{ d: '2026-06-08' }, { d: '2026-06-14' }, { d: '2026-06-07' }]; // Mon, Sun (this week), Sun (last week)
  const s = studentSummary(view(w), null, sunday);
  assert.equal(s.workoutsThisWeek, 2);
  assert.equal(IDLE_DAYS, 7);
});
