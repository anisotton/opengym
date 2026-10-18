// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import Legal from './Legal.jsx'
import { LEGAL_DOCS } from '../components/LegalText.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<MemoryRouter>{el}</MemoryRouter>))
  mounted.push({ root, host })
  return host
}
afterEach(() => { while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() } })

describe('Legal view', () => {
  it('shows the privacy policy: title, version and every heading', () => {
    const host = mount(<Legal id="privacidade" />)
    expect(host.querySelector('h1:not(.brand-logo)').textContent).toContain('Política de Privacidade')
    expect(host.textContent).toContain('2026-10-18')
    for (const s of LEGAL_DOCS.privacidade.sections) expect(host.textContent).toContain(s.heading)
  })
  it('shows the terms of use', () => {
    const host = mount(<Legal id="termos" />)
    expect(host.querySelector('h1:not(.brand-logo)').textContent).toContain('Termos de Uso')
  })
})
