// @vitest-environment happy-dom

/* ISO-1594/ISO-1610 review (Oráculo, round 2): refreshTeacherAssignments's own fetch+apply+push+
 * ack wiring, isolated from the rest of the sync suite (which deliberately doesn't export
 * fetchTeacherAssignments/ackTeacherAssignment in its lib/api.js mock, so this path is always a
 * silent no-op there — see store/useStore.sync.test.jsx's own api mock). Covers the two bugs
 * the review found: a `kind: 'program'` ending must actually clear S.teacherProgram (not leave
 * it standing after an Object.assign merge), and the ack must never go out before the push that
 * carries the change is confirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({
  api: vi.fn(),
  setRemoteAuth: vi.fn(),
  fetchBillingStatus: vi.fn().mockRejectedValue(new Error('not mocked')),
  fetchTeacherAssignments: vi.fn(),
  ackTeacherAssignment: vi.fn().mockResolvedValue({ ok: true }),
}))
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))

import { api, ackTeacherAssignment, fetchTeacherAssignments } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'

const clone = value => JSON.parse(JSON.stringify(value))
const signedIn = (S, extra = {}) => useStore.setState({ S, user: { id: 'user-1' }, ready: true, ...extra })
const routineAssignment = (over = {}) => ({
  id: 'asg1', kind: 'routine', startsOn: '2026-10-25', days: null,
  payload: { name: 'Treino A', ex: [{ id: '0001', sets: 3, reps: 10 }] }, ...over
})
const programAssignment = (over = {}) => ({ id: 'asgP', kind: 'program', startsOn: '2026-10-25', days: null, payload: { programId: 'prog1' }, ...over })

beforeEach(() => {
  localStorage.clear()
  api.mockReset()
  fetchTeacherAssignments.mockReset()
  ackTeacherAssignment.mockReset().mockResolvedValue({ ok: true })
  toast.mockReset()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})
afterEach(() => {
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

describe('refreshTeacherAssignments', () => {
  it('imports a pending routine, pushes it to the server, then acks — in that order', async () => {
    signedIn(clone(DEF))
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: Date.now() }))
    fetchTeacherAssignments.mockResolvedValue({ pending: [routineAssignment()], ended: [] })
    const order = []
    api.mockImplementation(async (path, opts) => {
      if (opts?.method === 'PUT') { order.push('push'); return { rev: 2 } }
      return {}
    })
    ackTeacherAssignment.mockImplementation(async id => { order.push('ack:' + id) })

    await useStore.getState().refreshTeacherAssignments()
    await new Promise(r => setTimeout(r, 0)) // the toast rides a lazy import('./useUI.js')

    expect(useStore.getState().S.routines).toHaveLength(1)
    expect(useStore.getState().S.routines[0].fromTeacher.assignmentId).toBe('asg1')
    expect(order).toEqual(['push', 'ack:asg1']) // push landed before the ack went out
    expect(toast).toHaveBeenCalledWith('New routine from your teacher')
  })

  it('clears S.teacherProgram when the ended list carries a program assignment — the Object.assign regression', async () => {
    signedIn({ ...clone(DEF), teacherProgram: { programId: 'prog1', assignmentId: 'asgP', startsOn: '2026-10-01', days: null } })
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: Date.now() }))
    fetchTeacherAssignments.mockResolvedValue({ pending: [], ended: [{ id: 'asgP', endedAt: Date.now(), payload: { programId: 'prog1' } }] })
    api.mockImplementation(async (path, opts) => (opts?.method === 'PUT' ? { rev: 2 } : {}))

    await useStore.getState().refreshTeacherAssignments()

    expect(useStore.getState().S.teacherProgram).toBeNull()
    expect(ackTeacherAssignment).toHaveBeenCalledWith('asgP')
  })

  it('does not ack anything when the push fails — the next poll gets to retry from the server\'s own copy', async () => {
    signedIn(clone(DEF))
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: Date.now() }))
    fetchTeacherAssignments.mockResolvedValue({ pending: [routineAssignment()], ended: [] })
    api.mockImplementation(async (path, opts) => { if (opts?.method === 'PUT') throw Object.assign(new Error('offline'), { status: 0 }); return {} })

    await useStore.getState().refreshTeacherAssignments()

    // The import still applied locally (it will push again on the next trigger — nothing here
    // discards local state), but nothing was acknowledged to the server yet.
    expect(useStore.getState().S.routines).toHaveLength(1)
    expect(ackTeacherAssignment).not.toHaveBeenCalled()
  })

  it('does nothing when there is nothing pending or ended', async () => {
    signedIn(clone(DEF))
    fetchTeacherAssignments.mockResolvedValue({ pending: [], ended: [] })

    await useStore.getState().refreshTeacherAssignments()

    expect(api).not.toHaveBeenCalled()
    expect(ackTeacherAssignment).not.toHaveBeenCalled()
  })
})
