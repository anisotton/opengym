/* ISO-1594/ISO-1609: teacher/student roles, the link between them and workout assignments. Real
 * server.js in a child, same harness as server-admin-programs.test.js — covers the full
 * authorization matrix (plan §4) plus the lifecycle each route is meant to support. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, spawnApi, testPool } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const TEACHER = 't1', TEACHER2 = 't2', STUDENT = 's1', STUDENT2 = 's2', ADMIN = 'admin1';
const asUid = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, Origin: 'http://localhost:8080' });
const anon = () => ({ Origin: 'http://localhost:8080' });

// A pool kept open for the test's whole lifetime (via t.after) races spawnApi's own teardown —
// node:test runs `after` hooks in registration order, so a pool registered after spawnApi's
// returns would still be open when spawnApi's own `t.after(cleanup)` (provisionTestDatabase)
// terminates every backend on the database and drops it, surfacing as a spurious "terminating
// connection due to administrator command" failure. A short-lived pool per call, opened and
// closed within the same statement — same shape as helpers.mjs's own seedUserState — avoids the
// race entirely.
async function sql(databaseUrl, text, params) {
  const pool = testPool(databaseUrl);
  try { return await pool.query(text, params); }
  finally { await pool.end(); }
}

async function startServer(t) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: TEACHER, name: 'Teacher One', created: new Date().toISOString() },
      { id: TEACHER2, name: 'Teacher Two', created: new Date().toISOString() },
      { id: STUDENT, name: 'Student One', created: new Date().toISOString() },
      { id: STUDENT2, name: 'Student Two', created: new Date().toISOString() },
      { id: ADMIN, name: 'Admin', created: new Date().toISOString(), admin: true }
    ]
  }));
  const h = await spawnApi(t, { dataDir });
  await sql(h.databaseUrl, "UPDATE users SET role = 'teacher' WHERE id = ANY($1)", [[TEACHER, TEACHER2]]);
  h.sql = (text, params) => sql(h.databaseUrl, text, params);
  const call = (method, p, { uid, body, headers } = {}) =>
    fetch(`${h.api}${p}`, {
      method, headers: { ...(uid === null ? anon() : asUid(uid || TEACHER)), ...(headers || {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  h.get = (p, opts) => call('GET', p, opts);
  h.post = (p, body, opts) => call('POST', p, { ...opts, body: body ?? {} });
  h.del = (p, opts) => call('DELETE', p, { ...opts, body: {} });
  return h;
}

function sampleRoutine(over = {}) {
  return { name: 'Full body A', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }], ...over };
}

// validateSchedule (teacher.js) only accepts startsOn within 7 days in the past to 60 in the
// future of the real clock — a fixed literal date would drift out of that window as the suite
// ages, exactly like daysAgo() in helpers.mjs.
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Full round trip: new invite, preview, accept. Returns the accept response body.
async function linkStudent(h, { teacher = TEACHER, student = STUDENT, shareBodyweight = false } = {}) {
  const invite = await h.post('/api/teacher/invites/new', {}, { uid: teacher });
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const code = invite.body.invite.code;
  const preview = await h.post('/api/teacher-invite/preview', { code }, { uid: student });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const accept = await h.post('/api/teacher-invite/accept', { code, scopeVersion: preview.body.scopeVersion, shareBodyweight }, { uid: student });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  return accept.body;
}

/* ---------------------------------------------------------------- the gate (matrix rows 1-3) */

const TEACHER_ONLY_ROUTES = [
  { method: 'GET', path: '/api/teacher/students' },
  { method: 'GET', path: `/api/teacher/student?id=${STUDENT}` },
  { method: 'POST', path: '/api/teacher/student/remove', body: { id: STUDENT } },
  { method: 'POST', path: '/api/teacher/student/assign', body: { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0) } },
  { method: 'POST', path: '/api/teacher/student/assignment/end', body: { id: STUDENT } },
  { method: 'GET', path: `/api/teacher/student/notes?id=${STUDENT}` },
  { method: 'POST', path: '/api/teacher/student/notes', body: { id: STUDENT, body: 'x' } },
  { method: 'POST', path: '/api/teacher/student/notes/update', body: { id: STUDENT, noteId: 'x', body: 'x' } },
  { method: 'POST', path: '/api/teacher/student/notes/delete', body: { id: STUDENT, noteId: 'x' } },
  { method: 'GET', path: '/api/teacher/programs' },
  { method: 'GET', path: '/api/teacher/invites' },
  { method: 'POST', path: '/api/teacher/invites/new', body: {} },
  { method: 'POST', path: '/api/teacher/invites/revoke', body: { hash: 'x' } }
];
const STUDENT_SESSION_ROUTES = [
  { method: 'POST', path: '/api/teacher-invite/preview', body: { code: 'NOPE-NOPE-NOPE' } },
  { method: 'POST', path: '/api/teacher-invite/accept', body: { code: 'NOPE-NOPE-NOPE', scopeVersion: 1 } },
  { method: 'GET', path: '/api/account/teacher' },
  { method: 'POST', path: '/api/account/teacher/bodyweight', body: { share: true } },
  { method: 'DELETE', path: '/api/account/teacher' },
  { method: 'GET', path: '/api/account/assignments' },
  { method: 'POST', path: '/api/account/assignments/ack', body: { id: 'x' } }
];

test('every /api/teacher/* and account/teacher* route refuses an anonymous caller with 401', async t => {
  const h = await startServer(t);
  for (const r of [...TEACHER_ONLY_ROUTES, ...STUDENT_SESSION_ROUTES]) {
    const res = r.method === 'POST' ? await h.post(r.path, r.body, { uid: null })
      : r.method === 'DELETE' ? await h.del(r.path, { uid: null })
      : await h.get(r.path, { uid: null });
    assert.equal(res.status, 401, `${r.method} ${r.path}`);
  }
});

test('every /api/teacher/* route (including notes) refuses a plain student with 403', async t => {
  const h = await startServer(t);
  for (const r of TEACHER_ONLY_ROUTES) {
    const res = r.method === 'GET' ? await h.get(r.path, { uid: STUDENT }) : await h.post(r.path, r.body, { uid: STUDENT });
    assert.equal(res.status, 403, `${r.method} ${r.path}`);
  }
});

test('an admin who is not a teacher is refused GET /api/teacher/student (admin never sees training, ISO-1394)', async t => {
  const h = await startServer(t);
  const res = await h.get(`/api/teacher/student?id=${STUDENT}`, { uid: ADMIN });
  assert.equal(res.status, 403);
});

test('a non-admin is refused POST /api/admin/user/role', async t => {
  const h = await startServer(t);
  const res = await h.post('/api/admin/user/role', { id: STUDENT, role: 'teacher' }, { uid: STUDENT });
  assert.equal(res.status, 403);
});

/* ---------------------------------------------------------------- not-your-student (D11) */

test('teacher A is refused on teacher B\'s student: read, assign, end, remove, and both note routes — identical 403 for an unlinked or unknown id', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER2, student: STUDENT });

  const attempts = [
    h.get(`/api/teacher/student?id=${STUDENT}`, { uid: TEACHER }),
    h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0) }, { uid: TEACHER }),
    h.post('/api/teacher/student/assignment/end', { id: STUDENT }, { uid: TEACHER }),
    h.post('/api/teacher/student/remove', { id: STUDENT }, { uid: TEACHER }),
    h.get(`/api/teacher/student/notes?id=${STUDENT}`, { uid: TEACHER }),
    h.post('/api/teacher/student/notes', { id: STUDENT, body: 'x' }, { uid: TEACHER })
  ];
  for (const p of attempts) {
    const res = await p;
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not-your-student');
  }

  // An id that belongs to nobody at all answers exactly the same way.
  const unknown = await h.get('/api/teacher/student?id=does-not-exist', { uid: TEACHER });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.code, 'not-your-student');
});

test('a student who just unlinked is refused on the very next request, including notes', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  await h.post('/api/teacher/student/notes', { id: STUDENT, body: 'before' }, { uid: TEACHER });

  const unlink = await h.del('/api/account/teacher', { uid: STUDENT });
  assert.equal(unlink.status, 200);

  const after = await h.get(`/api/teacher/student?id=${STUDENT}`, { uid: TEACHER });
  assert.equal(after.status, 403);
  const notes = await h.get(`/api/teacher/student/notes?id=${STUDENT}`, { uid: TEACHER });
  assert.equal(notes.status, 403);
});

test('ending the link erases the teacher\'s notes about that student (D13)', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const created = await h.post('/api/teacher/student/notes', { id: STUDENT, body: 'watch the knee' }, { uid: TEACHER });
  assert.equal(created.status, 200);
  await h.del('/api/account/teacher', { uid: STUDENT });

  const { rows } = await h.sql('SELECT count(*)::int AS n FROM teacher_notes WHERE teacher_id = $1 AND student_id = $2', [TEACHER, STUDENT]);
  assert.equal(rows[0].n, 0, 'the row-level proof — not just the 403 above');
});

test('notes/update and notes/delete with a noteId from another pair answer note-not-found', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  await linkStudent(h, { teacher: TEACHER2, student: STUDENT2 });
  const mine = await h.post('/api/teacher/student/notes', { id: STUDENT, body: 'mine' }, { uid: TEACHER });
  const theirs = await h.post('/api/teacher/student/notes', { id: STUDENT2, body: 'theirs' }, { uid: TEACHER2 });

  const updateWrongPair = await h.post('/api/teacher/student/notes/update', { id: STUDENT, noteId: theirs.body.note.id, body: 'x' }, { uid: TEACHER });
  assert.equal(updateWrongPair.status, 404);
  assert.equal(updateWrongPair.body.code, 'note-not-found');

  const deleteWrongPair = await h.post('/api/teacher/student/notes/delete', { id: STUDENT, noteId: theirs.body.note.id }, { uid: TEACHER });
  assert.equal(deleteWrongPair.status, 404);
  assert.equal(deleteWrongPair.body.code, 'note-not-found');

  const stillThere = await h.get(`/api/teacher/student/notes?id=${STUDENT}`, { uid: TEACHER });
  assert.equal(stillThere.body.notes.length, 1, "teacher A's own note is untouched");
});

test('revoking the teacher role denies every /api/teacher/* route at once, with links/notes gone and the assignment closed as role-revoked', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  await h.post('/api/teacher/student/notes', { id: STUDENT, body: 'x' }, { uid: TEACHER });
  await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0) }, { uid: TEACHER });

  const revoke = await h.post('/api/admin/user/role', { id: TEACHER, role: 'student' }, { uid: ADMIN });
  assert.equal(revoke.status, 200);

  const denied = await h.get('/api/teacher/students', { uid: TEACHER });
  assert.equal(denied.status, 403);

  const { rows: links } = await h.sql('SELECT 1 FROM teacher_links WHERE teacher_id = $1', [TEACHER]);
  assert.equal(links.length, 0);
  const { rows: notes } = await h.sql('SELECT 1 FROM teacher_notes WHERE teacher_id = $1', [TEACHER]);
  assert.equal(notes.length, 0);
  const { rows: assignments } = await h.sql(
    "SELECT end_reason FROM teacher_assignments WHERE student_id = $1 AND ended_at IS NOT NULL", [STUDENT]
  );
  assert.equal(assignments[0].end_reason, 'role-revoked');
});

/* ---------------------------------------------------------------- body weight opt-in (D12) */

test('GET /api/teacher/student omits bodyweight when the opt-in is off, includes it when on, and loses it the moment the student turns it off', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT, shareBodyweight: false });

  const off = await h.get(`/api/teacher/student?id=${STUDENT}`, { uid: TEACHER });
  assert.equal('bodyweight' in off.body, false);

  const turnedOn = await h.post('/api/account/teacher/bodyweight', { share: true }, { uid: STUDENT });
  assert.equal(turnedOn.status, 200);
  const on = await h.get(`/api/teacher/student?id=${STUDENT}`, { uid: TEACHER });
  assert.ok(Array.isArray(on.body.bodyweight));

  const turnedOff = await h.post('/api/account/teacher/bodyweight', { share: false }, { uid: STUDENT });
  assert.equal(turnedOff.status, 200);
  const offAgain = await h.get(`/api/teacher/student?id=${STUDENT}`, { uid: TEACHER });
  assert.equal('bodyweight' in offAgain.body, false, 'cut off on the very next request, not cached');
});

test('accepting without shareBodyweight links with the opt-in off by default', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const { rows } = await h.sql('SELECT share_bodyweight FROM teacher_links WHERE student_id = $1', [STUDENT]);
  assert.equal(rows[0].share_bodyweight, false);
});

test('a student with no teacher at all gets not-found from the bodyweight toggle', async t => {
  const h = await startServer(t);
  const res = await h.post('/api/account/teacher/bodyweight', { share: true }, { uid: STUDENT });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'not-found');
});

/* ---------------------------------------------------------------- scheduling & assignment */

test('assigning with days outside 0-6 or startsOn outside the allowed range is 400', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const badDays = await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0), days: [7] }, { uid: TEACHER });
  assert.equal(badDays.status, 400);
  const badDate = await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: '1999-01-01' }, { uid: TEACHER });
  assert.equal(badDate.status, 400);
});

test('ending an assignment with none active answers no-active-assignment', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const res = await h.post('/api/teacher/student/assignment/end', { id: STUDENT }, { uid: TEACHER });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'no-active-assignment');
});

test('assigning a second time replaces the first — both over HTTP and in the student\'s own pull', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const first = await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine({ name: 'A' }), startsOn: dateOffset(0) }, { uid: TEACHER });
  assert.equal(first.status, 200);
  const second = await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine({ name: 'B' }), startsOn: dateOffset(10) }, { uid: TEACHER });
  assert.equal(second.status, 200);
  assert.equal(second.body.assignment.name, 'B');

  const pull = await h.get('/api/account/assignments', { uid: STUDENT });
  assert.equal(pull.body.pending.length, 1);
  assert.equal(pull.body.pending[0].payload.name, 'B');
});

// Two calls through Promise.all alone do not reliably collide at the database (see
// store-teacher.test.js's own comment on exactly this) — a held, uncommitted competing row forces
// the genuine race open on demand, exercised here through the real route rather than store.js
// directly.
test('two assigns racing the same student over HTTP: the loser gets 409 assignment-conflict', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });

  const rawPool = testPool(h.databaseUrl);
  const raw = await rawPool.connect();
  await raw.query('BEGIN');
  await raw.query(
    "INSERT INTO teacher_assignments (id, teacher_id, student_id, kind, payload, starts_on, days) VALUES ($1,$2,$3,'routine',$4,'2026-01-01',NULL)",
    ['held', TEACHER, STUDENT, { name: 'held' }]
  );

  const assignPromise = h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine({ name: 'B' }), startsOn: dateOffset(0) }, { uid: TEACHER });
  await new Promise(r => setTimeout(r, 300));
  await raw.query('COMMIT');
  raw.release();
  await rawPool.end();

  const result = await assignPromise;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'assignment-conflict');
});

/* ---------------------------------------------------------------- invites & accept */

test('a teacher accepting their own invite code gets self-invite', async t => {
  const h = await startServer(t);
  const invite = await h.post('/api/teacher/invites/new', {}, { uid: TEACHER });
  const code = invite.body.invite.code;
  const preview = await h.post('/api/teacher-invite/preview', { code }, { uid: TEACHER });
  const res = await h.post('/api/teacher-invite/accept', { code, scopeVersion: preview.body.scopeVersion }, { uid: TEACHER });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'self-invite');
});

test('a student who already has a teacher accepting a second code gets already-has-teacher, and the second code is not consumed', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const invite2 = await h.post('/api/teacher/invites/new', {}, { uid: TEACHER2 });
  const code2 = invite2.body.invite.code;
  const res = await h.post('/api/teacher-invite/accept', { code: code2, scopeVersion: 1 }, { uid: STUDENT });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'already-has-teacher');
  const stillThere = await h.get('/api/teacher/invites', { uid: TEACHER2 });
  assert.equal(stillThere.body.invites.length, 1, 'the code was not consumed');
});

test('accepting with an outdated scopeVersion is refused before the code is even touched', async t => {
  const h = await startServer(t);
  const invite = await h.post('/api/teacher/invites/new', {}, { uid: TEACHER });
  const code = invite.body.invite.code;
  const res = await h.post('/api/teacher-invite/accept', { code, scopeVersion: 0 }, { uid: STUDENT });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'scope-outdated');
  const stillThere = await h.get('/api/teacher/invites', { uid: TEACHER });
  assert.equal(stillThere.body.invites.length, 1);
});

test('two concurrent accepts of the same code: exactly one links', async t => {
  const h = await startServer(t);
  const invite = await h.post('/api/teacher/invites/new', {}, { uid: TEACHER });
  const code = invite.body.invite.code;
  const preview = await h.post('/api/teacher-invite/preview', { code }, { uid: STUDENT });
  const [a, b] = await Promise.all([
    h.post('/api/teacher-invite/accept', { code, scopeVersion: preview.body.scopeVersion }, { uid: STUDENT }),
    h.post('/api/teacher-invite/accept', { code, scopeVersion: preview.body.scopeVersion }, { uid: STUDENT2 })
  ]);
  const oks = [a, b].filter(r => r.status === 200);
  assert.equal(oks.length, 1, 'exactly one of the two truly-concurrent accepts wins');
});

/* ---------------------------------------------------------------- the student's own pull & ack */

test('ack is scoped to the assignment\'s own student: another student\'s id gets 404', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const assign = await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0) }, { uid: TEACHER });
  const id = (await h.get('/api/account/assignments', { uid: STUDENT })).body.pending[0].id;
  assert.ok(id);

  const wrongOwner = await h.post('/api/account/assignments/ack', { id }, { uid: STUDENT2 });
  assert.equal(wrongOwner.status, 404);

  const ok = await h.post('/api/account/assignments/ack', { id }, { uid: STUDENT });
  assert.equal(ok.status, 200);
  const pullAfter = await h.get('/api/account/assignments', { uid: STUDENT });
  assert.equal(pullAfter.body.pending.length, 0, 'delivered — no longer pending');
});

test('a student who unlinked still receives their last assignment\'s end in the "ended" list, no 403', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  await h.post('/api/teacher/student/assign', { id: STUDENT, kind: 'routine', routine: sampleRoutine(), startsOn: dateOffset(0) }, { uid: TEACHER });
  const id = (await h.get('/api/account/assignments', { uid: STUDENT })).body.pending[0].id;
  await h.post('/api/account/assignments/ack', { id }, { uid: STUDENT }); // delivered

  const unlink = await h.del('/api/account/teacher', { uid: STUDENT });
  assert.equal(unlink.status, 200);

  const pull = await h.get('/api/account/assignments', { uid: STUDENT });
  assert.equal(pull.status, 200);
  assert.equal(pull.body.ended.length, 1);
  assert.equal(pull.body.ended[0].id, id);
});

/* ---------------------------------------------------------------- regression: PUT /api/data stays scoped */

test('PUT /api/data still only ever writes the caller\'s own state, teacher or not', async t => {
  const h = await startServer(t);
  await linkStudent(h, { teacher: TEACHER, student: STUDENT });
  const put = await h.post('/api/data', { state: { routines: [], workouts: [] } }, { uid: TEACHER, headers: {} });
  // PUT, not POST — build the request by hand since the harness only has get/post/del.
  const res = await fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: { ...asUid(TEACHER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { routines: [], workouts: [], note: 'teacher-own' } })
  });
  assert.equal(res.status, 200);
  const { rows } = await h.sql('SELECT state FROM user_state WHERE user_id = $1', [STUDENT]);
  assert.equal(rows.length, 0, 'the student\'s own state was never touched by the teacher\'s write');
});

/* ---------------------------------------------------------------- GET /api/me carries role */

test('GET /api/me reports role for both a teacher and a student', async t => {
  const h = await startServer(t);
  const teacherMe = await h.get('/api/me', { uid: TEACHER });
  assert.equal(teacherMe.body.user.role, 'teacher');
  const studentMe = await h.get('/api/me', { uid: STUDENT });
  assert.equal(studentMe.body.user.role, 'student');
});
