import { useEffect, useRef, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate } from '../lib/format.js'
import { fmtCentsBRL, parseCentsBRL } from '../lib/billing.js'
import Icon from '../components/Icon.jsx'
import { Button, TextField, TextArea, Switch } from '../components/ui.jsx'
import { ProveOwner } from '../components/PasswordAuth.jsx'
import { usePasskeys } from '../components/Passkeys.jsx'

// Admin > Payment plans (ISO-1619/ISO-1627) — the commercial catalog sold on Stripe, kept
// visually and operationally distinct from Training programs (ISO-1485, AdminPrograms.jsx).
// Deliberately English-only, same convention as the rest of this dashboard (Admin.jsx's own
// note, confirmed for this frente by the UX spec's §0) — no t()/locale entries in this file.

const nameOf = d => d?.['pt-BR']?.name || d?.en?.name || '(untitled)'
const periodOf = (interval, count) => interval === 'year' ? '/ year' : count === 1 ? '/ month' : `/ ${count} months`
const dayOf = iso => (iso ? fmtDate(iso.slice(0, 10), true, true) : '–')
const uuid = () => crypto.randomUUID()

// A plan's own id is a Stripe-safe slug (api/billing.js validPlanId: ^[a-z][a-z0-9-]{1,39}$),
// derived from its Portuguese name rather than typed by hand — the UX spec's own create form
// (§1.2) has no id field at all. A clash (another plan already has this slug) is reported by the
// server as `id-taken`; the admin's own fix is to vary the name slightly, same as a program title
// clash already works (AdminPrograms.jsx).
function slugify(name) {
  const s = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return /^[a-z]/.test(s) ? s : 'p-' + s
}

// The admin's own reauth state (passkey/password), same hook Settings already uses — this is the
// ADMIN proving themselves, not the account being administered.
function useOwnProveOwnerState() {
  const { st } = usePasskeys(true)
  return st
}

// POST wrapper for every billing-admin write below: never throws for a server-answered refusal
// (4xx/409/422/423, or the 202 "action-unknown" — still `r.ok`, so lib/api.js's own exchange()
// resolves it rather than rejecting) — both land here as `{error, code, current?}`, same shape the
// server itself uses, so every sheet below can branch on `.code` alone regardless of which path
// produced it. A genuine network/parse failure (no `.data`) still surfaces as `{error, code:null}`.
async function post(path, body, headers) {
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(body), ...(headers ? { headers } : {}) })
    return r
  } catch (e) {
    return { error: e.message, code: e.data?.code || null, current: e.data?.current || null }
  }
}

/* ============================================================== reusable confirmation pieces */

// Reason (≥10 chars, api/billing.js adminReason's own rule) + the admin's own ProveOwner — the
// footer shared by every catalog write that is financial but never asks for typed confirmation
// (criar oferta, nova versão de valor, ativar/desativar oferta — plan §4/§7). The proof itself
// finishes the action; there is no separate "Save" once it appears, same two-step shape
// DeleteAccount.jsx's own ProveOwner already uses elsewhere in the app.
function ReasonProveOwnerFooter({ passkeysState, reason, setReason, submitLabel, danger, error, onConfirm }) {
  const ok = reason.trim().length >= 10
  return <>
    <div className="adm-field">
      <label>Reason (kept in the audit trail)</label>
      <TextArea value={reason} maxLength={500} rows={2} onChange={e => setReason(e.target.value)} />
      <div className="muted small" style={{ textAlign: 'end' }}>{Math.min(reason.trim().length, 10)}/10 min</div>
    </div>
    {error && <div className="adm-result bad">{error}</div>}
    {ok && passkeysState
      ? <ProveOwner passkey={passkeysState.passkeys.length > 0} password={passkeysState.password} danger={danger}
        submitText={submitLabel} onProof={onConfirm} />
      : <button className={'btn ' + (danger ? 'danger' : 'primary')} disabled>{submitLabel}</button>}
  </>
}

// The reinforced confirmation (UX spec §3): publishing a price version, and every subscription
// action that touches money or when/whether it is charged. Preview first (never computed
// locally for a subscription action — always `.../preview`; a catalog publish has no invoice to
// preview, so `loadPreview` is omitted there and `staticPreviewText` is shown instead), then
// reason, then (for the four actions with new money or a new price in play) typed confirmation,
// then the admin's own proof — in that order, so nothing after the preview can be skipped past it.
function FinancialConfirmSheet({
  title, loadPreview, staticPreviewText, needsTypedConfirm, typedLabel, typedExpected,
  needsProveOwner, passkeysState, danger, confirmLabel, submit, onSuccess, onReload, close, lockSheet
}) {
  const toast = useUI(s => s.toast)
  // Generated once, when the dialog opens — the same key backs every retry of this one
  // confirmation (a dropped response, a Stripe-rejected attempt the admin fixes and resubmits),
  // never a fresh one per click, or the server's own idempotency claim would treat each click as
  // an unrelated action instead of a safe replay/retry.
  const [idempotencyKey] = useState(uuid)
  const [previewText, setPreviewText] = useState(staticPreviewText || null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)   // {current} | true (stale / stale-after-stripe)
  const [blocked, setBlocked] = useState(false)     // 423 raced in after the button itself was enabled
  const [checking, setChecking] = useState(false)   // "verificando com a Stripe" — locks the sheet
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { lockSheet?.(true) }, []) // eslint-disable-line -- a reinforced confirm is always locked: no accidental backdrop/Esc dismiss once it is open, same reasoning as the "verificando" state below
  useEffect(() => {
    if (!loadPreview) return
    loadPreview().then(text => { if (live.current) setPreviewText(text) })
      .catch(() => { if (live.current) setPreviewFailed(true) })
  }, []) // eslint-disable-line -- once, on open

  const reasonOk = reason.trim().length >= 10
  const typedOk = !needsTypedConfirm || typed.trim() === typedExpected
  const ready = reasonOk && typedOk && previewText != null && !checking

  const doSubmit = async proof => {
    setChecking(true); setError(null)
    const result = await submit({ reason: reason.trim(), idempotencyKey, ...(proof || {}) })
    if (!live.current) return
    if (result?.ok) {
      setChecking(false); lockSheet?.(false); close(); onSuccess?.()
      return
    }
    const code = result?.code
    if (code === 'stale' || code === 'stale-after-stripe') { setChecking(false); setConflict(result.current || true); return }
    if (code === 'live-writes-disabled') { setChecking(false); setBlocked(true); return }
    if (code === 'action-unknown') {
      setChecking(false); lockSheet?.(false); close()
      toast("Stripe didn't confirm in time — checked the latest state directly.")
      onReload?.()
      return
    }
    // stripe-rejected / action-failed / anything else: Stripe's own message (never the raw body
    // or the key) stays on screen, fields intact, same Idempotency-Key safe to retry.
    setChecking(false)
    setError(result?.error || 'Something went wrong.')
  }

  const reload = () => { lockSheet?.(false); close(); onReload?.() }

  if (blocked) return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>Live writes are disabled</h3>
    <div className="muted" style={{ marginBottom: 18 }}>This instance's Stripe key is live and BILLING_ADMIN_LIVE is not set — nothing was changed.</div>
    <Button variant="ghost" className="dim" onClick={() => { lockSheet?.(false); close() }}>Close</Button>
  </div>

  if (conflict) return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>Changed since you opened this</h3>
    <div className="muted" style={{ marginBottom: 18 }}>Reload to see the latest before trying again.</div>
    <button className="btn primary" onClick={reload}>Reload</button>
  </div>

  return <>
    <h3>{title}</h3>
    <div className="adm-result" style={{ marginBottom: 12 }}>
      {previewFailed ? <span style={{ color: 'var(--red)' }}>Could not load the preview — try again.</span>
        : previewText == null ? 'Loading preview…' : previewText}
    </div>
    <fieldset disabled={previewText == null} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="adm-field">
        <label>Reason (kept in the audit trail)</label>
        <TextArea value={reason} maxLength={500} rows={2} onChange={e => setReason(e.target.value)} />
        <div className="muted small" style={{ textAlign: 'end' }}>{Math.min(reason.trim().length, 10)}/10 min</div>
      </div>
      {needsTypedConfirm && <div className="adm-field">
        <label>{typedLabel}</label>
        <TextField value={typed} onChange={e => setTyped(e.target.value)} />
      </div>}
    </fieldset>
    {error && <div className="adm-result bad">{error}</div>}
    {checking
      ? <button className="btn primary" disabled>Checking with Stripe…</button>
      : needsProveOwner
        // Never falls through to the plain button below while proveOwner is required: a button
        // that submitted with no proof the instant `ready` went true, just because the admin's
        // own passkey/password state (usePasskeys) hadn't answered yet, would reach the server
        // with nothing to prove — a confusing 403, not a missing step.
        ? (ready && passkeysState
          ? <ProveOwner passkey={passkeysState.passkeys.length > 0} password={passkeysState.password} danger={danger}
            submitText={confirmLabel} onProof={doSubmit} />
          : <button className={'btn ' + (danger ? 'danger' : 'primary')} disabled>{confirmLabel}</button>)
        : <button className={'btn ' + (danger ? 'danger' : 'primary')} disabled={!ready} onClick={() => doSubmit(null)}>{confirmLabel}</button>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" disabled={checking} onClick={() => { lockSheet?.(false); close() }}>Cancel</Button>
  </>
}

/* ============================================================================ catalog (item 1) */

function StatePill({ state }) {
  if (state === 'current') return <span className="adm-pill ok">Current</span>
  if (state === 'draft') return <span className="adm-pill acc">Draft</span>
  return <span className="adm-pill dim">Retired</span>
}

// "Nova versão de valor" (§1.3) — unitAmount in, draft Price out. No typed confirm, no preview;
// reason + proveOwner only (plan §4).
function NewPriceVersionForm({ plan, passkeysState, liveWritesDisabled, onDone }) {
  const toast = useUI(s => s.toast)
  const [open, setOpen] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const cents = parseCentsBRL(amount)
  if (!open) return <Button size="sm" disabled={liveWritesDisabled} onClick={() => { setOpen(true); setIdempotencyKey(uuid()) }} title={liveWritesDisabled ? 'Live writes are disabled on this instance' : undefined}>New price version</Button>
  const confirm = async proof => {
    setError(null)
    const r = await post('/api/admin/billing/catalog/plan/price',
      { planId: plan.id, unitAmount: cents, reason: reason.trim(), ...proof },
      { 'Idempotency-Key': idempotencyKey })
    if (r.error) { setError(r.error); return }
    toast('New draft price created'); setOpen(false); setAmount(''); setReason(''); onDone()
  }
  return <div className="adm-field" style={{ background: 'var(--surface-2)', borderRadius: 10, padding: 10 }}>
    <label>Amount (R$)</label>
    <TextField value={amount} placeholder="0,00" onChange={e => setAmount(e.target.value)} />
    {amount && cents == null && <div className="adm-hint" style={{ color: 'var(--red)' }}>Enter a value between R$1,00 and R$10.000,00</div>}
    <ReasonProveOwnerFooter passkeysState={passkeysState} reason={reason} setReason={setReason}
      submitLabel="Create draft price" error={error}
      onConfirm={cents != null ? confirm : () => {}} />
    <div style={{ height: 6 }} />
    <Button variant="ghost" className="dim" onClick={() => { setOpen(false); setError(null) }}>Cancel</Button>
  </div>
}

function PlanPricing({ plan, passkeysState, liveWritesDisabled, onDone }) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const prices = [...plan.prices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const publish = price => {
    let handle
    handle = openSheet(close => <FinancialConfirmSheet
      title="Publish price version" lockSheet={v => handle.lock(v)} close={close}
      staticPreviewText={`New subscriptions will be charged ${fmtCentsBRL(price.unitAmount)}${periodOf(price.interval, price.intervalCount)} starting now. ${plan.prices.find(p => p.id === plan.currentPriceId)?.subscriptionCount ?? 0} subscriber(s) currently on ${plan.currentPriceId ? fmtCentsBRL(plan.prices.find(p => p.id === plan.currentPriceId)?.unitAmount) : 'the current price'} keep paying the same — publishing never changes what an existing subscriber pays.`}
      needsTypedConfirm typedLabel={`Type ${fmtCentsBRL(price.unitAmount).replace('R$ ', '')} to publish`}
      typedExpected={fmtCentsBRL(price.unitAmount).replace('R$ ', '')}
      needsProveOwner passkeysState={passkeysState} confirmLabel="Publish"
      submit={({ reason, idempotencyKey, ...proof }) => post('/api/admin/billing/catalog/plan/publish',
        { planId: plan.id, priceId: price.id, version: plan.version, reason, ...proof },
        { 'Idempotency-Key': idempotencyKey })}
      onSuccess={() => { toast('Published'); onDone() }} onReload={onDone}
    />)
  }
  return <>
    <h4 className="sec">Pricing</h4>
    <div className="list" style={{ marginBottom: 10 }}>
      {prices.map(p => <div key={p.id} className="row between" style={{ padding: '8px 2px', borderBottom: 'var(--hair) solid var(--sep)' }}>
        <div>
          <div className="small" style={{ fontWeight: 600 }}>{fmtCentsBRL(p.unitAmount)}{periodOf(p.interval, p.intervalCount)} <StatePill state={p.state} /></div>
          <div className="dim" style={{ fontSize: '.78rem' }}>
            {p.state === 'current' && p.publishedAt && `published ${dayOf(p.publishedAt)}`}
            {p.state === 'retired' && p.retiredAt && `retired ${dayOf(p.retiredAt)} · created ${dayOf(p.createdAt)}`}
            {p.state === 'draft' && `created ${dayOf(p.createdAt)}`}
            {p.subscriptionCount > 0 && ` · ${p.subscriptionCount} subscriber${p.subscriptionCount === 1 ? '' : 's'}`}
          </div>
        </div>
        {p.state === 'draft' && <Button size="sm" disabled={liveWritesDisabled} onClick={() => publish(p)} title={liveWritesDisabled ? 'Live writes are disabled on this instance' : undefined}>Publish</Button>}
      </div>)}
    </div>
    <NewPriceVersionForm plan={plan} passkeysState={passkeysState} liveWritesDisabled={liveWritesDisabled} onDone={onDone} />
  </>
}

// Create / edit a plan (§1.2) — one sheet, same isNew→plan flow ProgramFormSheet already uses.
// Editing presentation (name/description/badge) is DB-only, no reason/proveOwner (plan §4); the
// availability Switch and the Pricing section below only ever appear once the plan exists.
function PlanFormSheet({ id, plans, passkeysState, liveWritesDisabled, onDone, close, lockSheet }) {
  const toast = useUI(s => s.toast)
  const [plan, setPlan] = useState(id ? plans.find(p => p.id === id) : null)
  const isNew = !plan
  const [namePt, setNamePt] = useState(plan ? nameOf(plan.display) : '')
  const [nameEn, setNameEn] = useState(plan?.display?.en?.name || '')
  const [descPt, setDescPt] = useState(plan?.display?.['pt-BR']?.description || '')
  const [descEn, setDescEn] = useState(plan?.display?.en?.description || '')
  const [badgePt, setBadgePt] = useState(plan?.display?.['pt-BR']?.badge || '')
  const [interval, setInterval] = useState(plan?.interval || 'month')
  const [intervalCount, setIntervalCount] = useState(plan?.intervalCount || 1)
  const [idempotencyKey] = useState(uuid)
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const [savingDisplay, setSavingDisplay] = useState(false)
  const dirty = !isNew && (namePt !== nameOf(plan.display) || nameEn !== (plan.display?.en?.name || '')
    || descPt !== (plan.display?.['pt-BR']?.description || '') || descEn !== (plan.display?.en?.description || '')
    || badgePt !== (plan.display?.['pt-BR']?.badge || ''))
  useEffect(() => { lockSheet?.(dirty) }, [dirty]) // eslint-disable-line

  const display = () => {
    const d = { 'pt-BR': { name: namePt.trim() } }
    if (descPt.trim()) d['pt-BR'].description = descPt.trim()
    if (badgePt.trim()) d['pt-BR'].badge = badgePt.trim()
    if (nameEn.trim() || descEn.trim()) d.en = {}
    if (nameEn.trim()) d.en.name = nameEn.trim()
    if (descEn.trim()) d.en.description = descEn.trim()
    return d
  }

  const createConfirm = async proof => {
    setError(null)
    const r = await post('/api/admin/billing/catalog/plan/new', {
      id: slugify(namePt), display: display(), interval, intervalCount,
      unitAmount: 100, reason: reason.trim(), ...proof
      // ISO-1627: the create form itself never asks for a starting price (the UX spec's §1.2
      // fields are name/description/badge/periodicity only) — the server requires one to mint
      // the plan's first Price, so it is seeded as a R$1,00 draft and immediately replaced via
      // "New price version" + "Publish", the normal path every later value change already uses.
      // This never sells anything: the plan is born `available:false` either way.
    }, { 'Idempotency-Key': idempotencyKey })
    if (r.error) { setError(r.error === 'a plan with this id already exists' ? 'Another plan already has this name — vary it slightly.' : r.error); return }
    setPlan(r.plan); toast('Plan created'); onDone()
  }

  const saveDisplay = () => {
    setSavingDisplay(true); setError(null)
    api('/api/admin/billing/catalog/plan/display', { method: 'POST', body: JSON.stringify({ id: plan.id, version: plan.version, display: display() }) })
      .then(r => { setPlan(r.plan); toast('Saved'); onDone() })
      .catch(e => setError(e.data?.code === 'stale' ? 'Changed by someone else — reopen to see the latest.' : e.message))
      .finally(() => setSavingDisplay(false))
  }

  const toggleAvailability = async available => {
    let handle
    handle = useUI.getState().openSheet(close2 => <AvailabilitySheet
      plan={plan} available={available} passkeysState={passkeysState} lockSheet={v => handle.lock(v)} close={close2}
      onDone={p => { setPlan(p); onDone() }} />)
  }

  return <>
    <h3>{isNew ? 'New plan' : nameOf(plan.display)}</h3>
    {!isNew && <div className="row between" style={{ margin: '0 0 12px' }}>
      <div>
        <div className="small" style={{ fontWeight: 600 }}>{plan.available ? 'Available' : 'Unavailable'}</div>
        <div className="adm-hint" style={{ margin: 0 }}>Deactivating stops new sign-ups. Subscribers already on it keep paying and keep access.</div>
      </div>
      <Switch checked={plan.available} onChange={toggleAvailability} disabled={liveWritesDisabled} />
    </div>}
    <div className="adm-field">
      <label>Name (pt-BR)</label>
      <TextField value={namePt} onChange={e => setNamePt(e.target.value)} />
    </div>
    <div className="adm-field">
      <label>Name (English)</label>
      <TextField value={nameEn} placeholder="Optional — falls back to the Portuguese name" onChange={e => setNameEn(e.target.value)} />
    </div>
    <div className="adm-field">
      <label>Description (pt-BR)</label>
      <TextArea value={descPt} rows={2} onChange={e => setDescPt(e.target.value)} />
    </div>
    <div className="adm-field">
      <label>Description (English)</label>
      <TextArea value={descEn} rows={2} placeholder="Optional" onChange={e => setDescEn(e.target.value)} />
    </div>
    <div className="adm-field">
      <label>Badge (pt-BR)</label>
      <TextField value={badgePt} placeholder="Optional, e.g. 11% menos que o mensal" onChange={e => setBadgePt(e.target.value)} />
    </div>
    {isNew && <div className="row" style={{ gap: 10 }}>
      <div className="adm-field" style={{ flex: 1 }}>
        <label>Interval</label>
        <select className="adm-select" value={interval} onChange={e => { setInterval(e.target.value); setIntervalCount(1) }}>
          <option value="month">Month</option>
          <option value="year">Year</option>
        </select>
      </div>
      <div className="adm-field" style={{ flex: 1 }}>
        <label>Count</label>
        <select className="adm-select" value={intervalCount} onChange={e => setIntervalCount(Number(e.target.value))}>
          {(interval === 'year' ? [1] : [1, 3, 6, 12]).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>}
    {isNew ? <>
      {!namePt.trim() && <div className="adm-hint" style={{ color: 'var(--red)' }}>Name (pt-BR) is required.</div>}
      <ReasonProveOwnerFooter passkeysState={passkeysState} reason={reason} setReason={setReason}
        submitLabel="Save" error={error} onConfirm={namePt.trim() ? createConfirm : () => {}} />
    </> : <>
      {error && <div className="adm-result bad">{error}</div>}
      <div className="adm-actions">
        <Button variant="primary" disabled={savingDisplay || !namePt.trim()} onClick={saveDisplay}>{savingDisplay ? 'Saving…' : 'Save'}</Button>
        <Button onClick={close}>Close</Button>
      </div>
      <PlanPricing plan={plan} passkeysState={passkeysState} liveWritesDisabled={liveWritesDisabled} onDone={() => api('/api/admin/billing/catalog').then(v => setPlan(v.plans.find(p => p.id === plan.id))).then(onDone)} />
    </>}
  </>
}

function AvailabilitySheet({ plan, available, passkeysState, onDone, close }) {
  const toast = useUI(s => s.toast)
  const [idempotencyKey] = useState(uuid)
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const confirm = async proof => {
    setError(null)
    const r = await post('/api/admin/billing/catalog/plan/availability',
      { id: plan.id, version: plan.version, available, reason: reason.trim(), ...proof },
      { 'Idempotency-Key': idempotencyKey })
    if (r.error) { setError(r.error); return }
    toast(available ? 'Activated' : 'Deactivated'); close(); onDone(r.plan)
  }
  return <>
    <h3>{available ? 'Activate' : 'Deactivate'} "{nameOf(plan.display)}"?</h3>
    <ReasonProveOwnerFooter passkeysState={passkeysState} reason={reason} setReason={setReason}
      submitLabel={available ? 'Activate' : 'Deactivate'} danger={!available} error={error} onConfirm={confirm} />
    <div style={{ height: 6 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </>
}

export default function AdminBilling() {
  const openSheet = useUI(s => s.openSheet)
  const toast = useUI(s => s.toast)
  const passkeysState = useOwnProveOwnerState()
  const [view, setView] = useState(null)   // { plans, introPrices, liveWritesDisabled }
  const [err, setErr] = useState(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const load = () => api('/api/admin/billing/catalog')
    .then(v => { setView(v); setErr(null) })
    .catch(e => { if (e.status === 404) setNotConfigured(true); else setErr(e.message || 'Failed to load') })
  useEffect(() => { load() }, [])
  // Billing not configured on this instance (no STRIPE_API_KEY/STRIPE_WEBHOOK_SECRET) — renders
  // nothing at all, byte-for-byte the page it was before this frente, same precedent as the
  // Coach card (Admin.jsx's own comment on <AdminCoach/>).
  if (notConfigured) return null

  const plans = [...(view?.plans || [])].sort((a, b) => a.sortOrder - b.sortOrder)

  const openForm = id => {
    let handle
    handle = openSheet(close => <PlanFormSheet id={id} plans={plans} passkeysState={passkeysState}
      liveWritesDisabled={!!view?.liveWritesDisabled} onDone={load} close={close} lockSheet={v => handle.lock(v)} />)
  }

  const move = (id, dir) => {
    const order = plans.map(p => p.id)
    const i = order.indexOf(id)
    const j = i + dir
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    api('/api/admin/billing/catalog/order', { method: 'POST', body: JSON.stringify({ order }) })
      .then(() => load()).catch(e => toast(e.message))
  }

  return <div className="card" style={{ borderColor: 'color-mix(in srgb,var(--teal) 40%,var(--sep))' }}>
    <div className="row between"><h2 className="row" style={{ margin: 0, gap: 6 }}><Icon name="creditCard" style={{ color: 'var(--teal)' }} />Payment plans</h2>
      <Button variant="primary" size="sm" icon="plus" onClick={() => openForm(null)}>New plan</Button></div>
    <div className="adm-lead">Commercial pricing sold on Stripe — not the training catalog.</div>

    {view?.liveWritesDisabled && <div className="adm-result bad" style={{ marginBottom: 10 }}>
      Live writes are disabled on this instance. Every action below only works against the Stripe sandbox right now.
    </div>}

    {err && <div className="adm-result bad" style={{ marginBottom: 10 }}>
      {err} <button className="btn" style={{ marginInlineStart: 8 }} onClick={load}>Try again</button>
    </div>}

    {!view && !err && <div className="muted small">Loading…</div>}
    {view && !plans.length && <div className="adm-empty">No payment plans yet. This usually means the catalog hasn't been seeded from the Stripe sandbox prices yet — check the server log for a seed error, or create one by hand with "New plan".</div>}

    <div className="list">
      {plans.map((p, i) => {
        const current = p.prices.find(pr => pr.id === p.currentPriceId)
        const intro = (view.introPrices || []).find(pr => pr.id === p.introPriceId)
        return <div key={p.id} className="item" style={p.available ? null : { opacity: .6 }}>
          <div className="row" style={{ gap: 2, flex: 'none' }}>
            <button className="iconbtn adm-iconbtn" disabled={i === 0} aria-label="move up"
              onClick={e => { e.stopPropagation(); move(p.id, -1) }} style={{ visibility: i === 0 ? 'hidden' : 'visible' }}><Icon name="arrowUp" /></button>
          </div>
          <div className="grow" onClick={() => openForm(p.id)}>
            <div className="tt">{nameOf(p.display)} {!p.available && <span className="adm-pill bad">Unavailable</span>}</div>
            <div className="ss">
              {current ? `${fmtCentsBRL(current.unitAmount)}${periodOf(current.interval, current.intervalCount)}` : 'no published price'}
              {intro && ` · intro ${fmtCentsBRL(intro.unitAmount)} (1st month)`}
              {current && current.subscriptionCount > 0 && ` · ${current.subscriptionCount} subscriber${current.subscriptionCount === 1 ? '' : 's'} on this price`}
            </div>
          </div>
          <div className="row" style={{ gap: 2, flex: 'none' }}>
            <button className="iconbtn adm-iconbtn" disabled={i === plans.length - 1} aria-label="move down"
              onClick={e => { e.stopPropagation(); move(p.id, 1) }} style={{ visibility: i === plans.length - 1 ? 'hidden' : 'visible' }}><Icon name="arrowDown" /></button>
          </div>
        </div>
      })}
    </div>
  </div>
}

/* ======================================================================= subscription (item 2) */

const STATUS_PILL = { active: 'ok', past_due: 'warn', canceled: 'bad', incomplete: 'bad' }

const ACTION_LABELS = {
  changePlan: 'Switch plan', cancelAtPeriodEnd: 'Cancel at period end', resumeCancellation: 'Resume cancellation',
  cancelImmediately: 'Cancel immediately', suspendCollection: 'Suspend billing', resumeCollection: 'Resume billing',
  generateLink: 'Generate link', sync: 'Sync with Stripe'
}

function HistoryFold({ title, children, count }) {
  return <details className="adm-fold">
    <summary>{title}{count != null ? ` (${count})` : ''}<Icon name="chevronRight" className="chev" /></summary>
    <div className="adm-fold-b">{children}</div>
  </details>
}

function GenerateLinkSheet({ userId, plans, passkeysState, onDone, close }) {
  const toast = useUI(s => s.toast)
  const [idempotencyKey] = useState(uuid)
  const [planId, setPlanId] = useState(plans[0]?.id || '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const [url, setUrl] = useState(null)
  const confirm = () => {
    setError(null)
    post('/api/admin/billing/subscription/generate-link', { userId, planId, reason: reason.trim() }, { 'Idempotency-Key': idempotencyKey })
      .then(r => { if (r.error) { setError(r.error); return } setUrl(r.after?.url); onDone() })
  }
  if (url) return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>Link ready</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>Copy this link and send it to the user. It only charges them once they complete the Checkout.</div>
    <button className="adm-code" style={{ fontSize: 14, width: '100%', padding: '12px 0', wordBreak: 'break-all' }}
      onClick={() => { navigator.clipboard?.writeText(url).catch(() => {}); toast('Copied') }}>{url}</button>
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={close}>Done</Button>
  </div>
  const ok = reason.trim().length >= 10 && planId
  return <>
    <h3>Generate subscription link</h3>
    <div className="adm-field">
      <label>Plan</label>
      <select className="adm-select" value={planId} onChange={e => setPlanId(e.target.value)}>
        {plans.map(p => <option key={p.id} value={p.id}>{nameOf(p.display)}</option>)}
      </select>
    </div>
    <div className="adm-field">
      <label>Reason</label>
      <TextArea value={reason} rows={2} onChange={e => setReason(e.target.value)} />
      <div className="muted small" style={{ textAlign: 'end' }}>{Math.min(reason.trim().length, 10)}/10 min</div>
    </div>
    {error && <div className="adm-result bad">{error}</div>}
    <button className="btn primary" disabled={!ok} onClick={confirm}>Generate link</button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </>
}

// "Switch plan" (ISO-1627 Atena review): which plan to switch to is the admin's own choice, not
// whichever other plan happens to sort first in the catalog — same `<select>` pattern
// GenerateLinkSheet above already uses. A separate, small sheet rather than folding the picker
// into FinancialConfirmSheet itself: the reinforced dialog's own typed confirmation already names
// the chosen plan (`Type "X" to confirm`), so the plan has to be picked and closed over *before*
// that sheet even opens.
function ChoosePlanSheet({ plans, onChosen, close }) {
  const [planId, setPlanId] = useState(plans[0]?.id || '')
  return <>
    <h3>Switch plan</h3>
    <div className="adm-field">
      <label>New plan</label>
      <select className="adm-select" value={planId} onChange={e => setPlanId(e.target.value)}>
        {plans.map(p => <option key={p.id} value={p.id}>{nameOf(p.display)}</option>)}
      </select>
    </div>
    <button className="btn primary" disabled={!planId} onClick={() => onChosen(planId)}>Continue</button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </>
}

// The user's "Subscription" section (UX spec §2) — replaces the old Plan/Status/Next charge
// tiles in Admin.jsx's UserDetail. Lazy: this is a bigger payload than GET /api/admin/user
// already sends to the top of that sheet (full history, not just the summary).
export function SubscriptionPanel({ userId }) {
  const openSheet = useUI(s => s.openSheet)
  const toast = useUI(s => s.toast)
  const passkeysState = useOwnProveOwnerState()
  const [ficha, setFicha] = useState(null)
  const [err, setErr] = useState(null)
  const [catalogPlans, setCatalogPlans] = useState([])
  // "Another action on this subscription is in progress" (UX spec §2.2) — the server's own
  // advisory lock is the real guard; this just keeps the admin from opening a second dialog on
  // top of one already open for this same account.
  const [busy, setBusy] = useState(false)

  const load = () => api('/api/admin/user/billing?id=' + encodeURIComponent(userId))
    .then(d => { setFicha(d); setErr(null) })
    .catch(e => setErr(e.message))
  useEffect(() => { load(); api('/api/admin/billing/catalog').then(v => setCatalogPlans((v.plans || []).filter(p => p.available))).catch(() => {}) }, [userId])

  if (err) return <div className="adm-result bad">{err} <button className="btn" style={{ marginInlineStart: 8 }} onClick={load}>Try again</button></div>
  if (!ficha) return <div className="muted small">Loading…</div>

  const sub = ficha.subscriptions[0] || null
  const legacy = ficha.subscriptions.slice(1)

  const lockKeyedOpen = render => {
    setBusy(true)
    let handle
    const free = () => { setBusy(false); handle.close() }
    handle = openSheet(() => render(free, v => handle.lock(v)))
    return handle
  }

  const previewText = async (action, extra, buildText) => {
    if (!sub) return buildText(null)
    const r = await post('/api/admin/billing/subscription/preview', { subscriptionId: sub.id, action, ...extra })
    if (r.error) throw new Error(r.error)
    return buildText(r)
  }

  const openReinforced = (action, { title, needsTypedConfirm, typedLabel, typedExpected, needsProveOwner = true, danger, confirmLabel, body, buildPreview }) => {
    lockKeyedOpen((close, lock) => <FinancialConfirmSheet
      title={title} lockSheet={lock} close={close}
      loadPreview={() => previewText(action, body.previewExtra || {}, buildPreview)}
      needsTypedConfirm={needsTypedConfirm} typedLabel={typedLabel} typedExpected={typedExpected}
      needsProveOwner={needsProveOwner} passkeysState={passkeysState} danger={danger} confirmLabel={confirmLabel}
      submit={({ reason, idempotencyKey, ...proof }) => post(`/api/admin/billing/subscription/${action}`,
        { userId, subscriptionId: sub.id, expectedUpdatedAt: sub.updatedAt, reason, ...body.params, ...proof },
        { 'Idempotency-Key': idempotencyKey })}
      onSuccess={() => { toast('Done'); load() }} onReload={load}
    />)
  }

  const confirmSwitchTo = other => openReinforced('change-plan', {
    title: 'Switch plan', needsTypedConfirm: true, typedLabel: `Type "${nameOf(other.display)}" to confirm`, typedExpected: nameOf(other.display),
    confirmLabel: 'Switch plan', body: { params: { newPlanId: other.id }, previewExtra: { newPlanId: other.id } },
    buildPreview: () => `Takes effect at the next renewal${sub.nextCharge?.date ? ` (${dayOf(sub.nextCharge.date)})` : ''}. No charge now — the next invoice is for ${nameOf(other.display)}.`
  })
  // describeAvailableActions (api/billing.js) enables `changePlan` on status alone — it does not
  // check whether another plan actually exists to switch to, so this guards the one case the
  // server's own `actions.changePlan.enabled` can't rule out on its own.
  const switchPlan = () => {
    const candidates = catalogPlans.filter(p => p.id !== sub.plan)
    if (!candidates.length) { toast('No other available plan to switch to'); return }
    lockKeyedOpen(close => <ChoosePlanSheet plans={candidates} close={close}
      onChosen={planId => { close(); confirmSwitchTo(candidates.find(p => p.id === planId)) }} />)
  }
  const cancelPeriodEnd = () => openReinforced('cancel-period-end', {
    title: 'Cancel at period end', needsTypedConfirm: true, typedLabel: 'Type "CANCEL" to confirm', typedExpected: 'CANCEL',
    danger: true, confirmLabel: 'Cancel at period end', body: { params: {} },
    buildPreview: () => `Access continues until ${dayOf(sub.currentPeriodEnd)}, then stops. No refund.`
  })
  const resumeCancellation = () => openReinforced('resume', {
    title: 'Resume cancellation', needsProveOwner: false, confirmLabel: 'Resume cancellation', body: { params: {} },
    buildPreview: () => `Cancellation is removed. The subscription renews normally on ${dayOf(sub.currentPeriodEnd)}${sub.nextCharge?.amountCents != null ? ` for ${fmtCentsBRL(sub.nextCharge.amountCents)}` : ''}.`
  })
  const cancelImmediately = () => openReinforced('cancel-immediately', {
    title: 'Cancel immediately', needsTypedConfirm: true, typedLabel: 'Type "CANCEL" to confirm', typedExpected: 'CANCEL',
    danger: true, confirmLabel: 'Cancel immediately', body: { params: {} },
    buildPreview: () => 'Effective now. No charge today. Access becomes read-only immediately. No refund for time already paid.'
  })
  const suspendBilling = () => openReinforced('suspend-collection', {
    title: 'Suspend billing', confirmLabel: 'Suspend billing', danger: true, body: { params: {} },
    buildPreview: () => 'No invoices are generated while suspended. The account becomes read-only immediately, the same as a canceled subscription.'
  })
  const resumeBilling = () => openReinforced('resume-collection', {
    title: 'Resume billing', confirmLabel: 'Resume billing', body: { params: {} },
    buildPreview: () => `Billing resumes on the normal cycle.${sub.nextCharge?.date ? ` Next charge: ${dayOf(sub.nextCharge.date)}` : ''}${sub.nextCharge?.amountCents != null ? ` · ${fmtCentsBRL(sub.nextCharge.amountCents)}` : ''}.`
  })
  const generateLink = () => lockKeyedOpen((close, lock) => <GenerateLinkSheet userId={userId} plans={catalogPlans} passkeysState={passkeysState}
    onDone={load} close={close} />)
  const sync = () => {
    setBusy(true); toast('Syncing…')
    post('/api/admin/billing/subscription/sync', { userId, subscriptionId: sub.id, expectedUpdatedAt: sub.updatedAt }, { 'Idempotency-Key': uuid() })
      .then(r => { setBusy(false); if (r.error) { toast(r.error); return } toast('Synced'); load() })
  }

  const ACTIONS = [
    ['changePlan', switchPlan], ['cancelAtPeriodEnd', cancelPeriodEnd], ['resumeCancellation', resumeCancellation],
    ['cancelImmediately', cancelImmediately], ['suspendCollection', suspendBilling], ['resumeCollection', resumeBilling],
    ['generateLink', generateLink], ['sync', sync]
  ]

  return <>
    <h4 className="sec">Subscription</h4>
    {ficha.liveWritesDisabled && <div className="adm-result bad" style={{ marginBottom: 10 }}>Live writes are disabled on this instance.</div>}
    {sub ? <>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '0 0 8px' }}>
        <span className={'adm-pill ' + (STATUS_PILL[sub.status] || '')}>{sub.status}</span>
        {sub.pauseCollection && <span className="adm-pill">Billing suspended</span>}
        {sub.duplicateOf && <span className="adm-pill bad" title="This account has two live subscriptions from separate checkout sessions. 'Cancel immediately' here cancels only this one; refunding the duplicate isn't done by the app yet — use the Stripe Dashboard.">Duplicate</span>}
        <span className="small">{sub.planDisplay ? nameOf(sub.planDisplay) : sub.plan || 'unknown plan'}{sub.priceAmountCents != null && ` · ${fmtCentsBRL(sub.priceAmountCents)}`}</span>
      </div>
      {sub.nextCharge && <div className="small muted" style={{ marginBottom: 4 }}>
        Next charge: {dayOf(sub.nextCharge.date)}{sub.nextCharge.amountCents != null && ` · ${fmtCentsBRL(sub.nextCharge.amountCents)}`}
      </div>}
      <div className="small muted" style={{ marginBottom: 10 }}>
        Source: {sub.origin} {sub.id && <span className="adm-code" style={{ marginInlineStart: 6 }}
          onClick={() => { navigator.clipboard?.writeText(sub.id).catch(() => {}); toast('Copied') }}>{sub.id}</span>}
      </div>
    </> : <div className="adm-empty" style={{ marginBottom: 10 }}>No subscription on record.</div>}

    <div style={{ marginBottom: 10 }}>
      {ACTIONS.map(([key, fn]) => {
        const a = ficha.actions[key] || { enabled: false, reason: 'unavailable' }
        // `title` alone only ever reaches a mouse hovering before the click — nothing on a
        // touchscreen (Atena's UX review, ISO-1627): the reason also renders as plain text right
        // under the button, same `.adm-hint` treatment every other inline explanation in this
        // dashboard already uses, so tapping a disabled action still tells the admin why.
        const reason = !a.enabled ? a.reason : busy ? 'Another action on this subscription is in progress' : null
        return <div key={key} style={{ marginBottom: 8 }}>
          <button className="btn" style={{ width: '100%' }} disabled={!a.enabled || busy}
            title={reason || undefined} aria-label={ACTION_LABELS[key]} onClick={fn}>{ACTION_LABELS[key]}</button>
          {reason && <div className="adm-hint" style={{ margin: '4px 0 0' }}>{reason}</div>}
        </div>
      })}
    </div>

    <HistoryFold title="Legacy subscriptions" count={legacy.length}>
      {legacy.length ? <div className="list">
        {legacy.map(s => <div key={s.id} className="row between" style={{ padding: '6px 2px', borderBottom: 'var(--hair) solid var(--sep)' }}>
          <span className="small">{s.planDisplay ? nameOf(s.planDisplay) : s.plan || 'unknown'} · {fmtCentsBRL(s.priceAmountCents)} — {s.status}</span>
          <span className="small muted">{dayOf(s.createdAt)} → {s.currentPeriodEnd ? dayOf(s.currentPeriodEnd) : '–'}</span>
        </div>)}
      </div> : <div className="adm-empty">Nothing here.</div>}
    </HistoryFold>
    <HistoryFold title="Action history" count={ficha.history.length}>
      {ficha.history.length ? <div className="list">
        {ficha.history.map(h => <ActionHistoryRow key={h.id} h={h} />)}
      </div> : <div className="adm-empty">Nothing recorded yet.</div>}
    </HistoryFold>
  </>
}

function ActionHistoryRow({ h }) {
  const [open, setOpen] = useState(false)
  const failed = h.status === 'failed' || h.status === 'unknown'
  return <div style={{ padding: '6px 2px', borderBottom: 'var(--hair) solid var(--sep)', cursor: failed ? 'pointer' : 'default' }}
    onClick={() => failed && setOpen(o => !o)}>
    <div className="row between">
      <span className="small">{h.action} <span className={'adm-pill ' + (h.status === 'succeeded' ? 'ok' : h.status === 'failed' ? 'bad' : 'warn')}>{h.status}</span></span>
      <span className="small muted">{new Date(h.createdAt).toLocaleString()}</span>
    </div>
    <div className="dim" style={{ fontSize: '.78rem' }}>{h.reason}</div>
    {open && h.error && <div className="adm-hint" style={{ color: 'var(--red)' }}>{h.error}</div>}
  </div>
}
