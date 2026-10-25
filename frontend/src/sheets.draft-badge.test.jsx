// @vitest-environment happy-dom
// "Draft — steps pending Brilhart review" (ISO-1606): a transparency note about where the
// instructions came from, not a warning — it shows only on the exercises still marked
// ex.draft (today, Brilhart's own 4) and disappears on its own once that field is cleared,
// with no user action and no re-translation needed to do it.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXBRILHART } from './lib/exercises-brilhart.js'
import { EXDB } from './lib/exercises.js'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exerciseDetailSheet } from './sheets.jsx'

const mounted = []
function renderTop() {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toastMsg: '' })
  useStore.setState({ S: structuredClone(DEF), user: null })
  document.body.innerHTML = ''
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('exercise detail — draft instructions badge', () => {
  it('shows the badge above the first step for a Brilhart exercise still marked draft', () => {
    const ex = EXBRILHART.find(e => e.id === 'bf01')
    expect(ex.draft).toBe(true)
    exerciseDetailSheet(ex)
    const host = renderTop()
    const badge = host.querySelector('.exdraft')
    expect(badge.textContent).toContain('Draft — steps pending Brilhart review')
    const steps = host.querySelector('.steps-list')
    // The badge sits right before the step list, not after it and not over the media.
    expect(badge.nextElementSibling).toBe(steps)
    expect(host.querySelector('.exmedia .exdraft')).toBeNull()
  })

  it('disappears once the exercise is no longer flagged draft, with the same instructions showing', () => {
    const validated = { ...EXBRILHART.find(e => e.id === 'bf01'), draft: false }
    exerciseDetailSheet(validated)
    const host = renderTop()
    expect(host.querySelector('.exdraft')).toBeNull()
    expect(host.querySelector('.steps-list li').textContent.length).toBeGreaterThan(0)
  })

  it('never shows for one of the 1,324 built-in exercises', () => {
    const ex = EXDB.find(e => e.st?.length > 0)
    exerciseDetailSheet(ex)
    const host = renderTop()
    expect(host.querySelector('.exdraft')).toBeNull()
  })
})
