// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ISO-1606: the Brilhart exercises' front/back pair. Today's real catalogue (bf01-bf04) only
// ships a front view — the back GIFs don't exist yet (ISO-1605's delivery comment) — so this
// exercises the switcher against a synthetic 2-view exercise to prove the mechanism works the
// moment the second view lands, without waiting on that media.
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

const { default: Media, Thumb } = await import('./Media.jsx')

const EX = {
  id: 'bf01', n: 'port de bras', bp: 'shoulders', src: 'brilhart',
  views: [{ key: 'front', gif: 'bf01-front.gif', img: 'bf01-front.webp' }, { key: 'back', gif: 'bf01-back.gif', img: 'bf01-back.webp' }],
  img: 'bf01-front.webp', gif: 'bf01-front.gif',
}

let host, root
beforeEach(() => {
  mocks.S = { gifSize: 'full' }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('BuiltinMedia — an exercise with 2 views', () => {
  it('opens on the front view, animating, with a Frente/Costas switch', () => {
    act(() => root.render(<Media ex={EX} />))
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-front\.gif$/)
    const buttons = host.querySelectorAll('.gifviews button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false')
  })

  it('switching views does not touch play state: paused stays paused, on the new view\'s still', () => {
    act(() => root.render(<Media ex={EX} />))
    act(() => { host.querySelector('.exmedia').click() }) // pause
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-front\.webp$/)
    act(() => { host.querySelectorAll('.gifviews button')[1].click() }) // Back
    const img = host.querySelector('.exmedia img')
    expect(img.getAttribute('src')).toMatch(/bf01-back\.webp$/)
    expect(host.querySelector('.gifhint').textContent).toContain('tap to play')
  })

  it('switching views while playing keeps playing, on the new view\'s animation', () => {
    act(() => root.render(<Media ex={EX} />))
    act(() => { host.querySelectorAll('.gifviews button')[1].click() }) // Back, still playing
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-back\.gif$/)
    expect(host.querySelector('.gifhint').textContent).toContain('tap to pause')
  })

  it('a thumbnail is always the front view, regardless of which view is selected elsewhere', () => {
    act(() => root.render(<Thumb ex={EX} />))
    expect(host.querySelector('img.thumb').getAttribute('src')).toMatch(/bf01-front\.webp$/)
  })

  it('falls back to the other view before giving up to the neutral icon', () => {
    act(() => root.render(<Media ex={EX} />))
    act(() => { host.querySelector('.exmedia img').dispatchEvent(new Event('error')) }) // front gif fails
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-front\.webp$/) // front still
    act(() => { host.querySelector('.exmedia img').dispatchEvent(new Event('error')) }) // front still fails too
    // front exhausted — falls over to the untried back view's gif
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-back\.gif$/)
    act(() => { host.querySelector('.exmedia img').dispatchEvent(new Event('error')) }) // back gif fails
    expect(host.querySelector('.exmedia img').getAttribute('src')).toMatch(/bf01-back\.webp$/) // back still
    act(() => { host.querySelector('.exmedia img').dispatchEvent(new Event('error')) }) // back still fails too
    // every view exhausted — the generic icon, same as any broken media, never error text
    expect(host.querySelector('.exmedia.broken .exmedia-x')).toBeTruthy()
    expect(host.querySelector('img')).toBeNull()
  })

  it('a single-view exercise (today\'s real Brilhart data) shows no switcher at all', () => {
    const oneView = { ...EX, views: [EX.views[0]] }
    act(() => root.render(<Media ex={oneView} />))
    expect(host.querySelector('.gifviews')).toBeNull()
  })
})
