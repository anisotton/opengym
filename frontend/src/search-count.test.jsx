// @vitest-environment happy-dom
// The live result count in the exercise search (idea: GitLab !31, sagnikpatra301): the Library
// and the exercise picker show how many exercises are left once a search or a filter narrows
// the list, and say it in words to a screen reader.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exercisePicker } from './sheets.jsx'
import Library from './views/Library.jsx'
import { registerExerciseAliases } from './lib/exercise-aliases.js'
import { LIBRARY_CATALOGUE, searchExercises } from './lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mounted = []
function mount(node) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(node))
  return host
}
const renderTopSheet = () => {
  const sheet = useUI.getState().sheets.at(-1)
  return mount(sheet.render(() => useUI.getState().closeSheet(sheet.id)))
}
function type(el, value) {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const chip = (host, text) => [...host.querySelectorAll('.chips .chip')].find(b => b.textContent.trim() === text)
// Every body part again: the picker's "All" chip, or in the Library (one filter row since 1.4.5,
// P7) a second tap on the chosen body part.
const allParts = host => chip(host, 'All') || host.querySelector('.lib-filters .chip.on[aria-pressed="true"]')
const count = host => host.querySelector('.search .search-count')

beforeEach(() => {
  useUI.setState({ sheets: [], toastMsg: '' })
  useStore.setState({ S: structuredClone(DEF), user: null })
  registerExerciseAliases({})
  document.body.innerHTML = ''
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

// The screens run the same search over the same catalogue, so the expected numbers come from
// it — LIBRARY_CATALOGUE (ISO-1638), the library-visible subset Library/the picker actually
// search, not the full EXDB.
const matches = q => searchExercises(LIBRARY_CATALOGUE, q).length
// Upstream aliases EXDB 1162 (barbell standing military press), which this fork hides from the
// library and the picker (ISO-1638): the alias goes on a Brilhart exercise the screens do show.
const ALIASED = LIBRARY_CATALOGUE.find(e => e.eq === 'barbell' && e.bp !== 'neck') || LIBRARY_CATALOGUE.find(e => e.bp !== 'neck')
const AID = ALIASED.id, ANAME = ALIASED.n.toLowerCase(), AEQ = String(ALIASED.eq).split(' ')[0]

describe('exercise search result count', () => {
  for (const [where, open] of [
    ['Library', () => mount(<MemoryRouter><Library /></MemoryRouter>)],
    ['exercise picker', () => { exercisePicker(vi.fn()); return renderTopSheet() }],
  ]) {
    it(`${where}: finds aliases, follows edits and clears, and keeps filters`, () => {
      const host = open()
      const input = host.querySelector('.search input')
      const update = fn => act(() => useStore.getState().update(fn))
      update(s => {
        s.exAliases = { [AID]: ['Zentara lift'] }
        s.customEx = [{ id: 'calias', n: 'Custom shoulder press', bp: 'shoulders', eq: 'barbell', custom: true, aliases: ['Harbour lift'] }]
      })
      for (const query of ['Zentara lift', 'ZENTARA LIFT', 'zentara', 'lift zentara', 'zentara ' + AEQ]) {
        act(() => type(input, query))
        expect(count(host).textContent).toBe('1')
        expect(host.textContent.toLowerCase()).toContain(ANAME)
      }
      act(() => type(input, 'Harbour lift'))
      expect(count(host).textContent).toBe('1')
      expect(host.textContent).toContain('Custom shoulder press')
      act(() => type(input, 'Zentara lift'))
      act(() => chip(host, 'neck').click())
      expect(count(host).textContent).toBe('0')
      act(() => allParts(host).click())
      expect(count(host).textContent).toBe('1')
      update(s => { s.exAliases[AID] = ['Summit lift'] })
      expect(count(host).textContent).toBe('0')
      act(() => type(input, 'Summit lift'))
      expect(count(host).textContent).toBe('1')
      update(s => { s.exAliases[AID] = [] })
      expect(count(host).textContent).toBe('0')
      act(() => type(input, ALIASED.n))
      expect(Number(count(host).textContent)).toBeGreaterThan(0)
    })

    it(`${where}: appears with a search, follows it, and goes when the search is cleared`, () => {
      const host = open()
      const input = host.querySelector('.search input')
      expect(count(host)).toBeNull()
      expect(host.querySelector('.search').classList.contains('has-count')).toBe(false)

      act(() => type(input, 'push'))
      const n = matches('push')
      expect(n).toBeGreaterThan(1)
      expect(count(host).textContent).toBe(String(n))
      expect(count(host).getAttribute('aria-label')).toBe(`${n} exercises`)
      expect(host.querySelector('.search').classList.contains('has-count')).toBe(true)

      act(() => type(input, 'push up diamond'))
      expect(Number(count(host).textContent)).toBe(matches('push up diamond'))

      act(() => type(input, ''))
      expect(count(host)).toBeNull()
    })

    it(`${where}: counts a body-part filter too, and reads "1 exercise" for one`, () => {
      const host = open()
      act(() => chip(host, 'neck').click())
      const neck = LIBRARY_CATALOGUE.filter(e => e.bp === 'neck').length
      expect(Number(count(host).textContent)).toBe(neck)
      const one = LIBRARY_CATALOGUE.find(e => searchExercises(LIBRARY_CATALOGUE, e.n).length === 1)
      act(() => allParts(host).click())
      act(() => type(host.querySelector('.search input'), one.n))
      expect(count(host).textContent).toBe('1')
      expect(count(host).getAttribute('aria-label')).toBe('1 exercise')
    })
  }
})
