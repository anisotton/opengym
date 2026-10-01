// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { todayISO } from './lib/format.js'
import { calendarSheet } from './sheets.jsx'

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

describe('Calendar canonical workout days', () => {
  let original

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    original = useStore.getState().S
    useUI.setState({ sheets: [] })
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => { mounted.splice(0).forEach(root => root.unmount()) })
    useStore.setState({ S: original })
    vi.useRealTimers()
  })

  // Regression for ISO-1410: `calendarSheet(iso)` used to parse the bare "YYYY-MM-DD" string
  // with `new Date(iso)`, which JS treats as UTC midnight. In any timezone behind UTC that rolls
  // back a day — and on the 1st of the month, back a whole month — so the sheet opened on the
  // wrong month and "today"'s workouts rendered as if the month had none. Pinning the clock to
  // both the first and last day of a month proves the fix without depending on the real date.
  it.each([
    ['first day of the month', '2026-10-01T09:00:00'],
    ['last day of the month', '2026-10-31T09:00:00'],
  ])('keeps multiple legacy sessions on the heatmap fallback day clickable in Calendar (%s)', (_label, systemTime) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(systemTime))

    const day = todayISO()
    const start = new Date(day + 'T09:00:00').getTime()
    useStore.setState({ S: {
      ...original,
      workouts: [
        { id: 'legacy-a', d: '', start, end: start + 15 * 60000, name: 'Legacy A', vol: 100, entries: [] },
        { id: 'legacy-b', d: 'not-a-day', start: start + 30 * 60000, end: start + 45 * 60000, name: 'Legacy B', vol: 200, entries: [] },
      ],
    } })

    calendarSheet(day)
    const host = renderTop()
    expect(host.textContent).toContain('2 workouts')
    const trainedDay = host.querySelector('button.cal-d.has')
    expect(trainedDay).toBeTruthy()

    act(() => trainedDay.click())
    const sessions = renderTop()
    expect(sessions.textContent).toContain('Legacy A')
    expect(sessions.textContent).toContain('Legacy B')
  })
})
