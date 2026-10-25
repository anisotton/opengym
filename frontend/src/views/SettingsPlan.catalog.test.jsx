// @vitest-environment happy-dom
// SettingsPlan reads GET /api/billing/plans (useStore's billingPlans cache) instead of the old
// fixed PLANS array (ISO-1619/ISO-1627). "Only available plans" is the server's own job
// (getAvailablePlans, api/store.js — already covered by T1a's test:pg suite); this covers what
// the client controls: it renders exactly what the catalog hands it, with no plan, price or
// periodicity left hard-coded, and the computed equivalent/savings badges.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ state: null }))
vi.mock('../store/useStore.js', () => {
  const useStore = selector => (selector ? selector(mocks.state) : mocks.state)
  useStore.getState = () => mocks.state
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: () => {} })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, useLocation: () => ({ search: '' }) }))
vi.mock('../lib/api.js', () => ({ billingCheckout: vi.fn(), billingPortal: vi.fn() }))
vi.mock('../components/AccountEmail.jsx', () => ({ openNeedsEmailPrompt: vi.fn() }))
vi.mock('../components/TermsSheet.jsx', () => ({ openTermsSheet: vi.fn() }))
vi.mock('../components/ServerSync.jsx', () => ({ useOnline: () => true }))

const { default: SettingsPlan } = await import('./SettingsPlan.jsx')

const CATALOG = {
  plans: [
    { id: 'monthly', display: { 'pt-BR': { name: 'Mensal' } }, interval: 'month', intervalCount: 1, sortOrder: 1, amountCents: 8900, introAmountCents: 199 },
    { id: 'quarterly', display: { 'pt-BR': { name: 'Trimestral', badge: '11% off' } }, interval: 'month', intervalCount: 3, sortOrder: 2, amountCents: 23700, introAmountCents: null },
    { id: 'yearly', display: { 'pt-BR': { name: 'Anual', description: 'Melhor valor' } }, interval: 'year', intervalCount: 1, sortOrder: 3, amountCents: 76800, introAmountCents: null }
  ]
}

let host, root
function mountWith(state) {
  mocks.state = { user: { id: 'u' }, billing: null, billingPlans: state, refreshBillingPlans: vi.fn(() => Promise.resolve(true)) }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<SettingsPlan />))
}
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('SettingsPlan renders from the catalog, never the old hard-coded PLANS', () => {
  it('shows exactly the plans the catalog returned, in sortOrder, with no fixed R$ string anywhere', () => {
    mountWith(CATALOG)
    // Scoped to the plan cards' own row (`.row.between .ttl`) — the intro teaser card above them
    // has a `.ttl` of its own too, with no plan name in it.
    const titles = [...host.querySelectorAll('.row.between .ttl')].map(t => t.textContent)
    expect(titles).toEqual(['Mensal', 'Trimestral', 'Anual'])
    // The old fixed strings this replaces must be gone — only the parameterized ones remain.
    expect(host.textContent).not.toContain('R$ 89 / month')
    expect(host.textContent).not.toContain('R$ 237 every 3 months')
    expect(host.textContent).not.toContain('R$ 768 per year')
    expect(host.textContent).toContain('R$ 89,00 / month')
    expect(host.textContent).toContain('R$ 237,00 every 3 months')
    expect(host.textContent).toContain('R$ 768,00 per year')
  })

  it('computes the equivalent-per-month and savings badges from cents, never from a fixed percentage', () => {
    mountWith(CATALOG)
    // quarterly: 23700/3 = 7900 -> "R$ 79,00/month", 11% less than the 8900 monthly baseline.
    expect(host.textContent).toContain('Equivalent to R$ 79,00/month')
    expect(host.textContent).toContain('11% less than the monthly plan')
    // yearly: 76800/12 = 6400 -> "R$ 64,00/month", 28% less, and it is the featured (cheapest) card.
    expect(host.textContent).toContain('Equivalent to R$ 64,00/month')
    expect(host.textContent).toContain('28% less than the monthly plan')
    expect(host.textContent).toContain('Lowest price per month')
  })

  it('falls back to the fixed-copy description when a plan has none, and shows its own when it does', () => {
    mountWith(CATALOG)
    expect(host.textContent).toContain('Melhor valor') // yearly's own description
    expect(host.textContent).toContain('Includes everything Brilhart Fitness offers.') // monthly/quarterly have none
  })

  it('the once-per-account intro teaser uses the catalog\'s own intro price, not a fixed "R$ 1.99"', () => {
    mountWith(CATALOG)
    expect(host.textContent).toContain('Your first month for R$ 1,99.')
  })

  it('shows "Loading plans…" before the catalog has ever answered, and the empty state once it answers empty', () => {
    mountWith(null)
    expect(host.textContent).toContain('Loading plans…')
    mountWith({ plans: [] })
    expect(host.textContent).toContain('No plans available right now. Check back later.')
  })
})
