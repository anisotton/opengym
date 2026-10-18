/* Pure rules for the admin Program catalog (ISO-1485) — no PostgreSQL, no server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, validateProgram, validateCoverAlt, validateCoverDims, diffForEvent,
  programConfig, titleMatchesForPurge, newProgramId
} from '../programs.js';

test('normalizeTitle trims and collapses internal whitespace', () => {
  assert.equal(normalizeTitle('  Hips   & T-spine '), 'Hips & T-spine');
  assert.equal(normalizeTitle(null), '');
});

test('validateProgram: a full valid create', () => {
  const r = validateProgram({ title: '5×5 Barbell Basics', category: 'strength', difficulty: 'beginner', sessionMinutes: 45 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    title: '5×5 Barbell Basics', description: '', category: 'strength', difficulty: 'beginner',
    sessionMinutes: 45, status: 'draft'
  });
});

test('validateProgram: every invalid example from the spec fails on the right field', () => {
  const base = { title: 'Valid Title', category: 'strength', difficulty: 'beginner', sessionMinutes: 45 };
  assert.equal(validateProgram({ ...base, title: '' }).field, 'title');
  assert.equal(validateProgram({ ...base, title: 'ab' }).field, 'title');
  assert.equal(validateProgram({ ...base, title: 'x'.repeat(121) }).field, 'title');
  assert.equal(validateProgram({ ...base, category: 'Mobility' }).field, 'category');
  assert.equal(validateProgram({ ...base, category: 'cardio' }).field, 'category');
  assert.equal(validateProgram({ ...base, difficulty: 'easy' }).field, 'difficulty');
  assert.equal(validateProgram({ ...base, difficulty: 'Beginner' }).field, 'difficulty');
  assert.equal(validateProgram({ ...base, sessionMinutes: 0 }).field, 'sessionMinutes');
  assert.equal(validateProgram({ ...base, sessionMinutes: 601 }).field, 'sessionMinutes');
  assert.equal(validateProgram({ ...base, sessionMinutes: 45.5 }).field, 'sessionMinutes');
  assert.equal(validateProgram({ ...base, sessionMinutes: '45' }).field, 'sessionMinutes');
  assert.equal(validateProgram({ ...base, description: 'x'.repeat(5001) }).field, 'description');
  assert.equal(validateProgram({ ...base, status: 'archived' }).field, 'status');
});

test('validateProgram: partial (update) only validates fields present', () => {
  const r = validateProgram({ sessionMinutes: 60 }, { partial: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { sessionMinutes: 60 });
});

test('validateProgram: a non-string/non-number description normalizes to empty', () => {
  const r = validateProgram({ title: 'Valid Title', category: 'general', difficulty: 'beginner', sessionMinutes: 10, description: 123 });
  assert.equal(r.ok, true);
  assert.equal(r.value.description, '');
});

test('validateCoverAlt rejects a filename, an empty value and a title echo', () => {
  assert.equal(validateCoverAlt('', 'My Program').ok, false);
  assert.equal(validateCoverAlt('img_2034.jpg', 'My Program').ok, false);
  assert.equal(validateCoverAlt('cover', 'My Program').ok, false);
  assert.equal(validateCoverAlt('My Program', 'My Program').ok, false, 'must not just restate the title');
  assert.equal(validateCoverAlt('Woman doing a goblet squat in a garage gym', 'My Program').ok, true);
});

test('validateCoverDims enforces the 640x360 minimum and the 4000 maximum', () => {
  assert.equal(validateCoverDims(639, 360).ok, false);
  assert.equal(validateCoverDims(640, 359).ok, false);
  assert.equal(validateCoverDims(4001, 2000).ok, false);
  assert.equal(validateCoverDims(1600, 900).ok, true);
  assert.equal(validateCoverDims(1600.5, 900).ok, false, 'must be integers');
});

test('diffForEvent: only changed fields appear, description collapses to "changed"', () => {
  const before = { title: 'A', description: 'long text', sessionMinutes: 30 };
  const after = { title: 'B', description: 'different long text', sessionMinutes: 30 };
  assert.deepEqual(diffForEvent(before, after), {
    title: ['A', 'B'],
    description: 'changed'
  });
});

test('diffForEvent: identical values (including null vs undefined) produce no entry', () => {
  assert.deepEqual(diffForEvent({ a: null, b: 1 }, { a: undefined, b: 1 }), {});
});

test('programConfig falls back to its defaults on a missing or unparsable env', () => {
  assert.deepEqual(programConfig({}), { trashDays: 30, coverMaxMB: 5 });
  assert.deepEqual(programConfig({ PROGRAM_TRASH_DAYS: 'nope', PROGRAM_COVER_MAX_MB: '-1' }), { trashDays: 30, coverMaxMB: 5 });
  assert.deepEqual(programConfig({ PROGRAM_TRASH_DAYS: '0', PROGRAM_COVER_MAX_MB: '2' }), { trashDays: 0, coverMaxMB: 2 });
});

test('titleMatchesForPurge compares normalized, not literal, text', () => {
  assert.equal(titleMatchesForPurge('  Leg   Day ', 'Leg Day'), true);
  assert.equal(titleMatchesForPurge('leg day', 'Leg Day'), false, 'case still matters for this confirmation');
  assert.equal(titleMatchesForPurge('', ''), false);
});

test('newProgramId returns a fresh, URL-safe id each time', () => {
  const a = newProgramId(), b = newProgramId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
