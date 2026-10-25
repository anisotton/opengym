import { describe, expect, it } from 'vitest'
import { applyAssignments, endAssignment, importAssignment, scopeItems, TEACHER_SCOPE_VERSION } from './teacher.js'

const base = (over = {}) => ({ routines: [], customEx: [], week: {}, ...over })
const routineAssignment = (over = {}) => ({
  id: 'asg1', kind: 'routine', startsOn: '2026-10-25', days: null,
  payload: { name: 'Hipertrofia — Fase 2', ex: [{ id: '0001', sets: 3, reps: 10 }] },
  ...over
})

describe('importAssignment', () => {
  it('adds a new routine marked fromTeacher, with a fresh id', () => {
    const next = importAssignment(base(), routineAssignment())
    expect(next.routines).toHaveLength(1)
    const r = next.routines[0]
    expect(r.id).toBeTruthy()
    expect(r.name).toBe('Hipertrofia — Fase 2')
    expect(r.fromTeacher).toEqual({ name: 'Hipertrofia — Fase 2', assignmentId: 'asg1' })
  })

  it('is idempotent by assignmentId — importing twice does not duplicate', () => {
    const once = importAssignment(base(), routineAssignment())
    const twice = importAssignment(once, routineAssignment())
    expect(twice.routines).toHaveLength(1)
    expect(twice).toBe(once) // unchanged state, not just equal — a true no-op
  })

  it('never mutates its input', () => {
    const state = base()
    importAssignment(state, routineAssignment())
    expect(state.routines).toEqual([])
  })

  it('adds the new routine to week[d] for every assigned day', () => {
    const next = importAssignment(base(), routineAssignment({ days: [1, 3, 5] }))
    const rid = next.routines[0].id
    expect(next.week[1]).toEqual([rid])
    expect(next.week[3]).toEqual([rid])
    expect(next.week[5]).toEqual([rid])
    expect(next.week[2]).toBeUndefined()
  })

  it('does not touch week when the assignment has no fixed days', () => {
    const next = importAssignment(base(), routineAssignment({ days: null }))
    expect(next.week).toEqual({})
  })

  it('appends to an existing week[d] list instead of replacing it', () => {
    const next = importAssignment(base({ week: { 1: ['own-routine'] } }), routineAssignment({ days: [1] }))
    expect(next.week[1]).toEqual(['own-routine', next.routines[0].id])
  })

  it('merges embedded customEx that do not collide with an existing id', () => {
    const state = base({ customEx: [{ id: 'c1', name: 'Band pull-apart' }] })
    const a = routineAssignment({
      payload: { name: 'R', ex: [{ id: 'c2', sets: 3, reps: 10 }], customEx: [{ id: 'c2', name: 'Cable face pull' }] }
    })
    const next = importAssignment(state, a)
    expect(next.customEx).toEqual([{ id: 'c1', name: 'Band pull-apart' }, { id: 'c2', name: 'Cable face pull' }])
    expect(next.routines[0].ex[0].id).toBe('c2')
  })

  it('remaps a genuinely colliding customEx id to a fresh one, and rewrites the routine\'s reference', () => {
    const state = base({ customEx: [{ id: 'c1', name: 'Already mine' }] })
    const a = routineAssignment({
      payload: { name: 'R', ex: [{ id: 'c1', sets: 3, reps: 10 }], customEx: [{ id: 'c1', name: 'Teacher\'s own exercise' }] }
    })
    const next = importAssignment(state, a)
    expect(next.customEx).toHaveLength(2)
    expect(next.customEx[0]).toEqual({ id: 'c1', name: 'Already mine' }) // untouched
    const added = next.customEx[1]
    expect(added.id).not.toBe('c1')
    expect(added.name).toBe('Teacher\'s own exercise')
    expect(next.routines[0].ex[0].id).toBe(added.id) // the routine's own reference follows the remap
  })

  it('reuses the same id when the embedded customEx is identical to an existing one (repeat delivery)', () => {
    const state = base({ customEx: [{ id: 'c1', name: 'Same' }] })
    const a = routineAssignment({
      payload: { name: 'R', ex: [{ id: 'c1', sets: 3, reps: 10 }], customEx: [{ id: 'c1', name: 'Same' }] }
    })
    const next = importAssignment(state, a)
    expect(next.customEx).toEqual([{ id: 'c1', name: 'Same' }])
    expect(next.routines[0].ex[0].id).toBe('c1')
  })

  it('kind "program" sets teacherProgram instead of adding a routine, and is idempotent', () => {
    const a = { id: 'asg2', kind: 'program', startsOn: '2026-10-25', days: null, payload: { programId: 'prog1' } }
    const once = importAssignment(base(), a)
    expect(once.routines).toEqual([])
    expect(once.teacherProgram).toEqual({ programId: 'prog1', assignmentId: 'asg2', startsOn: '2026-10-25', days: null })
    const twice = importAssignment(once, a)
    expect(twice).toBe(once)
  })

  it('ignores an assignment with no id, or an unknown kind', () => {
    const state = base()
    expect(importAssignment(state, { kind: 'routine', payload: {} })).toBe(state)
    expect(importAssignment(state, { id: 'x', kind: 'something-else' })).toBe(state)
  })
})

describe('endAssignment', () => {
  it('marks fromTeacher.endedAt and removes the routine from week, but keeps the routine', () => {
    const imported = importAssignment(base({ week: { 1: ['own'] } }), routineAssignment({ days: [1, 2] }))
    const rid = imported.routines[0].id
    const ended = endAssignment(imported, 'asg1', 5000)
    expect(ended.routines).toHaveLength(1)
    expect(ended.routines[0].id).toBe(rid)
    expect(ended.routines[0].fromTeacher.endedAt).toBe(5000)
    expect(ended.week[1]).toEqual(['own'])
    expect(ended.week[2]).toBeUndefined()
  })

  it('is idempotent — ending an already-ended assignment changes nothing', () => {
    const imported = importAssignment(base(), routineAssignment())
    const once = endAssignment(imported, 'asg1', 5000)
    const twice = endAssignment(once, 'asg1', 9999)
    expect(twice).toBe(once)
  })

  it('does nothing for an assignment that was never imported', () => {
    const state = base()
    expect(endAssignment(state, 'never-imported', 1)).toBe(state)
  })

  it('never mutates its input', () => {
    const imported = importAssignment(base(), routineAssignment())
    const before = JSON.stringify(imported)
    endAssignment(imported, 'asg1', 1)
    expect(JSON.stringify(imported)).toBe(before)
  })

  it('clears teacherProgram to null (not an omitted key) for an ended program recommendation', () => {
    const a = { id: 'asg2', kind: 'program', payload: { programId: 'prog1' } }
    const imported = importAssignment(base(), a)
    const ended = endAssignment(imported, 'asg2', 1)
    // Not toBeUndefined(): an omitted key reads as undefined too, but store/useStore.js merges
    // this onto a live draft with Object.assign, which only overwrites keys actually present on
    // the source — an omitted `teacherProgram` would leave the draft's old card sitting there.
    // Object.hasOwn below is exactly the check that distinguishes "cleared" from "never touched".
    expect(Object.hasOwn(ended, 'teacherProgram')).toBe(true)
    expect(ended.teacherProgram).toBeNull()
    // The regression itself: simulating the store's own merge strategy against a draft that
    // still has the old card must actually clear it, not leave it standing.
    const draft = { ...imported }
    Object.assign(draft, endAssignment(imported, 'asg2', 1))
    expect(draft.teacherProgram).toBeNull()
  })
})

describe('applyAssignments', () => {
  const programAssignment = (over = {}) => ({ id: 'asgP', kind: 'program', payload: { programId: 'prog1' }, ...over })

  it('applies every pending assignment, then every ended one, in order', () => {
    const next = applyAssignments(base(), {
      pending: [routineAssignment(), programAssignment({ id: 'asgP2' })],
      ended: []
    })
    expect(next.routines).toHaveLength(1)
    expect(next.teacherProgram).toEqual({ programId: 'prog1', assignmentId: 'asgP2', startsOn: null, days: null })
  })

  // The realistic combined pull (not a same-id-in-both-lists edge case, which the server's own
  // delivered_at/ended_at split can't produce): a "Trocar" replaces the student's current
  // routine with a new one in one teacher action — the next pull sees the new one as `pending`
  // and the old, already-delivered one as `ended`, in the same response.
  it('a switch delivered in one pull imports the new routine and marks the old one ended, not stuck on the old one', () => {
    const was = applyAssignments(base(), { pending: [routineAssignment({ id: 'asgOld' })], ended: [] })
    const next = applyAssignments(was, {
      pending: [routineAssignment({ id: 'asgNew', payload: { name: 'Novo treino', ex: [{ id: '0002', sets: 3, reps: 8 }] } })],
      ended: [{ id: 'asgOld', endedAt: 5000 }]
    })
    expect(next.routines).toHaveLength(2)
    const old = next.routines.find(r => r.fromTeacher.assignmentId === 'asgOld')
    const fresh = next.routines.find(r => r.fromTeacher.assignmentId === 'asgNew')
    expect(old.fromTeacher.endedAt).toBe(5000)
    expect(fresh.fromTeacher.endedAt).toBeUndefined()
  })

  it('a program recommendation withdrawn in the same pull it never got delivered in ends up cleared', () => {
    const a = programAssignment()
    // Defensive, not a shape the server produces (pending requires delivered_at IS NULL, ended
    // requires it IS NOT NULL — mutually exclusive) — applyAssignments still must not get stuck
    // half-imported if it ever did see this.
    const next = applyAssignments(base(), { pending: [a], ended: [{ id: a.id, endedAt: 5000 }] })
    expect(next.teacherProgram).toBeNull()
  })

  it('reapplying the exact same batch against its own result is a no-op', () => {
    const batch = { pending: [routineAssignment(), programAssignment({ id: 'asgP2' })], ended: [] }
    const once = applyAssignments(base(), batch)
    const twice = applyAssignments(once, batch)
    expect(twice).toEqual(once)
  })

  it('never mutates its input', () => {
    const state = base()
    const before = JSON.stringify(state)
    applyAssignments(state, { pending: [routineAssignment()], ended: [] })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('tolerates a missing pending/ended list', () => {
    expect(applyAssignments(base(), {})).toEqual(base())
    expect(applyAssignments(base())).toEqual(base())
  })
})

describe('scopeItems', () => {
  it('returns the sees/neverSees lists for the current version', () => {
    const s = scopeItems(TEACHER_SCOPE_VERSION)
    expect(s.version).toBe(TEACHER_SCOPE_VERSION)
    expect(s.sees.length).toBeGreaterThan(0)
    expect(s.neverSees.length).toBeGreaterThan(0)
  })

  it('returns null for a version it does not recognize (caller shows scope-outdated instead)', () => {
    expect(scopeItems(TEACHER_SCOPE_VERSION + 1)).toBeNull()
  })

  // Parity with api/teacher.js's own TEACHER_SCOPE_VERSION and field lists (D5) — imported
  // directly here because this test file runs under Node/vitest, never bundled into the app
  // (api/teacher.js pulls in node:crypto, which is why lib/teacher.js keeps its own mirror
  // instead of importing it at runtime).
  it('TEACHER_SCOPE_VERSION stays in sync with api/teacher.js', async () => {
    const api = await import('../../../api/teacher.js')
    expect(TEACHER_SCOPE_VERSION).toBe(api.TEACHER_SCOPE_VERSION)
    // One sees-item per allowlisted field (api.TEACHER_SCOPE) — a field added or removed there
    // without a matching text change here should fail loudly. TEACHER_SCOPE_NEVER has more
    // fields (6) than neverSees has lines (4) on purpose — the screen groups settings/email/
    // birthDate into one sentence ("Suas configurações, e-mail e data de nascimento"), so it is
    // not a 1:1 count; a human has to update that sentence too if a field is ever added there.
    const s = scopeItems(TEACHER_SCOPE_VERSION)
    expect(s.sees).toHaveLength(api.TEACHER_SCOPE.length)
    expect(s.neverSees.length).toBeGreaterThan(0)
  })
})
