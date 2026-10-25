/* The `programs`/`program_events` half of store.js (ISO-1485), tested directly against real
 * PostgreSQL — no server.js spawned. server-admin-programs.test.js covers the HTTP layer and the
 * admin gate; this file covers the data rules a route test can't see as directly: the CHECK
 * constraints, the compare-and-set race, the partial unique index, and the auto-purge sweep. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import {
  createUser, createProgram, updateProgram, trashProgram, restoreProgram, purgeProgram,
  purgeExpiredPrograms, setProgramCover, clearProgramCover, coverStillReferenced,
  listPrograms, getProgram, listProgramEvents, getAllCoverFiles
} from '../store.js';

const admin = { id: 'admin1', name: 'Adminna' };
const iso = () => new Date().toISOString();

// Every test below that passes `admin` as an actor needs that id to be a real users row —
// created_by/updated_by/deleted_by/cover_updated_by all carry a foreign key (ON DELETE SET
// NULL — the one test about that deletes the row itself, deliberately, after creating it here).
async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  await createUser(pool, { id: admin.id, name: admin.name, created: iso() });
  return pool;
}
const VALUE = { title: 'Full Body Starter', description: '', category: 'general', difficulty: 'beginner', sessionMinutes: 45, status: 'draft' };

test('createProgram writes the row and one create event', async t => {
  const pool = await withPool(t);
  const r = await createProgram(pool, VALUE, admin);
  assert.equal(r.ok, true);
  assert.equal(r.row.title, VALUE.title);
  assert.equal(r.row.rev, 1);
  assert.equal(r.row.createdBy, admin.id);

  const events = await listProgramEvents(pool, r.row.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'create');
  assert.equal(events[0].actorName, admin.name);
});

test('two active programs cannot share a title, case-insensitively', async t => {
  const pool = await withPool(t);
  await createProgram(pool, VALUE, null);
  const dupe = await createProgram(pool, { ...VALUE, title: 'full body starter' }, null);
  assert.equal(dupe.error, 'a program with this title already exists');
  assert.equal(dupe.code, 'title-taken');
});

test('updateProgram: a no-op save writes nothing and logs no event', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  const r = await updateProgram(pool, row.id, row.rev, { title: row.title }, null);
  assert.equal(r.ok, true);
  assert.equal(r.action, null);
  assert.equal(r.row.rev, row.rev, 'rev did not move');
  assert.equal((await listProgramEvents(pool, row.id)).length, 1, 'still just the create event');
});

test('updateProgram: a stale rev is refused and reports the current row', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  await updateProgram(pool, row.id, row.rev, { title: 'Renamed' }, null);
  const stale = await updateProgram(pool, row.id, row.rev, { title: 'Collision' }, null);
  assert.equal(stale.code, 'stale');
  assert.equal(stale.current.title, 'Renamed');
});

test('updateProgram: toggling only status logs publish/unpublish, not update', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  const published = await updateProgram(pool, row.id, row.rev, { status: 'published' }, admin);
  assert.equal(published.action, 'publish');
  assert.ok(published.row.publishedAt);

  const unpublished = await updateProgram(pool, published.row.id, published.row.rev, { status: 'draft' }, admin);
  assert.equal(unpublished.action, 'unpublish');

  const edited = await updateProgram(pool, unpublished.row.id, unpublished.row.rev, { title: 'New title', status: 'published' }, admin);
  assert.equal(edited.action, 'update', 'status plus another field together is a plain update');
});

test('a program in the trash is read-only', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  const trashed = await trashProgram(pool, row.id, row.rev, admin);
  assert.equal(trashed.ok, true);
  assert.ok(trashed.row.deletedAt);

  const edit = await updateProgram(pool, row.id, trashed.row.rev, { title: 'nope' }, admin);
  assert.equal(edit.code, 'in-trash');

  const cover = await setProgramCover(pool, row.id, trashed.row.rev, { file: 'a'.repeat(64) + '.jpg', mime: 'image/jpeg', width: 640, height: 360, bytes: 10, alt: 'x' }, admin);
  assert.equal(cover.code, 'in-trash');
});

test('restore always comes back as a draft, and frees the title for reuse while trashed', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, { ...VALUE, status: 'published' }, null);
  const trashed = await trashProgram(pool, row.id, row.rev, admin);

  // The title is free again while the original is in the trash.
  const second = await createProgram(pool, VALUE, null);
  assert.equal(second.ok, true);

  const restored = await restoreProgram(pool, row.id, admin);
  assert.equal(restored.code, 'title-taken', 'the title is active again now');

  await trashProgram(pool, second.row.id, second.row.rev, admin);
  const restoredOk = await restoreProgram(pool, row.id, admin);
  assert.equal(restoredOk.ok, true);
  assert.equal(restoredOk.row.status, 'draft');
  assert.equal(restoredOk.row.deletedAt, undefined);
});

test('purge only works from the trash, with the exact title, and the row is gone after', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  const early = await purgeProgram(pool, row.id, VALUE.title, admin);
  assert.equal(early.code, 'not-in-trash');

  await trashProgram(pool, row.id, row.rev, admin);
  const mismatch = await purgeProgram(pool, row.id, 'wrong title', admin);
  assert.equal(mismatch.code, 'confirm-mismatch');

  const ok = await purgeProgram(pool, row.id, VALUE.title, admin);
  assert.equal(ok.ok, true);
  assert.equal(await getProgram(pool, row.id), null);
  // program_events survives the purge of the row it is about.
  const events = await listProgramEvents(pool, row.id);
  assert.equal(events.at(0).action, 'purge');
});

test('purgeExpiredPrograms only touches rows past the cutoff, and leaves active ones alone', async t => {
  const pool = await withPool(t);
  const { row: fresh } = await createProgram(pool, VALUE, null);
  const { row: old } = await createProgram(pool, { ...VALUE, title: 'Old one' }, null);
  await trashProgram(pool, old.id, old.rev, admin);
  await pool.query("UPDATE programs SET deleted_at = now() - interval '31 days' WHERE id = $1", [old.id]);

  assert.deepEqual(await purgeExpiredPrograms(pool, 0), [], 'trashDays 0 never auto-purges');

  const purged = await purgeExpiredPrograms(pool, 30);
  assert.equal(purged.length, 1);
  assert.equal(purged[0].id, old.id);
  assert.equal(await getProgram(pool, old.id), null);
  assert.ok(await getProgram(pool, fresh.id), 'an active program is untouched');

  const events = await listProgramEvents(pool, old.id);
  assert.equal(events.at(0).action, 'purge_auto');
  assert.equal(events.at(0).actorName, 'system');
  assert.equal(events.at(0).actorId, null);
});

test('cover: a shared hash is not freed while any row — including a trashed one — still points at it', async t => {
  const pool = await withPool(t);
  const { row: a } = await createProgram(pool, VALUE, null);
  const { row: b } = await createProgram(pool, { ...VALUE, title: 'Other program' }, null);
  const file = 'b'.repeat(64) + '.jpg';
  const cover = { file, mime: 'image/jpeg', width: 640, height: 360, bytes: 1000, alt: 'a sunlit gym floor' };

  const setA = await setProgramCover(pool, a.id, a.rev, cover, admin);
  assert.equal(setA.ok, true);
  assert.equal(setA.oldFile, null, 'nothing to free — there was no previous cover');

  const setB = await setProgramCover(pool, b.id, b.rev, cover, admin);
  assert.equal(setB.ok, true);

  const clearedA = await clearProgramCover(pool, a.id, setA.row.rev, admin);
  assert.equal(clearedA.ok, true);
  assert.equal(clearedA.oldStillReferenced, true, 'b still points at the same file');
  assert.equal(await coverStillReferenced(pool, file), true);

  const clearedB = await clearProgramCover(pool, b.id, setB.row.rev, admin);
  assert.equal(clearedB.oldStillReferenced, false, 'the last reference is gone');
});

test('listPrograms: q escapes its own ILIKE wildcards', async t => {
  const pool = await withPool(t);
  await createProgram(pool, { ...VALUE, title: '100% Effort' }, null);
  await createProgram(pool, { ...VALUE, title: 'Leg Day' }, null);
  const literal = await listPrograms(pool, { q: '100%' });
  assert.equal(literal.length, 1);
  assert.equal(literal[0].title, '100% Effort');
  // A bare '%' is escaped to a literal character to search for, not treated as "match
  // everything" — it finds only the title that actually contains one.
  const bareWildcard = await listPrograms(pool, { q: '%' });
  assert.equal(bareWildcard.length, 1);
  assert.equal(bareWildcard[0].title, '100% Effort');
});

test('deleting the admin who created/updated a program clears the actor columns, not the row', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, admin);
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  const after = await getProgram(pool, row.id);
  assert.equal(after.title, VALUE.title, 'the program itself survives');
  assert.equal('createdBy' in after, false, 'ON DELETE SET NULL on created_by');
  // program_events keeps the name it snapshotted, independent of the users row.
  const events = await listProgramEvents(pool, row.id);
  assert.equal(events[0].actorName, admin.name);
});

test('the CHECK constraints refuse a bad row even via a direct INSERT', async t => {
  const pool = await withPool(t);
  await assert.rejects(pool.query(
    `INSERT INTO programs (id, title, category, difficulty, session_minutes)
     VALUES ('x', 'Bad category', 'cardio', 'beginner', 30)`
  ), /violates check constraint/);
  await assert.rejects(pool.query(
    `INSERT INTO programs (id, title, category, difficulty, session_minutes)
     VALUES ('x', 'Too long', 'general', 'beginner', 601)`
  ), /violates check constraint/);
  await assert.rejects(pool.query(
    'INSERT INTO programs (id, title, category, difficulty, session_minutes, cover_file) VALUES ($1,$2,$3,$4,$5,$6)',
    ['x', 'Half a cover', 'general', 'beginner', 30, 'f'.repeat(64) + '.jpg']
  ), /violates check constraint/);
});

test('getAllCoverFiles lists every distinct cover_file, including a trashed program’s', async t => {
  const pool = await withPool(t);
  const { row } = await createProgram(pool, VALUE, null);
  const file = 'c'.repeat(64) + '.png';
  const withCover = await setProgramCover(pool, row.id, row.rev, { file, mime: 'image/png', width: 640, height: 360, bytes: 5, alt: 'x' }, null);
  await trashProgram(pool, row.id, withCover.row.rev, null);
  assert.deepEqual([...await getAllCoverFiles(pool)], [file]);
});
