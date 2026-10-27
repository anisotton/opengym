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
import { t, getLang } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { canWriteFromBilling, fmtCentsBRL, monthlyEquivalentCents, savingsPercentVsMonthly } from '../lib/billing.js'
import { billingCheckout, billingPortal } from '../lib/api.js'
import { openNeedsEmailPrompt } from '../components/AccountEmail.jsx'
import { openTermsSheet } from '../components/TermsSheet.jsx'
import { useOnline } from '../components/ServerSync.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// The catalog itself (ISO-1619/ISO-1627) replaces the fixed PLANS array that used to live here —
// name, price, periodicity and the once-per-account intro all come from GET /api/billing/plans
// (useStore's own offline cache, refreshBillingPlans) now, never hard-coded. `display` only ever
// has 'pt-BR' (required) and, optionally, 'en' (Admin > Payment plans §1.2) — any other active
// language falls back to 'pt-BR', same as a plan with no description at all falls back to a
// fixed string below.
const nameOf = d => d?.[getLang()]?.name || d?.['pt-BR']?.name || d?.en?.name || ''
const descOf = d => d?.[getLang()]?.description || d?.['pt-BR']?.description || d?.en?.description || null
// "89,00", never a locale-formatted number — the reais digits are the same for every reader
// regardless of UI language (lib/billing.js's own fmtCentsBRL comment), only the words around
// them translate.
const centsStr = cents => (cents / 100).toFixed(2).replace('.', ',')
const periodText = p => p.interval === 'year' ? t('R$ {0} per year', centsStr(p.amountCents))
  : p.intervalCount === 1 ? t('R$ {0} / month', centsStr(p.amountCents))
    : t('R$ {0} every {1} months', centsStr(p.amountCents), p.intervalCount)
// The server answers a date as a full ISO instant (toIso, api/billing.js) — fmtDate (lib/format.js)
// wants a bare YYYY-MM-DD, the shape every other date in this app is stored in.
const dayOf = iso => (iso ? fmtDate(iso.slice(0, 10), true, true) : '')

export default function SettingsPlan() {
  const nav = useNavigate()
  const loc = useLocation()
  const user = useStore(s => s.user)
  const billing = useStore(s => s.billing)
  const billingPlans = useStore(s => s.billingPlans)
  const online = useOnline()
  const writable = canWriteFromBilling(billing)
  const hasSub = billing?.status === 'active' || billing?.status === 'past_due'
  const canceledByFailure = billing?.status === 'canceled' && billing?.lastInvoiceStatus === 'failed'

  // "Erro" (UX spec §4.2) is a toast, not a replacing error screen — whatever was already
  // cached (loadBillingPlans, useStore) keeps showing, same rule refreshBillingStatus follows.
  useEffect(() => {
    useStore.getState().refreshBillingPlans().then(ok => { if (!ok) useUI.getState().toast(t('Could not load plans. Try again.')) })
  }, [])
  const plans = [...(billingPlans?.plans || [])].sort((a, b) => a.sortOrder - b.sortOrder)
  const monthly = plans.find(p => p.interval === 'month' && p.intervalCount === 1)
  // "Lowest price per month" (the old, hard-coded yearly-only badge) is now whichever plan's own
  // monthly-equivalent is actually the cheapest — the catalog's order/ids are admin-controlled now,
  // never assumed to be 'monthly'/'quarterly'/'yearly'.
  const equivOf = p => monthlyEquivalentCents(p.amountCents, p.interval, p.intervalCount)
  const cheapestId = plans.length > 1 ? plans.reduce((a, b) => (equivOf(b) < equivOf(a) ? b : a), plans[0]).id : null
  const introPlan = plans.find(p => p.introAmountCents != null)
  // The account's own current plan, resolved by id against the catalog — same graceful
  // degradation the old PLANS lookup already had (shows the raw id if the plan is no longer in
  // the `available` catalog, e.g. retired/deactivated after this account subscribed to it).
  const currentPlan = plans.find(p => p.id === billing?.plan)
  const currentPlanName = currentPlan ? nameOf(currentPlan.display) : (billing?.plan || '')
  // The once-per-account intro price is shared across every plan that offers one (api/billing.js:
  // "o intro compartilhado"), so this account's own first-period amount is whichever plan's own
  // `introAmountCents` resolves — its current plan's, if that is still in the `available`
  // catalog, else any other plan's (they all point at the same Price). `null` only on an instance
  // whose catalog has no intro price configured at all — the firstPeriod message below still
  // reads fine without a number in that case, never a stale or invented one.
  const introAmountCents = currentPlan?.introAmountCents ?? introPlan?.introAmountCents ?? null

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
      // Terms changed since this account accepted: the sheet is the answer, not a card error.
      if (e?.data?.code === 'terms-required') { openTermsSheet(); return }
      if (e?.data?.code === 'email-unverified') { openNeedsEmailPrompt(); return }
      // Two tabs, or a webhook that landed between this screen's last refresh and the click
      // (api/server.js's own 409 `already-subscribed`, ISO-1623 §5.4): there is nothing new to
      // sell here — the Portal is where an existing subscription is actually managed.
      if (e?.status === 409 && e?.data?.code === 'already-subscribed') { openPortal(); return }
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
      <button className="iconbtn" data-back="/settings" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="chevronLeft" /></button>
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
          {currentPlanName} · {fmtCentsBRL(billing.nextChargeAmount)}
        </div>
        {billing.firstPeriod ? (
          <div className="small muted" style={{ marginBottom: 14 }}>
            {introAmountCents != null
              ? t("You're in your first month, for R$ {0}. From {1}, billing for the {2} plan ({3}) begins.",
                centsStr(introAmountCents), dayOf(billing.nextChargeDate), currentPlanName, fmtCentsBRL(billing.nextChargeAmount))
              : t("You're in your first month. From {0}, billing for the {1} plan ({2}) begins.",
                dayOf(billing.nextChargeDate), currentPlanName, fmtCentsBRL(billing.nextChargeAmount))}
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
        {introPlan && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="ttl" style={{ fontSize: 18, marginBottom: 4 }}>{t('Your first month for R$ {0}.', centsStr(introPlan.introAmountCents))}</div>
            <div className="small muted">{t('Then you continue on the plan you choose. Cancel anytime, right in the app.')}</div>
          </div>
        )}
        {!online && (
          <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
            {t("You're offline — subscribe again once you're back online.")}
          </div>
        )}
        {!billingPlans ? (
          <div className="card" style={{ textAlign: 'center' }}><div className="muted">{t('Loading plans…')}</div></div>
        ) : !plans.length ? (
          <div className="card" style={{ textAlign: 'center' }}><div className="muted">{t('No plans available right now. Check back later.')}</div></div>
        ) : plans.map(p => {
          const equivCents = monthly ? equivOf(p) : null
          const savings = monthly && p.id !== monthly.id ? savingsPercentVsMonthly(equivCents, monthly.amountCents) : null
          const featured = p.id === cheapestId
          return <div key={p.id} className="card" style={{ marginBottom: 12, opacity: busyPlan && busyPlan !== p.id ? 0.5 : 1, ...(featured ? { borderColor: 'var(--acc)', borderWidth: 2, borderStyle: 'solid' } : {}) }}>
            <div className="row between" style={{ marginBottom: 4 }}>
              <div className="ttl">{nameOf(p.display)}</div>
              {featured && <span className="tag acc">{t('Lowest price per month')}</span>}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{periodText(p)}</div>
            {equivCents != null && p.id !== monthly.id && <div className="small muted">{t('Equivalent to R$ {0}/month', centsStr(equivCents))}</div>}
            {savings != null && savings > 0 && <div className="small" style={{ color: 'var(--green)' }}>{t('{0}% less than the monthly plan', String(savings))}</div>}
            <div className="small muted" style={{ marginTop: 4 }}>{descOf(p.display) || t('Includes everything Brilhart Fitness offers.')}</div>
            <div style={{ marginTop: 10 }}>
              <Button variant="primary" disabled={!online || !!busyPlan} aria-label={t('Subscribe to {0}', nameOf(p.display))} onClick={() => subscribe(p.id)}>{t('Subscribe')}</Button>
            </div>
            {cardError[p.id] && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{cardError[p.id]}</div>}
          </div>
        })}
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
