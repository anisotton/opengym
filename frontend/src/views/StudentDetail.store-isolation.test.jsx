// @vitest-environment happy-dom
// ISO-1594/ISO-1610 critério de aceite: opening a student's fiche is read-only end to end — it
// must never write to useStore/localStorage, which would otherwise push the student's data back
// to the server on the teacher's own next PUT /api/data (D4/D5 of the plan).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import StudentDetail from './StudentDetail.jsx'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'student-1' }),
}))
vi.mock('../sheets.jsx', () => ({
  confirmSheet: vi.fn(),
  menuSheet: vi.fn(),
  WorkoutRow: () => null,
}))

const STUDENT_VIEW = {
  unit: 'kg', workouts: [{ id: 'w1', d: '2026-10-20', start: 1000, end: 2000, entries: [{ id: '0001', sets: [{ w: 40, r: 10, done: true }] }] }],
  routines: [], customEx: [], scopeVersion: 1, shareBodyweight: false,
  summary: { lastWorkoutAt: '2026-10-20', workoutsThisWeek: 2, adherence: null, idleDays: 2, idle: false },
  assignment: null, assignmentHistory: [],
}

vi.mock('../lib/api.js', () => ({
  api: vi.fn(path => {
    if (path.startsWith('/api/teacher/students')) return Promise.resolve({ students: [{ id: 'student-1', name: 'Marina', acceptedAt: '2026-01-12T10:00:00.000Z' }] })
    if (path.startsWith('/api/teacher/student?')) return Promise.resolve(STUDENT_VIEW)
    if (path.startsWith('/api/teacher/student/notes')) return Promise.resolve({ notes: [] })
    return Promise.resolve({})
  }),
}))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('opening a student\'s fiche never writes to the teacher\'s own store', () => {
  it('leaves S and localStorage exactly as they were, across every tab', async () => {
    useStore.setState({ S: { ...useStore.getState().S, teacherLibrary: [] }, user: { id: 'teacher-1', name: 'Ana', role: 'teacher' } })
    localStorage.setItem('gym_state_v1', JSON.stringify(useStore.getState().S))
    const sBefore = useStore.getState().S
    const storedBefore = localStorage.getItem('gym_state_v1')

    await act(async () => { root.render(<StudentDetail />) })
    // flush the async GET /api/teacher/student(s) fetches and the resulting re-render
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    // The fiche actually rendered the fetched data (sanity check this isn't a false-negative
    // test that passed only because nothing ever loaded).
    expect(host.textContent).toContain('Marina')

    expect(useStore.getState().S).toBe(sBefore)                 // same object — update() was never called
    expect(localStorage.getItem('gym_state_v1')).toBe(storedBefore)

    // Switch every tab and flush again — Treinos/Notas fetch on demand but still must not write.
    const tabs = [...host.querySelectorAll('.seg button')]
    for (const btn of tabs) {
      await act(async () => { btn.click() })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
    }
    expect(useStore.getState().S).toBe(sBefore)
    expect(localStorage.getItem('gym_state_v1')).toBe(storedBefore)
  })
})

// D10 / the design doc's own rule: once the server answers 403 (the link ended while this
// screen was open, from any tab), the whole fiche is replaced by "you no longer follow them" —
// never left showing data that is no longer true.
describe('a 403 from any sub-tab drops the whole fiche, not just that tab', () => {
  it('switches to the "no longer follow" screen when the Notes tab\'s own load gets a 403', async () => {
    useStore.setState({ S: { ...useStore.getState().S, teacherLibrary: [] }, user: { id: 'teacher-1', name: 'Ana', role: 'teacher' } })
    vi.mocked(api).mockImplementation(path => {
      if (path.startsWith('/api/teacher/students')) return Promise.resolve({ students: [{ id: 'student-1', name: 'Marina', acceptedAt: '2026-01-12T10:00:00.000Z' }] })
      if (path.startsWith('/api/teacher/student?')) return Promise.resolve(STUDENT_VIEW)
      if (path.startsWith('/api/teacher/student/notes')) { const e = new Error('forbidden'); e.status = 403; return Promise.reject(e) }
      return Promise.resolve({})
    })

    await act(async () => { root.render(<StudentDetail />) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const notesTab = [...host.querySelectorAll('.seg button')].find(b => b.textContent === 'Notes')
    await act(async () => { notesTab.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).toContain('You no longer follow Marina.')
    expect(host.textContent).not.toContain('New note')
  })
})
