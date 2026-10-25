// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleRow } from './GoogleAccount.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Settings → Conta → "Jeitos de entrar" → Google (ISO-1595 §5): linking, unlinking, and the row
   itself. The Capacitor-specific read-only case is its own file (GoogleAccount.mobile.test.jsx)
   — MOBILE is a module-level constant, so nothing here can flip it mid-run. */
const mocks = vi.hoisted(() => ({
  user: null, config: {}, sheets: [], toast: vi.fn(),
  googleLinkStart: vi.fn(), unlinkGoogle: vi.fn(), passkeyAssertion: vi.fn(async () => ({ cid: 'c1', credential: { id: 'k1' } })),
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, config: mocks.config, setUser: vi.fn() })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  googleLinkStart: (...a) => mocks.googleLinkStart(...a), unlinkGoogle: (...a) => mocks.unlinkGoogle(...a),
  webauthnOK: () => true, passkeyAssertion: (...a) => mocks.passkeyAssertion(...a), beginGoogleAuth: vi.fn(),
}))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))

let host, root
beforeEach(() => {
  mocks.user = null; mocks.config = { google_login: true }; mocks.sheets = []
  mocks.toast.mockClear(); mocks.googleLinkStart.mockReset(); mocks.unlinkGoogle.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = el => act(() => root.render(el))
const googleRowEl = () => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === 'Google')
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const byPlaceholder = p => host.querySelector(`input[placeholder="${p}"]`)
const alertText = () => host.querySelector('[role="alert"]')?.textContent || null
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function openRow(passkeysState = { passkeys: [{ id: 'k1' }], password: false }) {
  render(<GoogleRow user={mocks.user} googleOn={!!mocks.config.google_login} passkeysState={passkeysState} />)
  act(() => googleRowEl().click())
  act(() => root.render(mocks.sheets.at(-1)(() => {})))
}

describe('GoogleRow', () => {
  it('vanishes entirely when the instance has no Google configured — linked or not', () => {
    mocks.config = {}
    render(<GoogleRow user={{ google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }} googleOn={false} passkeysState={null} />)
    expect(host.textContent).toBe('')
  })

  it('not linked: "Not linked", opens the link sheet', () => {
    render(<GoogleRow user={null} googleOn passkeysState={null} />)
    expect(host.textContent).toContain('Not linked')
    act(() => googleRowEl().click())
    act(() => root.render(mocks.sheets.at(-1)(() => {})))
    expect(host.querySelector('h3').textContent).toBe('Link Google')
  })

  it('linked: shows the e-mail and the link date', () => {
    mocks.user = { google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }
    render(<GoogleRow user={mocks.user} googleOn passkeysState={{ passkeys: [], password: true }} />)
    expect(host.textContent).toContain('ana@gmail.com')
    expect(host.textContent).toContain('linked')
  })
})

describe('LinkGoogleSheet', () => {
  it('asks for proof, then gets the URL and navigates the whole page to it', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, set href(v) { assign(v) } }, writable: true })
    mocks.googleLinkStart.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/x' })
    mocks.user = null
    openRow()
    type(byPlaceholder('Current password'), 'correct horse battery')
    await act(async () => { button('Continue').click(); await Promise.resolve() })
    expect(mocks.googleLinkStart).toHaveBeenCalledWith({ current: 'correct horse battery' })
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/x')
  })

  it('already-linked (this Google account, a different profile) is said inline, never as a page', async () => {
    mocks.googleLinkStart.mockRejectedValue(Object.assign(new Error('x'), { status: 409, data: { code: 'already-linked' } }))
    mocks.user = null
    openRow()
    await act(async () => { button('Confirm with a passkey').click(); await Promise.resolve() })
    expect(alertText()).toBe('This Google account is already linked to a different profile.')
  })
})

describe('UnlinkGoogleSheet', () => {
  function openUnlink() {
    mocks.user = { google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }
    openRow({ passkeys: [{ id: 'k1' }], password: true })
  }

  it('asks for proof, then unlinks and toasts', async () => {
    mocks.unlinkGoogle.mockResolvedValue({ ok: true })
    openUnlink()
    expect(host.querySelector('h3').textContent).toBe('Unlink Google?')
    expect(host.textContent).toContain('ana@gmail.com')
    type(byPlaceholder('Current password'), 'correct horse battery')
    await act(async () => { button('Unlink Google').click(); await Promise.resolve() })
    expect(mocks.unlinkGoogle).toHaveBeenCalledWith({ current: 'correct horse battery' })
    expect(mocks.toast).toHaveBeenCalledWith('Google unlinked.')
  })

  it('the button is never hidden, even when it is the last way in — the refusal comes as an error on tap', async () => {
    mocks.unlinkGoogle.mockRejectedValue(Object.assign(new Error('x'), { status: 409, data: { code: 'last-way-in' } }))
    openUnlink()
    expect(button('Unlink Google')).toBeTruthy()
    type(byPlaceholder('Current password'), 'correct horse battery')
    await act(async () => { button('Unlink Google').click(); await Promise.resolve() })
    expect(alertText()).toBe('This is the only way into your profile, so it cannot be removed.')
  })
})
