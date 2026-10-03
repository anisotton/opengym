// Settings → Plan (ISO-1395, spec by Atena in ISO-1392). Its own page, not a sheet — the three
// cards plus the "already subscribed" state are too long for a sheet without scroll-in-scroll or
// cropping the featured card (ISO-1392 §2). Reached from Settings' own "Plan" row and from the
// Stripe redirect itself: api/billing.js's success/cancel URLs point at '/configuracoes' with no
// sub-path, so this route IS /configuracoes, not /settings/plan — matching the already-approved,
// Sentinel-reviewed contract in ISO-1393 rather than the issue's own illustrative path.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { canWriteFromBilling, fmtCentsBRL } from '../lib/billing.js'
import { billingCheckout, billingPortal } from '../lib/api.js'
import { openNeedsEmailPrompt } from '../components/AccountEmail.jsx'
import { useOnline } from '../components/ServerSync.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// The fixed business pricing (Anderson, 30/09 — ISO-1392/ISO-1393), one source for the card
// copy. `amountCents` mirrors api/billing.js's own PLAN_AMOUNT_CENTS, needed only to word the
// "already subscribed" state's next charge when the subscription object itself does not carry it
// (nextChargeAmount from GET /api/billing/status already resolves this server-side; these are
// only for the plan-picker cards, which show the fixed price, never a fetched one).
const PLANS = [
  { id: 'monthly', amountCents: 8900, name: () => t('Monthly'), price: () => t('R$ 89 / month'), equiv: null, badge: null },
  { id: 'quarterly', amountCents: 23700, name: () => t('Quarterly'), price: () => t('R$ 237 every 3 months'), equiv: () => t('Equivalent to R$ {0}/month', '79'), badge: () => t('11% less than the monthly plan') },
  { id: 'yearly', amountCents: 76800, name: () => t('Yearly'), price: () => t('R$ 768 per year'), equiv: () => t('Equivalent to R$ {0}/month', '64'), badge: () => t('28% less than the monthly plan'), featured: true },
]
const planMeta = id => PLANS.find(p => p.id === id) || null
// The server answers a date as a full ISO instant (toIso, api/billing.js) — fmtDate (lib/format.js)
// wants a bare YYYY-MM-DD, the shape every other date in this app is stored in.
const dayOf = iso => (iso ? fmtDate(iso.slice(0, 10), true, true) : '')

export default function SettingsPlan() {
  const nav = useNavigate()
  const loc = useLocation()
  const user = useStore(s => s.user)
  const billing = useStore(s => s.billing)
  const online = useOnline()
  const writable = canWriteFromBilling(billing)
  const hasSub = billing?.status === 'active' || billing?.status === 'past_due'
  const canceledByFailure = billing?.status === 'canceled' && billing?.lastInvoiceStatus === 'failed'

  // Stripe's own redirect (success_url/cancel_url, api/billing.js) — read once, then the query
  // string is dropped (nav replace) so a reload of this page never replays it.
  const [returnKind] = useState(() => new URLSearchParams(loc.search).get('billing'))
  const [confirming, setConfirming] = useState(returnKind === 'sucesso')
  const [confirmTimedOut, setConfirmTimedOut] = useState(false)
  useEffect(() => {
    if (!returnKind) return
    nav('/configuracoes', { replace: true })
    if (returnKind === 'cancelado') {
      useUI.getState().toast(t("Subscription not completed — pick a plan below whenever you're ready."))
    }
  }, []) // eslint-disable-line -- read once, on mount, from the URL Stripe sent us back with

  // The webhook that turns this into 'active' can take a few seconds (ISO-1392 §2.2): poll the
  // small GET, not the whole profile, for up to ~10s before giving up and just letting the
  // person in — the next ordinary refresh (checkRev's own cadence) resolves it either way.
  useEffect(() => {
    if (returnKind !== 'sucesso') return
    let stopped = false
    const deadline = Date.now() + 10000
    const poll = async () => {
      await useStore.getState().refreshBillingStatus()
      if (stopped) return
      const b = useStore.getState().billing
      if (b?.status === 'active' || b?.status === 'past_due') { setConfirming(false); return }
      if (Date.now() >= deadline) { setConfirming(false); setConfirmTimedOut(true); return }
      setTimeout(poll, 1500)
    }
    poll()
    return () => { stopped = true }
  }, [returnKind])

  const [busyPlan, setBusyPlan] = useState(null)
  const [cardError, setCardError] = useState({})
  const subscribe = async id => {
    if (busyPlan || !online) return
    if (user && user.emailVerified === false) { openNeedsEmailPrompt(); return }
    setCardError(e => ({ ...e, [id]: null }))
    setBusyPlan(id)
    try {
      const { url } = await billingCheckout(id)
      window.location.href = url
    } catch (e) {
      setBusyPlan(null)
      if (e?.data?.code === 'email-unverified') { openNeedsEmailPrompt(); return }
      setCardError(prev => ({ ...prev, [id]: t('Could not open payment. Try again.') }))
    }
  }

  const [portalBusy, setPortalBusy] = useState(false)
  const [portalError, setPortalError] = useState(null)
  const openPortal = async () => {
    if (portalBusy) return
    setPortalError(null)
    setPortalBusy(true)
    try {
      const { url } = await billingPortal()
      window.location.href = url
    } catch {
      setPortalBusy(false)
      setPortalError(t('Could not open the management portal. Try again.'))
    }
  }

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{t('Plan')}</h1></div>
    </div>

    {confirming ? (
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="muted">{t('Confirming your subscription…')}</div>
      </div>
    ) : confirmTimedOut && !hasSub ? (
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="muted">{t('Payment received — updating your account.')}</div>
      </div>
    ) : hasSub ? (
      <div className="card">
        {billing.status === 'past_due' && (
          <div className="small" style={{ background: 'color-mix(in srgb,var(--red) 14%,transparent)', color: 'var(--red)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("We couldn't charge your subscription. Update your card to avoid interruption.")}</div>
            <Button size="sm" variant="tinted" disabled={portalBusy} onClick={openPortal}>{t('Update card')}</Button>
          </div>
        )}
        <div className="row between" style={{ marginBottom: 2 }}>
          <div className="lbl2">{t('Current plan')}</div>
        </div>
        <div className="ttl" style={{ fontSize: 20, marginBottom: 10 }}>
          {planMeta(billing.plan)?.name() || billing.plan} · {fmtCentsBRL(billing.nextChargeAmount)}
        </div>
        {billing.firstPeriod ? (
          <div className="small muted" style={{ marginBottom: 14 }}>
            {t('You\'re in your first month, for R$ 1.99. From {0}, billing for the {1} plan (R$ {2}) begins.',
              dayOf(billing.nextChargeDate), planMeta(billing.plan)?.name() || billing.plan, fmtCentsBRL(billing.nextChargeAmount))}
          </div>
        ) : billing.cancelAtPeriodEnd ? (
          <div className="small" style={{ color: 'var(--orange)', marginBottom: 14 }}>
            {t('Cancellation scheduled — your access continues until {0}, with no automatic renewal.', dayOf(billing.nextChargeDate))}
          </div>
        ) : (
          <div className="small muted" style={{ marginBottom: 14 }}>
            {t('Next charge')}: {dayOf(billing.nextChargeDate)} · {fmtCentsBRL(billing.nextChargeAmount)}
          </div>
        )}
        <Button variant="primary" disabled={portalBusy} onClick={openPortal}>{t('Manage subscription')}</Button>
        {portalError && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{portalError}</div>}
      </div>
    ) : (
      <>
        {canceledByFailure && (
          <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{t('Subscription canceled due to a payment failure')}</div>
        )}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="ttl" style={{ fontSize: 18, marginBottom: 4 }}>{t('Your first month for R$ 1.99.')}</div>
          <div className="small muted">{t('Then you continue on the plan you choose. Cancel anytime, right in the app.')}</div>
        </div>
        {!online && (
          <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
            {t("You're offline — subscribe again once you're back online.")}
          </div>
        )}
        {PLANS.map(p => (
          <div key={p.id} className="card" style={{ marginBottom: 12, opacity: busyPlan && busyPlan !== p.id ? 0.5 : 1, ...(p.featured ? { borderColor: 'var(--acc)', borderWidth: 2, borderStyle: 'solid' } : {}) }}>
            <div className="row between" style={{ marginBottom: 4 }}>
              <div className="ttl">{p.name()}</div>
              {p.featured && <span className="tag acc">{t('Lowest price per month')}</span>}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{p.price()}</div>
            {p.equiv && <div className="small muted">{p.equiv()}</div>}
            {p.badge && <div className="small" style={{ color: 'var(--green)' }}>{p.badge()}</div>}
            <div style={{ marginTop: 10 }}>
              <Button variant="primary" disabled={!online || !!busyPlan} aria-label={t('Subscribe to {0}', p.name())} onClick={() => subscribe(p.id)}>{t('Subscribe')}</Button>
            </div>
            {cardError[p.id] && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{cardError[p.id]}</div>}
          </div>
        ))}
      </>
    )}
  </div>
}

// Shared with Home's past_due banner (ISO-1392 §4) — one implementation of "open the Portal",
// same redirect, same failure as the button above.
export async function openManagePortal() {
  const { url } = await billingPortal()
  window.location.href = url
}
