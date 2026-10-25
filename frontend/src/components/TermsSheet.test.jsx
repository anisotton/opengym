// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The locked "we updated our terms" sheet (ISO-1390): accepting sends the bundle's own
   LEGAL_VERSION and clears needsTerms; a stale version asks for an app update instead of looping
   on a refused accept; a network failure says so and keeps the sheet up. */
const mocks = vi.hoisted(() => {
  const state = { config: {}, user: { id: 'u1', name: 'Ana', needsTerms: true } }
  state.setUser = vi.fn()
  state.sessionRefused = vi.fn()
  state.termsAccept = vi.fn()
  state.openLegalSheet = vi.fn()
  state.snapshot = () => ({ config: state.config, user: state.user, setUser: state.setUser, sessionRefused: state.sessionRefused })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ termsAccept: (...a) => mocks.termsAccept(...a) }))
vi.mock('./LegalText.jsx', () => ({ openLegalSheet: (...a) => mocks.openLegalSheet(...a) }))

const { TermsSheet } = await import('./TermsSheet.jsx')

const fail = (status, data) => Object.assign(new Error('HTTP ' + status), { status, data })
const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const click = async (host, text) => { act(() => button(host, text).click()); await settle() }

beforeEach(() => {
  mocks.config = {}
  mocks.user = { id: 'u1', name: 'Ana', needsTerms: true }
  mocks.setUser.mockClear()
  mocks.sessionRefused.mockClear()
  mocks.termsAccept.mockReset()
  mocks.openLegalSheet.mockClear()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('TermsSheet', () => {
  it('shows the title, both document links and the accept button, and no way to close', async () => {
    const host = mount(<TermsSheet close={vi.fn()} />)
    expect(host.querySelector('h3').textContent).toBe('We updated our terms')
    expect(button(host, 'Accept and continue')).toBeTruthy()
    expect(button(host, 'Close')).toBeUndefined()
    await click(host, 'Read the Terms of Use')
    await click(host, 'Read the Privacy Policy')
    expect(mocks.openLegalSheet.mock.calls).toEqual([['termos'], ['privacidade']])
  })

  it('accepting sends LEGAL_VERSION, clears needsTerms and closes', async () => {
    mocks.termsAccept.mockResolvedValue({ ok: true, termsVersion: '2026-10-18', termsAcceptedAt: '2026-10-17T12:00:00.000Z' })
    const close = vi.fn()
    const host = mount(<TermsSheet close={close} />)
    await click(host, 'Accept and continue')
    expect(mocks.termsAccept).toHaveBeenCalledWith('2026-10-18')
    expect(mocks.setUser).toHaveBeenCalledWith({ id: 'u1', name: 'Ana', needsTerms: false, termsVersion: '2026-10-18', termsAcceptedAt: '2026-10-17T12:00:00.000Z' })
    expect(close).toHaveBeenCalled()
  })

  it('a stale version asks for an app update, with Reload on the web, and stays open', async () => {
    mocks.termsAccept.mockRejectedValue(fail(400, { code: 'terms-version-stale' }))
    const close = vi.fn()
    const host = mount(<TermsSheet close={close} />)
    await click(host, 'Accept and continue')
    expect(host.textContent).toContain('Update the app to accept the new terms.')
    expect(button(host, 'Reload')).toBeTruthy()
    expect(button(host, 'Accept and continue')).toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('a network failure shows an alert and keeps the sheet open', async () => {
    mocks.termsAccept.mockRejectedValue(fail(0))
    const close = vi.fn()
    const host = mount(<TermsSheet close={close} />)
    await click(host, 'Accept and continue')
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Could not save your acceptance/)
    expect(button(host, 'Accept and continue')).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
  })

  // A dead session must not leave a locked sheet with an Accept that can never land.
  it('a 401 closes the sheet and takes the store\'s revoked-session path', async () => {
    const e = fail(401)
    mocks.termsAccept.mockRejectedValue(e)
    const close = vi.fn()
    const host = mount(<TermsSheet close={close} />)
    await click(host, 'Accept and continue')
    expect(close).toHaveBeenCalled()
    expect(mocks.sessionRefused).toHaveBeenCalledWith(e)
    expect(mocks.setUser).not.toHaveBeenCalled()
  })

  it('a server error keeps the sheet open with the alert, signed in', async () => {
    mocks.termsAccept.mockRejectedValue(fail(500))
    const close = vi.fn()
    const host = mount(<TermsSheet close={close} />)
    await click(host, 'Accept and continue')
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Could not save your acceptance/)
    expect(close).not.toHaveBeenCalled()
    expect(mocks.sessionRefused).not.toHaveBeenCalled()
  })

  it('starts stale when the server already announces a newer legal_version', () => {
    mocks.config = { legal_version: '2027-01-01' }
    const host = mount(<TermsSheet close={vi.fn()} />)
    expect(host.textContent).toContain('Update the app to accept the new terms.')
    expect(button(host, 'Accept and continue')).toBeUndefined()
  })
})
