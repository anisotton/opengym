// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Checkout refused for terms (ISO-1390): the server's `terms-required` opens the terms sheet and
// shows no card error; `email-unverified` still opens the e-mail prompt.
const mocks = vi.hoisted(() => ({
  billingCheckout: null, openTermsSheet: null, openNeedsEmailPrompt: null,
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'u', name: 'A', emailVerified: true }, billing: { status: 'none' }, refreshBillingStatus: vi.fn() })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, useLocation: () => ({ search: '' }) }))
vi.mock('../lib/api.js', () => ({ billingCheckout: (...a) => mocks.billingCheckout(...a), billingPortal: vi.fn() }))
vi.mock('../components/AccountEmail.jsx', () => ({ openNeedsEmailPrompt: (...a) => mocks.openNeedsEmailPrompt(...a) }))
vi.mock('../components/TermsSheet.jsx', () => ({ openTermsSheet: (...a) => mocks.openTermsSheet(...a) }))
vi.mock('../components/ServerSync.jsx', () => ({ useOnline: () => true }))

const { default: SettingsPlan } = await import('./SettingsPlan.jsx')

let host, root
beforeEach(() => {
  mocks.openTermsSheet = vi.fn()
  mocks.openNeedsEmailPrompt = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<SettingsPlan />))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const subscribe = async () => {
  const b = host.querySelector('button[aria-label^="Subscribe to"]')
  await act(async () => { b.click() })
}
const refuse = code => { mocks.billingCheckout = vi.fn(() => Promise.reject(Object.assign(new Error(code), { status: 403, data: { code } }))) }

describe('SettingsPlan checkout refusals', () => {
  it('terms-required opens the terms sheet and shows no card error', async () => {
    refuse('terms-required')
    await subscribe()
    expect(mocks.openTermsSheet).toHaveBeenCalledTimes(1)
    expect(mocks.openNeedsEmailPrompt).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Could not open payment')
  })

  it('email-unverified still opens the e-mail prompt', async () => {
    refuse('email-unverified')
    await subscribe()
    expect(mocks.openNeedsEmailPrompt).toHaveBeenCalledTimes(1)
    expect(mocks.openTermsSheet).not.toHaveBeenCalled()
  })
})
