// @vitest-environment happy-dom
// ISO-1594/ISO-1610 §6 (Oráculo review, round 2): the recommended-Program card is absent when
// there is no S.teacherProgram, and shows the Program's title once GET /api/account/program
// answers — the one place that fills in what importAssignment deliberately never copies.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import TeacherProgramCard from './TeacherProgramCard.jsx'

vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ openSheet: () => {} }) } }))
const { fetchAccountProgram } = vi.hoisted(() => ({ fetchAccountProgram: vi.fn() }))
vi.mock('../lib/api.js', () => ({ fetchAccountProgram, programCoverUrl: id => 'http://x/' + id }))

let host, root, originalS
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  fetchAccountProgram.mockReset()
  originalS = useStore.getState().S
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ S: originalS })
})

describe('TeacherProgramCard', () => {
  it('renders nothing when there is no recommended Program', async () => {
    useStore.setState({ S: { ...useStore.getState().S, teacherProgram: null } })
    await act(async () => { root.render(<TeacherProgramCard />) })
    expect(host.textContent).toBe('')
    expect(fetchAccountProgram).not.toHaveBeenCalled()
  })

  it('fetches and shows the Program\'s own title once teacherProgram is set', async () => {
    fetchAccountProgram.mockResolvedValue({ program: { id: 'prog1', title: 'Hypertrophy — Phase 2', description: '', hasCover: false } })
    useStore.setState({ S: { ...useStore.getState().S, teacherProgram: { programId: 'prog1', assignmentId: 'asg1', startsOn: '2026-10-25', days: null } } })

    await act(async () => { root.render(<TeacherProgramCard />) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(fetchAccountProgram).toHaveBeenCalledWith('prog1')
    expect(host.textContent).toContain('Hypertrophy — Phase 2')
    expect(host.textContent).toContain('Recommended by your teacher')
  })

  it('renders nothing (not a broken card) when the fetch fails', async () => {
    fetchAccountProgram.mockRejectedValue(new Error('offline'))
    useStore.setState({ S: { ...useStore.getState().S, teacherProgram: { programId: 'prog1', assignmentId: 'asg1' } } })

    await act(async () => { root.render(<TeacherProgramCard />) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(host.textContent).toBe('')
  })
})
