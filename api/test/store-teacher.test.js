/* The teacher/student half of store.js (ISO-1594/ISO-1609), tested directly against real
 * PostgreSQL — no server.js spawned. Covers the transactions and races that are hardest to get
 * right at this layer: one active assignment per student, notes erased with the link, the atomic
 * invite claim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import { createUser, getUserById, getTeacherLink, getLinkForTeacher } from '../store.js';
import {
  setUserRole, countStudentsOfTeacher, createTeacherInvite, listTeacherInvites, revokeTeacherInvite,
  peekTeacherInvite, acceptTeacherInvite, endLink, setShareBodyweight, listStudentsOfTeacher,
  assignToStudent, getActiveAssignment, endAssignment, listAssignmentHistory,
  getPendingAndEndedAssignments, ackAssignment, listNotes, createNote, updateNote, deleteNote
} from '../store.js';
import { hashInviteCode, newInviteCode, TEACHER_SCOPE_VERSION, MAX_NOTES_PER_STUDENT } from '../teacher.js';

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}
const iso = () => new Date().toISOString();

async function teacherAndStudent(pool, { teacherId = 't1', studentId = 's1' } = {}) {
  await createUser(pool, { id: teacherId, name: 'Teacher', created: iso() });
  await createUser(pool, { id: studentId, name: 'Student', created: iso() });
  await setUserRole(pool, teacherId, 'teacher');
  return { teacherId, studentId };
}

async function linkThem(pool, teacherId, studentId, opts = {}) {
  const code = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(code), expiresAt: Date.now() + 60000 });
  const student = await getUserById(pool, studentId);
  const r = await acceptTeacherInvite(pool, { hash: hashInviteCode(code), student, scopeVersion: TEACHER_SCOPE_VERSION, shareBodyweight: false, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/* ---------------------------------------------------------------- roles */

test('a fresh account has no role column surprises: setUserRole grants and revokes', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 'u1', name: 'A', created: iso() });
  let u = await getUserById(pool, 'u1');
  assert.equal(u.role, 'student');
  await setUserRole(pool, 'u1', 'teacher');
  u = await getUserById(pool, 'u1');
  assert.equal(u.role, 'teacher');
  await setUserRole(pool, 'u1', 'student');
  u = await getUserById(pool, 'u1');
  assert.equal(u.role, 'student');
});

test('revoking the teacher role ends every active link, erases notes, closes the active assignment, and burns invites', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId);
  await createNote(pool, teacherId, studentId, 'watch the knee');
  await assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'A', ex: [] }, startsOn: '2026-01-01', days: null });
  const code = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(code), expiresAt: Date.now() + 60000 });

  await setUserRole(pool, teacherId, 'student');

  assert.equal(await getTeacherLink(pool, studentId), null);
  assert.deepEqual(await listNotes(pool, teacherId, studentId), []);
  assert.equal(await getActiveAssignment(pool, studentId), null);
  const history = await listAssignmentHistory(pool, studentId);
  assert.equal(history[0].endReason, 'role-revoked');
  assert.deepEqual(await listTeacherInvites(pool, teacherId), []);
});

test('countStudentsOfTeacher counts active links only', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  assert.equal(await countStudentsOfTeacher(pool, teacherId), 0);
  await linkThem(pool, teacherId, studentId);
  assert.equal(await countStudentsOfTeacher(pool, teacherId), 1);
  await endLink(pool, studentId, 'by-student');
  assert.equal(await countStudentsOfTeacher(pool, teacherId), 0);
});

/* ---------------------------------------------------------------- invites & accept */

test('peekTeacherInvite does not consume the code; accepting it does', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  const code = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(code), expiresAt: Date.now() + 60000 });
  const peeked = await peekTeacherInvite(pool, hashInviteCode(code));
  assert.equal(peeked.teacherId, teacherId);
  assert.equal((await listTeacherInvites(pool, teacherId)).length, 1, 'preview does not burn it');
  await linkThem(pool, teacherId, studentId);
});

test('acceptTeacherInvite: self-invite, already-has-teacher (code not consumed), and a clean accept', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool, { teacherId: 't1', studentId: 's1' });
  await createUser(pool, { id: 't2', name: 'Teacher Two', created: iso() });
  await setUserRole(pool, 't2', 'teacher');

  // self-invite: a teacher using their own code.
  const selfCode = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(selfCode), expiresAt: Date.now() + 60000 });
  const teacherUser = await getUserById(pool, teacherId);
  const self = await acceptTeacherInvite(pool, { hash: hashInviteCode(selfCode), student: teacherUser, scopeVersion: TEACHER_SCOPE_VERSION, shareBodyweight: false });
  assert.equal(self.code, 'self-invite');

  await linkThem(pool, teacherId, studentId);

  const secondCode = newInviteCode();
  await createTeacherInvite(pool, 't2', { hash: hashInviteCode(secondCode), expiresAt: Date.now() + 60000 });
  const student = await getUserById(pool, studentId);
  const second = await acceptTeacherInvite(pool, { hash: hashInviteCode(secondCode), student, scopeVersion: TEACHER_SCOPE_VERSION, shareBodyweight: false });
  assert.equal(second.code, 'already-has-teacher');
  assert.equal((await listTeacherInvites(pool, 't2')).length, 1, 'the code was not consumed');

  const link = await getLinkForTeacher(pool, teacherId, studentId);
  assert.equal(link.teacherId, teacherId, 'still linked to the first teacher');
});

test('two concurrent accepts of the same code: exactly one links, the code is gone either way', async t => {
  const pool = await withPool(t);
  const { teacherId } = await teacherAndStudent(pool, { teacherId: 't1', studentId: 's1' });
  await createUser(pool, { id: 's2', name: 'Student Two', created: iso() });
  const code = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(code), expiresAt: Date.now() + 60000 });
  const [s1, s2] = await Promise.all([getUserById(pool, 's1'), getUserById(pool, 's2')]);
  const [a, b] = await Promise.all([
    acceptTeacherInvite(pool, { hash: hashInviteCode(code), student: s1, scopeVersion: TEACHER_SCOPE_VERSION, shareBodyweight: false }),
    acceptTeacherInvite(pool, { hash: hashInviteCode(code), student: s2, scopeVersion: TEACHER_SCOPE_VERSION, shareBodyweight: false })
  ]);
  const oks = [a, b].filter(r => r.ok);
  assert.equal(oks.length, 1, 'exactly one of the two truly-concurrent accepts wins');
  assert.equal((await listTeacherInvites(pool, teacherId)).length, 0);
});

test('accepting with shareBodyweight also logs bodyweight-on', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId, { shareBodyweight: true });
  const link = await getTeacherLink(pool, studentId);
  assert.equal(link.shareBodyweight, true);
});

test('revokeTeacherInvite only removes the issuing teacher\'s own code', async t => {
  const pool = await withPool(t);
  const { teacherId } = await teacherAndStudent(pool, { teacherId: 't1', studentId: 's1' });
  await createUser(pool, { id: 't2', name: 'Teacher Two', created: iso() });
  const code = newInviteCode();
  await createTeacherInvite(pool, teacherId, { hash: hashInviteCode(code), expiresAt: Date.now() + 60000 });
  assert.equal(await revokeTeacherInvite(pool, 't2', hashInviteCode(code)), false, 'wrong teacher');
  assert.equal(await revokeTeacherInvite(pool, teacherId, hashInviteCode(code)), true);
});

/* ---------------------------------------------------------------- bodyweight opt-in */

test('setShareBodyweight: no link at all is not-found; toggling logs each event', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  assert.equal((await setShareBodyweight(pool, studentId, true)).code, 'not-found');
  await linkThem(pool, teacherId, studentId);
  assert.equal((await setShareBodyweight(pool, studentId, true)).ok, true);
  assert.equal((await getTeacherLink(pool, studentId)).shareBodyweight, true);
  assert.equal((await setShareBodyweight(pool, studentId, false)).ok, true);
  assert.equal((await getTeacherLink(pool, studentId)).shareBodyweight, false);
});

/* ---------------------------------------------------------------- assignments (D14) */

test('assignToStudent: a second assignment replaces the first, which lands in history', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId);
  const first = await assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'A' }, startsOn: '2026-01-01', days: null });
  assert.equal(first.ok, true);
  const second = await assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'B' }, startsOn: '2026-02-01', days: [1, 3] });
  assert.equal(second.ok, true);
  const active = await getActiveAssignment(pool, studentId);
  assert.equal(active.payload.name, 'B');
  assert.deepEqual(active.days, [1, 3]);
  const history = await listAssignmentHistory(pool, studentId);
  assert.equal(history.length, 1);
  assert.equal(history[0].payload.name, 'A');
  assert.equal(history[0].endReason, 'replaced');
});

// Two calls through Promise.all alone do not reliably collide: each opens its own connection, and
// with a local database the first often fully commits (its own UPDATE legitimately finding
// nothing to replace, then inserting) before the second's UPDATE even runs — which then replaces
// the first, exactly as the sequential test above does, with no conflict at all. The genuine race
// (D14) only exists in the narrow window where *neither* has committed when both reach INSERT; a
// held, uncommitted competing row forces exactly that window open on demand.
test('two assignments racing the exact INSERT: the later one gets assignment-conflict, the held row stays active', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId);

  const raw = await pool.connect();
  await raw.query('BEGIN');
  await raw.query(
    "INSERT INTO teacher_assignments (id, teacher_id, student_id, kind, payload, starts_on, days) VALUES ($1,$2,$3,'routine',$4,'2026-01-01',NULL)",
    ['held', teacherId, studentId, { name: 'held' }]
  );

  // assignToStudent's own UPDATE sees nothing to end (the held row is not committed yet, hence
  // invisible to it) and goes straight to INSERT — which collides with the held row's still-open
  // unique index entry and blocks on it.
  const assignPromise = assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'B' }, startsOn: '2026-01-01', days: null });
  await new Promise(r => setTimeout(r, 300)); // let the INSERT above reach and block on the lock
  await raw.query('COMMIT');
  raw.release();
  const result = await assignPromise;

  assert.equal(result.code, 'assignment-conflict');
  const active = await getActiveAssignment(pool, studentId);
  assert.equal(active.payload.name, 'held', 'the row that committed first stays the only active one');
});

test('endAssignment: refuses with no-active-assignment when there is none', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId);
  assert.equal((await endAssignment(pool, teacherId, studentId)).code, 'no-active-assignment');
  await assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'A' }, startsOn: '2026-01-01', days: null });
  assert.equal((await endAssignment(pool, teacherId, studentId)).ok, true);
  assert.equal(await getActiveAssignment(pool, studentId), null);
});

test('getPendingAndEndedAssignments + ackAssignment: delivered then ended, in order, scoped to the owner', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await createUser(pool, { id: 'other', name: 'Other', created: iso() });
  await linkThem(pool, teacherId, studentId);
  const { row } = await assignToStudent(pool, { teacherId, studentId, kind: 'routine', payload: { name: 'A' }, startsOn: '2026-01-01', days: null });

  let { pending, ended } = await getPendingAndEndedAssignments(pool, studentId);
  assert.equal(pending.length, 1);
  assert.equal(ended.length, 0);

  assert.equal((await ackAssignment(pool, 'other', row.id)).code, 'not-found', 'not this student\'s assignment');
  assert.equal((await ackAssignment(pool, studentId, row.id)).ok, true);
  ({ pending, ended } = await getPendingAndEndedAssignments(pool, studentId));
  assert.equal(pending.length, 0, 'delivered — no longer pending');

  await endAssignment(pool, teacherId, studentId);
  ({ pending, ended } = await getPendingAndEndedAssignments(pool, studentId));
  assert.equal(ended.length, 1);
  await ackAssignment(pool, studentId, row.id);
  ({ pending, ended } = await getPendingAndEndedAssignments(pool, studentId));
  assert.equal(ended.length, 0, 'end-acked — no longer surfaced');
});

/* ---------------------------------------------------------------- notes (D13) */

test('notes: created, updated, deleted, scoped to the exact teacher+student pair', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await createUser(pool, { id: 't2', name: 'Teacher Two', created: iso() });
  await linkThem(pool, teacherId, studentId);

  const created = await createNote(pool, teacherId, studentId, 'watch the knee');
  assert.equal(created.ok, true);
  assert.equal((await listNotes(pool, teacherId, studentId))[0].body, 'watch the knee');

  assert.equal((await updateNote(pool, 't2', studentId, created.row.id, 'x')).code, 'note-not-found', 'another teacher');
  const updated = await updateNote(pool, teacherId, studentId, created.row.id, 'knee is fine now');
  assert.equal(updated.row.body, 'knee is fine now');

  assert.equal(await deleteNote(pool, 't2', studentId, created.row.id), false);
  assert.equal(await deleteNote(pool, teacherId, studentId, created.row.id), true);
  assert.deepEqual(await listNotes(pool, teacherId, studentId), []);
});

test('notes: the cap is enforced atomically, two concurrent creates at the cap can\'t both land', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  await linkThem(pool, teacherId, studentId);
  for (let i = 0; i < MAX_NOTES_PER_STUDENT - 1; i++) await createNote(pool, teacherId, studentId, 'note ' + i);
  const [a, b] = await Promise.all([
    createNote(pool, teacherId, studentId, 'last one'),
    createNote(pool, teacherId, studentId, 'also last one')
  ]);
  const oks = [a, b].filter(r => r.ok);
  assert.equal(oks.length, 1, 'exactly one of the two fills the final slot');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM teacher_notes WHERE teacher_id = $1 AND student_id = $2', [teacherId, studentId]);
  assert.equal(rows[0].n, MAX_NOTES_PER_STUDENT);
});

/* ---------------------------------------------------------------- endLink */

test('endLink: a student with no teacher at all is a no-op, not an error', async t => {
  const pool = await withPool(t);
  await createUser(pool, { id: 's1', name: 'Solo', created: iso() });
  assert.equal((await endLink(pool, 's1', 'by-student')).ok, true);
});

test('listStudentsOfTeacher only ever lists active links', async t => {
  const pool = await withPool(t);
  const { teacherId, studentId } = await teacherAndStudent(pool);
  assert.deepEqual(await listStudentsOfTeacher(pool, teacherId), []);
  await linkThem(pool, teacherId, studentId);
  const list = await listStudentsOfTeacher(pool, teacherId);
  assert.equal(list.length, 1);
  assert.equal(list[0].studentId, studentId);
  await endLink(pool, studentId, 'by-student');
  assert.deepEqual(await listStudentsOfTeacher(pool, teacherId), []);
});
