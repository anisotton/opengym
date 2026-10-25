// @vitest-environment happy-dom
// Admin > Payment plans / the ficha's Subscription panel (ISO-1619/ISO-1627). Covers the
// issue's own acceptance criteria that aren't already proven by lib/billing.test.js: the ficha's
// 7 actions are enabled/disabled per what GET /api/admin/user/billing says (never re-derived
// client-side), and a reinforced financial dialog never lets the confirm step appear before its
// preview has loaded, nor before reason/typed-confirmation are both satisfied.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionPanel } from './AdminBilling.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ answers: {}, sheets: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, opts) => {
    const key = path.split('?')[0]
    const entry = mocks.answers[key]
    if (typeof entry === 'function') return entry(opts)
    return key in mocks.answers ? Promise.resolve(entry) : Promise.reject(Object.assign(new Error('not found'), { status: 404, data: {} }))
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Admin', admin: true } })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: render => { mocks.sheets.push(render); return { close: () => {}, lock: () => {} } } })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

// React's controlled inputs ignore a plain `el.value = x` (the element's own "last rendered
// value" tracking swallows it) — the native setter + a real 'input' event is what every other
// sheet test in this repo already uses (e.g. sheets.backfill.test.jsx's own `type`).
function type(el, value) {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const mounted = []
function render(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))

const FICHA_ACTIVE = {
  subscriptions: [{
    id: 'sub_1', userId: 'u1', status: 'active', plan: 'monthly', planDisplay: { 'pt-BR': { name: 'Mensal' } },
    priceId: 'price_1', priceAmountCents: 8900, priceState: 'current', firstPeriod: false, customerId: 'cus_1',
    origin: 'checkout', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-11-25T00:00:00Z', createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z', firstFullCharge: null, lastInvoiceStatus: null, schedule: null,
    scheduledPriceId: null, pauseCollection: null, duplicateOf: null, nextCharge: { date: '2026-11-25T00:00:00Z', amountCents: 8900 }
  }],
  history: [],
  actions: {
    changePlan: { enabled: true }, cancelAtPeriodEnd: { enabled: true }, resumeCancellation: { enabled: false, reason: 'not currently set to cancel' },
    cancelImmediately: { enabled: true }, suspendCollection: { enabled: true }, resumeCollection: { enabled: false, reason: "Billing isn't suspended" },
    generateLink: { enabled: false, reason: 'User already has an active subscription — use \'Switch plan\' instead' }, sync: { enabled: true }
  },
  liveWritesDisabled: false
}

beforeEach(() => {
  mocks.sheets.length = 0
  mocks.answers = {
    '/api/admin/user/billing': FICHA_ACTIVE,
    '/api/admin/billing/catalog': { plans: [{ id: 'monthly', display: { 'pt-BR': { name: 'Mensal' } }, available: true }, { id: 'yearly', display: { 'pt-BR': { name: 'Anual' } }, available: true }], introPrices: [], liveWritesDisabled: false },
    '/api/account/passkeys': { passkeys: [], password: true }
  }
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('SubscriptionPanel: the 7 actions reflect what the ficha says, not a client-side guess', () => {
  it('enables/disables each action exactly per actions{} and shows the disabled reason', async () => {
    const host = render(<SubscriptionPanel userId="u1" />)
    await settle()
    const byLabel = label => [...host.querySelectorAll('button')].find(b => b.textContent === label)

    expect(byLabel('Switch plan').disabled).toBe(false)
    expect(byLabel('Cancel at period end').disabled).toBe(false)
    expect(byLabel('Cancel immediately').disabled).toBe(false)
    expect(byLabel('Suspend billing').disabled).toBe(false)
    expect(byLabel('Sync with Stripe').disabled).toBe(false)

    expect(byLabel('Resume cancellation').disabled).toBe(true)
    expect(byLabel('Resume cancellation').title).toBe('not currently set to cancel')
    expect(byLabel('Resume billing').disabled).toBe(true)
    expect(byLabel('Resume billing').title).toBe("Billing isn't suspended")
    expect(byLabel('Generate link').disabled).toBe(true)
  })

  it('shows the status pill and the "Billing suspended" pill only when pauseCollection is set — the status itself stays active', async () => {
    mocks.answers['/api/admin/user/billing'] = {
      ...FICHA_ACTIVE,
      subscriptions: [{ ...FICHA_ACTIVE.subscriptions[0], pauseCollection: { behavior: 'void' } }]
    }
    const host = render(<SubscriptionPanel userId="u1" />)
    await settle()
    expect(host.textContent).toContain('active')
    expect(host.textContent).toContain('Billing suspended')
  })

  it('renders "No subscription on record" and still shows Generate link enabled when the account never subscribed', async () => {
    mocks.answers['/api/admin/user/billing'] = { subscriptions: [], history: [], actions: {
      changePlan: { enabled: false, reason: 'no subscription yet' }, cancelAtPeriodEnd: { enabled: false, reason: 'no subscription yet' },
      resumeCancellation: { enabled: false, reason: 'no subscription yet' }, cancelImmediately: { enabled: false, reason: 'no subscription yet' },
      suspendCollection: { enabled: false, reason: 'no subscription yet' }, resumeCollection: { enabled: false, reason: 'no subscription yet' },
      generateLink: { enabled: true }, sync: { enabled: false, reason: 'no subscription yet' }
    }, liveWritesDisabled: false }
    const host = render(<SubscriptionPanel userId="u1" />)
    await settle()
    expect(host.textContent).toContain('No subscription on record')
    const byLabel = label => [...host.querySelectorAll('button')].find(b => b.textContent === label)
    expect(byLabel('Generate link').disabled).toBe(false)
    expect(byLabel('Switch plan').disabled).toBe(true)
  })
})

describe('The reinforced confirmation dialog (FinancialConfirmSheet, via "Cancel immediately")', () => {
  const openCancelImmediately = async () => {
    const host = render(<SubscriptionPanel userId="u1" />)
    await settle()
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Cancel immediately')
    act(() => { btn.click() })
    expect(mocks.sheets.length).toBe(1)
    const sheetHost = render(mocks.sheets[0]())
    await settle()
    return sheetHost
  }

  it('shows "Loading preview…" first and disables the reason/confirm fields until the preview resolves', async () => {
    let resolvePreview
    mocks.answers['/api/admin/billing/subscription/preview'] = () => new Promise(r => { resolvePreview = r })
    const sheet = await openCancelImmediately()
    expect(sheet.textContent).toContain('Loading preview…')
    expect(sheet.querySelector('fieldset').disabled).toBe(true)
    await act(async () => { resolvePreview({ ok: true, amountDueCents: 0, currency: 'brl', nextPaymentAttempt: null }); await settle() })
    expect(sheet.textContent).not.toContain('Loading preview…')
    expect(sheet.textContent).toContain('Effective now. No charge today.')
    expect(sheet.querySelector('fieldset').disabled).toBe(false)
  })

  it('never shows an enabled confirm control before reason ≥10 chars AND "CANCEL" are both typed', async () => {
    mocks.answers['/api/admin/billing/subscription/preview'] = { ok: true, amountDueCents: 0, currency: 'brl', nextPaymentAttempt: null }
    const sheet = await openCancelImmediately()
    await settle()
    const textarea = sheet.querySelector('textarea')
    const typedInput = sheet.querySelectorAll('input')[0]
    const confirmBtn = () => [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Cancel immediately')

    // Nothing typed yet: the confirm step is a disabled placeholder, not <ProveOwner>.
    expect(confirmBtn().disabled).toBe(true)

    act(() => type(textarea, 'closing this account down'))
    await settle()
    expect(confirmBtn().disabled).toBe(true) // reason alone is not enough — needs the typed "CANCEL" too

    act(() => type(typedInput, 'CANCEL'))
    await settle()
    // Both satisfied: the admin's own ProveOwner replaces the placeholder (password field appears,
    // since the mocked /api/account/passkeys answers {passkeys:[], password:true}) — it is no
    // longer the disabled placeholder button.
    expect(sheet.querySelector('input[type="password"]')).toBeTruthy()
  })
})
