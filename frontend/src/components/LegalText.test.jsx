// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ sheets: [] }))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ openSheet: (render, opts) => { mocks.sheets.push({ render, opts }); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})

import { LegalText, openLegalSheet, LEGAL_DOCS } from './LegalText.jsx'

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(el))
  mounted.push({ root, host })
  return host
}
afterEach(() => {
  while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() }
  mocks.sheets.length = 0
})

const doc = {
  id: 'x', title: 'Doc', version: '2026-10-17',
  sections: [
    { heading: 'Um', paragraphs: ['primeiro', { list: ['a', 'b'] }] },
    { heading: 'Dois', paragraphs: ['segundo'] },
  ],
}

describe('LegalText', () => {
  it('renders an h2 per section, a p per string and a li per list item', () => {
    const host = mount(<LegalText doc={doc} />)
    expect([...host.querySelectorAll('h2')].map(n => n.textContent)).toEqual(['Um', 'Dois'])
    expect([...host.querySelectorAll('p')].map(n => n.textContent)).toEqual(['primeiro', 'segundo'])
    expect([...host.querySelectorAll('li')].map(n => n.textContent)).toEqual(['a', 'b'])
  })

  it('exposes both documents', () => {
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(['privacidade', 'termos'])
  })

  it('openLegalSheet pushes a stacked sheet with the title and a Close button', () => {
    openLegalSheet('termos')
    expect(mocks.sheets).toHaveLength(1)
    expect(mocks.sheets[0].opts?.locked).toBeFalsy()
    const close = vi.fn()
    const host = mount(mocks.sheets[0].render(close))
    expect(host.querySelector('h3').textContent).toBe(LEGAL_DOCS.termos.title)
    const btn = [...host.querySelectorAll('button')].pop()
    act(() => btn.click())
    expect(close).toHaveBeenCalled()
  })
})
