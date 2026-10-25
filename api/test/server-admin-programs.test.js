/* ISO-1485: the admin-only training program catalog. Real server.js in a child, same harness as
   server-admin-delete.test.js. Covers the gate (every route refuses a non-admin), the lifecycle
   (create/update/publish/trash/restore/purge), the two concurrency rules (rev CAS, unique title)
   and the cover image route (magic-number validation, alt text, removal). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ADMIN = 'u_adm_1', ADMIN2 = 'u_adm_2', VICTIM = 'u_vic_1';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, Origin: 'http://localhost:8080' });

async function startServer(t) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Adminna', created: new Date().toISOString(), admin: true },
      { id: ADMIN2, name: 'Second', created: new Date().toISOString(), admin: true },
      { id: VICTIM, name: 'Mallory', created: new Date().toISOString() }
    ]
  }));
  const h = await spawnApi(t, { dataDir });
  const call = (method, path, { uid = ADMIN, body } = {}) =>
    fetch(`${h.api}${path}`, {
      method, headers: { ...as(uid), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  h.get = (path, opts) => call('GET', path, opts);
  h.post = (path, body, opts) => call('POST', path, { ...opts, body: body ?? {} });
  h.newProgram = async (over = {}, opts) => {
    const r = await h.post('/api/admin/programs/new', {
      title: 'Full Body Starter', category: 'general', difficulty: 'beginner', sessionMinutes: 45, ...over
    }, opts);
    return r;
  };
  return h;
}

/* ---------------------------------------------------------------- the gate */

// Every route the plan's §7 checklist asks for, each with a body/query shape that passes the
// basic "is this well-formed" checks so a bug that let a non-admin through would be caught by a
// genuine 200 rather than an incidental 400 for some other reason.
const ROUTES = [
  { method: 'GET', path: '/api/admin/programs' },
  { method: 'GET', path: '/api/admin/programs/meta' },
  { method: 'GET', path: '/api/admin/program?id=x' },
  { method: 'POST', path: '/api/admin/programs/new', body: { title: 'x', category: 'general', difficulty: 'beginner', sessionMinutes: 30 } },
  { method: 'POST', path: '/api/admin/program/update', body: { id: 'x', rev: 1, title: 'y' } },
  { method: 'POST', path: '/api/admin/program/trash', body: { id: 'x', rev: 1 } },
  { method: 'POST', path: '/api/admin/program/restore', body: { id: 'x' } },
  { method: 'POST', path: '/api/admin/program/purge', body: { id: 'x', confirmTitle: 'y' } },
  { method: 'PUT', path: '/api/admin/program/cover?id=x&rev=1&w=640&h=360&alt=a+sunlit+gym' },
  { method: 'POST', path: '/api/admin/program/cover/remove', body: { id: 'x', rev: 1 } },
  { method: 'GET', path: '/api/admin/program/cover?id=x' }
];

test('every program route refuses a signed-in non-admin with 403', async t => {
  const h = await startServer(t);
  for (const r of ROUTES) {
    const res = await fetch(`${h.api}${r.path}`, {
      method: r.method, headers: { ...as(VICTIM), 'Content-Type': 'application/json' },
      body: r.body ? JSON.stringify(r.body) : (r.method === 'PUT' ? Buffer.from([1, 2, 3]) : undefined)
    });
    assert.equal(res.status, 403, `${r.method} ${r.path} should refuse a non-admin`);
  }
});

test('every program route refuses an anonymous caller', async t => {
  const h = await startServer(t);
  for (const r of ROUTES) {
    const res = await fetch(`${h.api}${r.path}`, {
      method: r.method, headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json' },
      body: r.body ? JSON.stringify(r.body) : (r.method === 'PUT' ? Buffer.from([1, 2, 3]) : undefined)
    });
    assert.equal(res.status, 401, `${r.method} ${r.path} should refuse an anonymous caller`);
  }
});

/* ---------------------------------------------------------------- lifecycle */

test('an admin creates a program and it appears in the list', async t => {
  const h = await startServer(t);
  const created = await h.newProgram();
  assert.equal(created.status, 200);
  assert.equal(created.body.program.title, 'Full Body Starter');
  assert.equal(created.body.program.status, 'draft');
  assert.equal(created.body.program.rev, 1);

  const list = await h.get('/api/admin/programs');
  assert.equal(list.status, 200);
  assert.equal(list.body.programs.length, 1);
  assert.equal(list.body.programs[0].id, created.body.program.id);
});

test('a second admin can edit a program the first one created', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram({}, { uid: ADMIN });
  const edited = await h.post('/api/admin/program/update', { id: program.id, rev: program.rev, title: 'Full Body Starter v2' }, { uid: ADMIN2 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.program.title, 'Full Body Starter v2');
  assert.equal(edited.body.program.updatedBy, ADMIN2);
});

test('publishing is logged distinctly from an ordinary edit', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram();
  const published = await h.post('/api/admin/program/update', { id: program.id, rev: program.rev, status: 'published' });
  assert.equal(published.status, 200);
  assert.equal(published.body.program.status, 'published');
  assert.ok(published.body.program.publishedAt);

  const detail = await h.get('/api/admin/program?id=' + program.id);
  const actions = detail.body.history.map(e => e.action);
  assert.deepEqual(actions, ['publish', 'create']);
});

test('a stale rev is refused without overwriting the concurrent edit', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram();
  const first = await h.post('/api/admin/program/update', { id: program.id, rev: program.rev, title: 'Renamed once' });
  assert.equal(first.status, 200);

  const stale = await h.post('/api/admin/program/update', { id: program.id, rev: program.rev, title: 'Renamed twice' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');

  const current = await h.get('/api/admin/program?id=' + program.id);
  assert.equal(current.body.program.title, 'Renamed once', 'the first writer’s change survives');
});

test('two programs cannot share a title (case-insensitive)', async t => {
  const h = await startServer(t);
  await h.newProgram({ title: 'Push Pull Legs' });
  const dupe = await h.newProgram({ title: 'push pull legs' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, 'title-taken');
});

test('validation failures report the offending field', async t => {
  const h = await startServer(t);
  const bad = await h.newProgram({ sessionMinutes: 0 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'sessionMinutes');
});

test('trash, restore and the read-only trash state', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram();

  const trashed = await h.post('/api/admin/program/trash', { id: program.id, rev: program.rev });
  assert.equal(trashed.status, 200);
  assert.ok(trashed.body.program.deletedAt);

  const activeList = await h.get('/api/admin/programs');
  assert.equal(activeList.body.programs.length, 0, 'gone from the active catalog');
  assert.equal(activeList.body.trashCount, 1);

  const editInTrash = await h.post('/api/admin/program/update', { id: program.id, rev: trashed.body.program.rev, title: 'nope' });
  assert.equal(editInTrash.status, 409);
  assert.equal(editInTrash.body.code, 'in-trash');

  const restored = await h.post('/api/admin/program/restore', { id: program.id });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.program.status, 'draft', 'always comes back as a draft');
  assert.equal(restored.body.program.deletedAt, undefined);
});

test('purge only works from the trash, and only with the title typed back exactly', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram({ title: 'Delete me' });

  const tooSoon = await h.post('/api/admin/program/purge', { id: program.id, confirmTitle: 'Delete me' });
  assert.equal(tooSoon.status, 409);
  assert.equal(tooSoon.body.code, 'not-in-trash');

  await h.post('/api/admin/program/trash', { id: program.id, rev: program.rev });

  const wrongTitle = await h.post('/api/admin/program/purge', { id: program.id, confirmTitle: 'wrong' });
  assert.equal(wrongTitle.status, 400);
  assert.equal(wrongTitle.body.code, 'confirm-mismatch');

  const purged = await h.post('/api/admin/program/purge', { id: program.id, confirmTitle: 'Delete me' });
  assert.equal(purged.status, 200);

  const gone = await h.get('/api/admin/program?id=' + program.id);
  assert.equal(gone.status, 404);
});

/* ---------------------------------------------------------------- cover image */

// A real (tiny) JPEG: SOI + APP0 "JFIF" + EOI — enough to pass sniffMedia's magic-number check.
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

test('cover: magic-number validation, alt text, and removal free the file', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram();

  const notAnImage = await fetch(`${h.api}/api/admin/program/cover?id=${program.id}&rev=${program.rev}&w=640&h=360&alt=${encodeURIComponent('a sunlit gym floor')}`, {
    method: 'PUT', headers: { ...as(ADMIN) }, body: Buffer.from('not an image')
  });
  assert.equal(notAnImage.status, 415);

  const badAltRes = await fetch(`${h.api}/api/admin/program/cover?id=${program.id}&rev=${program.rev}&w=640&h=360&alt=cover.jpg`, {
    method: 'PUT', headers: { ...as(ADMIN) }, body: TINY_JPEG
  });
  assert.equal(badAltRes.status, 400);
  assert.equal((await badAltRes.json()).field, 'coverAlt');

  const ok = await fetch(`${h.api}/api/admin/program/cover?id=${program.id}&rev=${program.rev}&w=640&h=360&alt=${encodeURIComponent('a sunlit gym floor')}`, {
    method: 'PUT', headers: { ...as(ADMIN) }, body: TINY_JPEG
  });
  assert.equal(ok.status, 200);
  const withCover = (await ok.json()).program;
  assert.ok(withCover.coverFile);

  const served = await fetch(`${h.api}/api/admin/program/cover?id=${program.id}`, { headers: as(ADMIN) });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');

  const coverPath = path.join(h.dataDir, 'program-covers', withCover.coverFile);
  assert.ok(fs.existsSync(coverPath));

  const removed = await h.post('/api/admin/program/cover/remove', { id: program.id, rev: withCover.rev });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.program.coverFile, undefined);
  assert.equal(fs.existsSync(coverPath), false, 'the orphaned file is unlinked once nothing references it');
});

test('a draft’s cover is still admin-only, same as every other program route', async t => {
  const h = await startServer(t);
  const { body: { program } } = await h.newProgram();
  await fetch(`${h.api}/api/admin/program/cover?id=${program.id}&rev=${program.rev}&w=640&h=360&alt=${encodeURIComponent('a sunlit gym floor')}`, {
    method: 'PUT', headers: { ...as(ADMIN) }, body: TINY_JPEG
  });
  const asVictim = await fetch(`${h.api}/api/admin/program/cover?id=${program.id}`, { headers: as(VICTIM) });
  assert.equal(asVictim.status, 403);
});
