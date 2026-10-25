// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleRow } from './GoogleAccount.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ISO-1595 §5: Google refuses OAuth inside a WebView (docs/MOBILE.md), so neither linking nor
   unlinking can run on the Capacitor build — an unlinked profile has nothing to show there; one
   already linked still gets to see it, read-only. A separate file because MOBILE is read once at
   module load — nothing here can flip it mid-run. */
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: null, config: { google_login: true }, setUser: vi.fn() })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: () => ({}) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ googleLinkStart: vi.fn(), unlinkGoogle: vi.fn(), webauthnOK: () => true, passkeyAssertion: vi.fn(), beginGoogleAuth: vi.fn() }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: true }))

let host, root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('GoogleRow on the Capacitor build (MOBILE)', () => {
  it('not linked: hidden entirely', () => {
    act(() => root.render(<GoogleRow user={null} googleOn passkeysState={null} />))
    expect(host.textContent).toBe('')
  })

  it('already linked: shown read-only, no chevron, no click handler', () => {
    const user = { google: { email: 'ana@gmail.com', linkedAt: '2026-10-18T00:00:00.000Z' } }
    act(() => root.render(<GoogleRow user={user} googleOn passkeysState={{ passkeys: [], password: false }} />))
    expect(host.textContent).toContain('ana@gmail.com')
    expect(host.querySelector('button')).toBeNull()
  })
})
