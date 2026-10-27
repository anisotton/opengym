// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ISO-1606: every EXDB exercise lost its img/gif when the third-party media was removed
// (ISO-1603) — this is that state, not a corner case. The detail sheet and the full workout
// card must reserve the same band a real GIF would and show the muscle map instead of leaving
// it empty; the superset/minimized bands are too short to read a body in, so they keep the
// plain icon tile a media failure already uses.
const mocks = vi.hoisted(() => {
  const state = { S: { gifSize: 'full' } }
  state.snapshot = () => ({ S: state.S, update: mut => { const next = structuredClone(state.S); mut(next); state.S = next } })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector(mocks.snapshot())
  useStore.getState = mocks.snapshot
  return { useStore }
})

const { default: Media } = await import('./Media.jsx')

// BodyMap fetches its geometry with a dynamic import on first render (lib/body-paths.js);
// importing it here up front keeps the wait below about rendering, not module loading.
beforeAll(() => import('../lib/body-paths.js'))

const EX = { id: '0025', n: 'barbell bench press', bp: 'chest', tg: 'pectorals', sm: ['triceps'] }

let host, root
beforeEach(() => {
  mocks.S = { gifSize: 'full' }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('BuiltinMedia — an exercise with no media of its own', () => {
  it('shows the muscle map, not an empty block, in the full-size detail/workout band', async () => {
    act(() => root.render(<Media ex={EX} />))
    await vi.waitFor(() => expect(host.querySelectorAll('.bm-v')).toHaveLength(2))
    expect(host.querySelector('.exmedia.nomedia')).toBeTruthy()
    expect(host.querySelector('.exmedia-x')).toBeNull()
  })

  it('names the muscle map for assistive tech, since the svgs inside it carry no label', async () => {
    act(() => root.render(<Media ex={EX} />))
    await vi.waitFor(() => expect(host.querySelectorAll('.bm-v')).toHaveLength(2))
    expect(host.querySelector('.exmedia')?.getAttribute('aria-label')).toBe('Muscle map for this exercise')
  })

  it('keeps the neutral icon in the superset-compact band — too short to read a body in', () => {
    act(() => root.render(<Media ex={EX} compact minimizable />))
    expect(host.querySelector('.exmedia-x')).toBeTruthy()
    expect(host.querySelector('.bodymap')).toBeNull()
  })

  it('keeps the neutral icon in the minimized band too', () => {
    mocks.S = { gifSize: 'mini' }
    act(() => root.render(<Media ex={EX} minimizable />))
    expect(host.querySelector('.exmedia-x')).toBeTruthy()
    expect(host.querySelector('.bodymap')).toBeNull()
  })

  it("renders nothing in the workout when gifSize is 'off', same as an exercise with real media", () => {
    mocks.S = { gifSize: 'off' }
    act(() => root.render(<Media ex={EX} minimizable />))
    expect(host.innerHTML).toBe('')
  })
})
