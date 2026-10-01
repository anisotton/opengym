// The passkey half of sign-up (ISO-1397/1398): name, e-mail, birth date, then the passkey
// ceremony, then "check your e-mail". Shared by Login.jsx's RegisterSheet and Settings.jsx's
// RegisterInline — the only two places a passkey profile is created from. The password half
// (PasswordRegisterForm, PasswordAuth.jsx) is untouched: PASSWORD_LOGIN is off on Brilhart
// Fitness, and its own e-mail field is the older, optional, never-sent-to sign-in address (#118),
// unrelated to this one.
import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n.js'
import { ageFromBirthDate } from '../lib/age.js'
import { passkeyRegister, bio } from '../lib/api.js'
import { looksLikeEmail, foldEmail, passwordError } from './PasswordAuth.jsx'
import { useMinorNotice, ResendEmailButton } from './AccountEmail.jsx'
import { Button } from './ui.jsx'

const errStyle = { color: 'var(--red)', marginTop: 10 }
// Below this the birth date is treated the same as a malformed field (a typo, a wrong-century
// slip), not a reason to show the under-18 notice — ordinary input sanity, same category as "not
// a valid e-mail", never itself a barrier the notice doesn't already clear.
const MIN_PLAUSIBLE_AGE = 5

/* name/code stay the caller's state (Login.jsx lifts them so the passkey/password Segmented
   switch keeps what was typed); email/birthDate/the two steps are this component's own. */
export default function SignupFlow({ name, setName, code, setCode, inviteOnly, close, onCreated }) {
  const [email, setEmail] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [step, setStep] = useState('data')   // 'data' | 'sent'
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  useMinorNotice(birthDate)

  const age = ageFromBirthDate(birthDate)
  const dateOK = !!birthDate && age != null && age >= MIN_PLAUSIBLE_AGE
  const canSubmit = !!name.trim() && looksLikeEmail(email) && dateOK && (!inviteOnly || !!code.trim())

  const go = async () => {
    if (busy) return
    const n = name.trim()
    const bad = !n ? t('Enter a name')
      : !looksLikeEmail(email) ? t('That is not an e-mail address.')
      : !dateOK ? t('Check your birth date.')
      : inviteOnly && !code.trim() ? t('An invite code is required')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      const u = await passkeyRegister(n, code.trim(), foldEmail(email), birthDate)
      await onCreated({ ...u, email: foldEmail(email), emailVerified: false, needsEmail: false })
      setStep('sent')
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') setErr(passwordError(e))
    } finally { setBusy(false) }
  }

  if (step === 'sent') return <>
    <h3>{t('Almost there!')}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>
      {t('We sent a confirmation link to {0}. It is valid for 24 hours — open it to confirm your account.', foldEmail(email))}
    </div>
    <div className="dim small" style={{ marginBottom: 14 }}>
      {t('You can already use the app. Only a subscription needs the confirmed e-mail.')}
    </div>
    <ResendEmailButton />
    <div style={{ height: 8 }} />
    <Button variant="primary" onClick={close}>{t('Open Brilhart Fitness')}</Button>
  </>

  return <>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Pick a name, then confirm with {0}. The passkey is saved in your device — no password needed.', bio())}
    </div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('E-mail address')} maxLength={254}
      value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    <div style={{ height: 10 }} />
    <input className="input" type="date" name="bday" autoComplete="bday" aria-label={t('Date of birth')}
      value={birthDate} onChange={e => setBirthDate(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy || !canSubmit} onClick={go}>{t('Create passkey')}</Button>
  </>
}
