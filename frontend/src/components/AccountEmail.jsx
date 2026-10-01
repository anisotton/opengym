// The account's own verified e-mail (ISO-1397/1398): the under-18 notice shown at sign-up and at
// the old-account migration sheet below, the "resend confirmation" button reused in three places
// (this file's own sheet, Login.jsx's post-signup screen, SyncBanner.jsx's reminder), and
// Settings → Account → E-mail itself. Distinct from PasswordAuth.jsx's EmailRow — the older,
// optional, never-sent-to sign-in address (#118) — which this never touches.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { isMinor } from '../lib/age.js'
import { accountEmailResend, accountEmailSet, recoverRequest } from '../lib/api.js'
import { looksLikeEmail, foldEmail, passwordError, ProveOwner } from './PasswordAuth.jsx'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const errStyle = { color: 'var(--red)', marginTop: 10 }

/* ------------------------------------------------------------- under-18 notice --------------
   Decision of 30/09 (ISO-1390), over section 1 of the Atena spec (ISO-1396): a single,
   non-blocking, discreet modal — closes with one tap (its own button, or the backdrop) and never
   disables Continue. The wording is a placeholder; final copy is Phase 4's (ISO-1390) and does
   not block this issue. */
function MinorNoticeDialog({ close }) {
  return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
      {t('People under 18 should use this app with a guardian’s guidance.')}
    </div>
    <Button variant="primary" onClick={close}>{t('Got it')}</Button>
  </div>
}
export const openMinorNotice = () => ui().openSheet(close => <MinorNoticeDialog close={close} />, { kind: 'center' })

// Opens the notice once per distinct birth date that comes out under 18 — not on every render
// while it stays under 18, and again if it is edited to a different under-18 date.
export function useMinorNotice(birthDate) {
  const shownFor = useRef(null)
  useEffect(() => {
    if (isMinor(birthDate)) { if (shownFor.current !== birthDate) { shownFor.current = birthDate; openMinorNotice() } }
    else shownFor.current = null
  }, [birthDate])
}

/* ------------------------------------------------------------- resend confirmation -----------
   A 60s cooldown after a send, same idea as the device-link/passkey throttles elsewhere: slows
   impatient re-taps without a captcha. The server's own pause (429) still answers normally if
   tapped from several tabs at once. */
export function ResendEmailButton({ label, variant }) {
  const [busy, setBusy] = useState(false)
  const [until, setUntil] = useState(0)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!until) return
    const id = setInterval(() => tick(v => v + 1), 1000)
    return () => clearInterval(id)
  }, [until])
  const left = Math.max(0, Math.ceil((until - Date.now()) / 1000))
  const cooling = left > 0
  const go = async () => {
    if (busy || cooling) return
    setBusy(true)
    try { await accountEmailResend(); toast(t('E-mail resent.')); setUntil(Date.now() + 60000) }
    catch (e) { toast(passwordError(e)) }
    finally { setBusy(false) }
  }
  return <Button type="button" variant={variant} disabled={busy || cooling} onClick={go}>
    {cooling ? t('Wait to resend ({0}s)', left) : (label || t('Resend e-mail'))}
  </Button>
}

/* ------------------------------------------------------------- Settings → Account → E-mail ---
   `user` carries `email`/`emailVerified`/`needsEmail` (GET /api/me, PASSWORD_LOGIN off only —
   see store/useStore.js boot()). `done` patches the store's user object in place so the row
   updates at once, the same way Settings' other account rows read their own `state`/`changed`
   pair back. */
export function AccountEmailRow({ user }) {
  if (!user) return null
  const subtitle = !user.email ? t('Not added — tap to add')
    : <>{user.email}<span className={'badge ' + (user.emailVerified ? 'ok' : 'warn')} style={{ marginInlineStart: 8 }}>
      {user.emailVerified ? t('Confirmed') : t('Pending')}</span></>
  return <Row icon="envelope" iconTint="var(--acc)" title={t('E-mail')} subtitle={subtitle} accessory="chevron"
    onClick={() => ui().openSheet(close => user.email ? <AccountEmailSheet user={user} close={close} /> : <AddEmailSheet close={close} />)} />
}

function patchUser(patch) { useStore.getState().setUser({ ...useStore.getState().user, ...patch }) }

// What Settings shows first for a profile that already has an address — "Change e-mail" opens
// AddEmailSheet below (same edit/confirm steps, told apart only by its `current` prop).
export function AccountEmailSheet({ user, close }) {
  return <>
    <h3>{t('E-mail')}</h3>
    <div className="small" style={{ marginBottom: 6, fontWeight: 600, overflowWrap: 'anywhere' }}>{user.email}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>
      {user.emailVerified ? t('Confirmed') : t('Not confirmed yet.')}
    </div>
    {!user.emailVerified && <><ResendEmailButton label={t('Resend confirmation')} /><div style={{ height: 8 }} /></>}
    <Button variant="ghost" onClick={() => ui().openSheet(c => <AddEmailSheet current={user.email} close={c} />)}>{t('Change e-mail')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Done')}</Button>
  </>
}

/* ------------------------------------------------------------- old-account migration ---------
   An account from before ISO-1397 adding the e-mail it never had — Settings' own entry point
   (AccountEmailRow above, "Not added") and the once-per-login prompt (App.jsx Shell, gated on
   `needsEmail` and a 7-day local deferral). Birth date is deliberately not asked again here:
   POST /api/account/email (ISO-1397) has no field for it — only sign-up does — so collecting one
   here would save nothing and only look like it did. */
export function AddEmailSheet({ current, close }) {
  const changing = !!current
  const [step, setStep] = useState('edit')   // 'edit' | 'confirm'
  const [email, setEmail] = useState(current || '')
  const [err, setErr] = useState(null)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const clean = email.trim()
  const title = changing ? t('Change e-mail') : t('Add your e-mail')
  const next = ev => {
    ev.preventDefault()
    const bad = !looksLikeEmail(clean) ? t('That is not an e-mail address.')
      : foldEmail(clean) === current ? t('That is already your e-mail.')
      : null
    if (bad) { setErr(bad); return }
    setErr(null); setStep('confirm')
  }
  const save = async proof => {
    const r = await accountEmailSet(foldEmail(clean), proof)
    patchUser({ email: r.email, emailVerified: false, needsEmail: false })
    close()
    toast(t('Confirmation link sent to {0}.', r.email))
  }
  if (step === 'confirm') return <>
    <h3>{title}</h3>
    <div className="small" style={{ marginBottom: 6, fontWeight: 600, overflowWrap: 'anywhere' }}>{foldEmail(clean)}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey password={false} submitText={t('Save')} onProof={save} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={() => setStep('edit')}>{t('Back')}</Button>
  </>
  return <>
    <h3>{title}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Your e-mail confirms your account and is the only way to recover access if you lose this device.')}
    </div>
    <form onSubmit={next} noValidate>
      <input ref={ref} className="input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('E-mail address')} maxLength={254}
        value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary">{changing ? t('Continue') : t('Save')}</Button>
    </form>
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{changing ? t('Cancel') : t('Not now')}</Button>
  </>
}

// Local-only deferral (App.jsx Shell): shown once per sign-in, then at most once every 7 days
// while the account still has none — never blocks the app either way.
const DEFERRED_KEY = 'brilhart_needs_email_deferred_at'
const DEFER_DAYS_MS = 7 * 86400000
export function needsEmailPromptDue() {
  const at = Number(localStorage.getItem(DEFERRED_KEY) || 0)
  return !at || Date.now() - at > DEFER_DAYS_MS
}
export function openNeedsEmailPrompt() {
  ui().openSheet(close => <AddEmailSheet close={() => { localStorage.setItem(DEFERRED_KEY, String(Date.now())); close() }} />)
}

/* ------------------------------------------------------------- "Perdi meu acesso" (Login.jsx) -
   POST /api/recover/request answers 200 either way (api/server.js's own anti-enumeration
   contract) — this sheet shows the same neutral "if that's a known e-mail…" line regardless of
   whether the address exists, never a distinct error for "no such account". Opening the mailed
   link lands on RecoverAccess.jsx (#/recuperar?token=). */
function RecoverRequestSheet({ close }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const go = async ev => {
    ev.preventDefault()
    if (busy || !looksLikeEmail(email)) return
    setBusy(true)
    try { await recoverRequest(foldEmail(email)) } catch { /* same neutral screen either way — see api/server.js's own anti-enumeration contract above */ }
    setBusy(false); setSent(true)
  }
  if (sent) return <>
    <h3>{t('Check your e-mail')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {/* 15 minutes, one use — RECOVER_TTL_MS (api/email-tokens.js), not the 24h/reusable
          confirmation link above: a different token, a different TTL. */}
      {t('If {0} has an account here, we sent a link to set up a new passkey on this device. It is valid for 15 minutes and works once.', foldEmail(email))}
    </div>
    <Button variant="primary" onClick={close}>{t('Done')}</Button>
  </>
  return <>
    <h3>{t('Lost access to your device?')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Enter the e-mail you added to your account. If it matches one, we send a link to set up a passkey on this device.')}
    </div>
    <form onSubmit={go} noValidate>
      <input ref={ref} className="input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('E-mail address')} maxLength={254}
        value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy || !looksLikeEmail(email)}>{t('Send link')}</Button>
    </form>
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
export const openRecoverRequest = () => ui().openSheet(close => <RecoverRequestSheet close={close} />)
