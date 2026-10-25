// E-mail/name-and-password sign-in next to passkeys and Google (ISO-1596/1597/1598), on an
// instance that offers it (GET /api/config → `password_login`). Everything a password needs on
// screen lives here: redeeming the one-time code an admin hands out, creating a profile with a
// password, and the Settings row that sets, changes or removes one — and the "confirm it is you"
// step (ProveOwner) that Settings asks for before a way in is added or removed, where the
// password is one of up to three answers (passkey, password, or Google reauth for a profile with
// neither). The old, optional, never-sent-to "sign-in e-mail" (#118, EmailRow) is retired — ISO-1596
// made the account's one verified e-mail (AccountEmail.jsx) the only e-mail there is. Passkeys stay
// the default wherever this appears; the rules themselves are the server's (api/password.js and
// the password/google blocks in api/server.js), this only words them.
import { useEffect, useRef, useState } from 'react'
import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { ageFromBirthDate, isMinor, MIN_PLAUSIBLE_AGE } from '../lib/age.js'
import { api, webauthnOK, passkeyAssertion, passwordLogin, passwordRegister, passwordResetRedeem, reportWebauthnFailure, beginGoogleAuth } from '../lib/api.js'
import { classifyWebauthnFailure, webauthnFailureText } from '../lib/webauthn-error.js'
import { askAddDeviceData } from '../sheets.jsx'
import { Row, Button } from './ui.jsx'
import GoogleButton from './GoogleButton.jsx'
import TermsCheckbox from './TermsCheckbox.jsx'
import { LEGAL_VERSION } from '../legal/version.js'

// The server's floor (api/password.js MIN_LENGTH), checked here first so the common mistake is
// answered without a round trip. The server still decides.
export const MIN_PASSWORD = 10
export const passwordOn = config => !!config?.password_login
// An address the way the server stores and compares it (nameKey in api/password.js): NFKC,
// trimmed, lower-cased.
export const foldEmail = s => String(s || '').normalize('NFKC').trim().toLowerCase()
// The server's own check (normalizeEmail and EMAIL_RE in api/password.js), so what passes here is
// what the server takes; a test holds the two together. The server still decides.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?=.{1,253}$)[^\s@<>()[\]\\,;:"._-][^\s@<>()[\]\\,;:"]*\.[^\s@<>()[\]\\,;:".]{2,}$/u
export const looksLikeEmail = s => {
  const e = foldEmail(s)
  return !!e && [...e].length <= 254 && EMAIL_RE.test(e) && !e.includes('..')
}

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const length = s => [...String(s || '')].length
const errStyle = { color: 'var(--red)', marginTop: 10 }

// "in 5 minutes" in the UI language, for how long a pause (429, Retry-After) still lasts.
function fmtIn(sec) {
  const [n, unit] = sec < 60 ? [Math.max(1, Math.round(sec)), 'second'] : sec < 3600 ? [Math.ceil(sec / 60), 'minute'] : [Math.ceil(sec / 3600), 'hour']
  try { return new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'always' }).format(n, unit) }
  catch { return n + ' ' + unit }
}

// The server's answer in the UI language. Every password route sends a stable `code` beside its
// English message (api/openapi.yaml, Error.code); an answer without one is shown as it came.
export function passwordError(e) {
  const code = e?.data?.code
  if (e?.status === 429 || code === 'locked') return t('Too many attempts — try again {0}.', fmtIn(e?.data?.retryAfter || 60))
  switch (code) {
    // ISO-1596: the identifier field is labelled "E-mail" now (Login.jsx) — an account from
    // before e-mail was required still signs in by name, but the message no longer lists it.
    case 'bad-credentials': return t('Wrong e-mail or password.')
    case 'too-short': return t('Use at least {0} characters.', MIN_PASSWORD)
    case 'too-long': return t('That password is too long.')
    case 'too-common': return t('That password is too easy to guess — try a longer one, or a few unrelated words.')
    case 'name-taken': return t('Another profile already signs in with this name.')
    case 'email-invalid': return t('That is not an e-mail address.')
    case 'email-taken': return t('Another profile already uses this e-mail address.')
    case 'invite': return t('That invite code is not valid.')
    case 'current-required': case 'current-wrong': return t('Your current password is not right.')
    case 'passkey': case 'passkey-required': return t('Your passkey could not be confirmed.')
    case 'last-way-in': return t('This password is the only way into your profile, so it cannot be removed.')
    case 'reset-invalid': return t('That reset code is wrong or has expired — ask your admin for a new one.')
    case 'disabled': return t('This account has been disabled.')
    case 'busy': return t('The server is busy — try again in a moment.')
    // ISO-1390: a signup the server refused over the terms. This bundle always sends its own
    // LEGAL_VERSION, so `terms-required` only reaches an older one that sends none — for both,
    // the way forward is a newer app.
    case 'terms-required': case 'terms-version-stale': return t('Update the app to accept the new terms.')
  }
  return e?.message || t('Sign-in failed')
}
// A WebAuthn ceremony's own rejection (never a server HttpError, which carries a `status`
// instead) — the only kind classifyWebauthnFailure has an opinion about.
const isCeremonyError = e => ['NotAllowedError', 'AbortError', 'NotSupportedError', 'SecurityError'].includes(e?.name)

// ISO-1480: NotAllowedError/AbortError used to mean "the person cancelled" unconditionally, which
// also swallowed a certificate Chrome refuses to trust, a device with no screen lock, and a
// non-secure origin — three silent "nothing happened"s on the same Android phone. `elapsedMs`/
// `isSecureContext` ride on the error from lib/api.js's timedCeremony. Returns: `null` to stay
// silent exactly as before (a real dismissal is the person's answer); a sentence to show when the
// classifier has one; `undefined` when the error is not a WebAuthn ceremony rejection at all, or
// is one classifyWebauthnFailure has no specific wording for — either way the caller's own
// passkeyError/passwordError(e) still applies. Every non-silent case is also reported to
// POST /api/client-event (lib/api.js), sanitized down to the classifier's own enum, never the
// error's message text.
export function webauthnOutcome(e, flow, step) {
  if (!isCeremonyError(e)) return undefined
  const c = classifyWebauthnFailure(e, { isSecureContext: e?.isSecureContext, elapsedMs: e?.elapsedMs })
  if (c.silent) return null
  reportWebauthnFailure(flow, step, c.kind, e)
  return webauthnFailureText(c, t) ?? undefined
}

// Signed in: the same steps as a passkey sign-in (Login.jsx) — and the same account coming back
// merges what this device kept for it (adoptProfile). That includes asking /api/me for what the
// sign-in answer leaves out (e-mail state, ISO-1397; terms, ISO-1390): without it a password
// sign-in would skip the "we updated our terms" sheet until the next reload. A failure still
// signs in; the fields catch up on the next boot.
async function signedIn(u, close) {
  const st = useStore.getState()
  const me = await api('/api/me').catch(() => null)
  // Only an answered /api/me counts as this visit's terms check (setUserFromMe, ISO-1390).
  if (me) st.setUserFromMe(me, u, { adopt: true }); else st.setUser(u, { adopt: true })
  close()
  await st.adoptProfile(askAddDeviceData)
  toast(t('Welcome back, {0}', u.name))
}

const field = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
const codeStyle = { letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }

/* Sign in with name (or the profile's sign-in e-mail) and password, or — one tap away — redeem a reset code from the admin, which
   sets a new password and signs in. `onPasskey`, when given, offers the passkey instead. The
   inputs carry the autocomplete names password managers look for, inside a real form. */
export function PasswordSignInSheet({ close, onPasskey }) {
  const [mode, setMode] = useState('signin')   // 'signin' | 'reset'
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const nameRef = useRef(null)
  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 250) }, [])
  const reset = mode === 'reset'
  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()
    const bad = !n ? t('Enter your name or e-mail.')
      : !reset && !pw ? t('Enter your password.')
      : reset && !code.trim() ? t('Enter the reset code.')
      : reset && length(next) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      // A typo here is only found at the next sign-in, and fixing it takes another code.
      : reset && next !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try { await signedIn(reset ? await passwordResetRedeem(n, code.trim(), next) : await passwordLogin(n, pw), close) }
    catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{reset ? t('Reset your password') : t('Sign in with password')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{reset
      ? t('Enter the code your admin gave you and choose a new password. It signs you out everywhere else.')
      : t('Use your profile name — or the e-mail you added to it — and your password.')}</div>
    <form onSubmit={submit} noValidate>
      {/* One field for both: the server looks an entry with an "@" up as an e-mail first. Not
          type="email", which would refuse a plain name. */}
      <input ref={nameRef} className="input" name="username" autoComplete="username" placeholder={t('Name or e-mail')} maxLength={254}
        value={name} onChange={e => setName(e.target.value)} {...field} />
      <div style={{ height: 10 }} />
      {reset ? <>
        <input className="input" name="reset-code" autoComplete="one-time-code" placeholder={t('Reset code')} maxLength={20}
          value={code} onChange={e => setCode(e.target.value.toUpperCase())} {...field} style={codeStyle} />
        <div style={{ height: 10 }} />
        <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('New password')}
          value={next} onChange={e => setNext(e.target.value)} />
        <div style={{ height: 10 }} />
        <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
          value={again} onChange={e => setAgain(e.target.value)} />
        <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
      </> : <input className="input" type="password" name="password" autoComplete="current-password" placeholder={t('Password')}
        value={pw} onChange={e => setPw(e.target.value)} />}
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy}>{reset ? t('Set password & sign in') : t('Sign in')}</Button>
    </form>
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={() => { setErr(null); setMode(reset ? 'signin' : 'reset') }}>
      {reset ? t('Sign in with password') : t('Have a reset code from your admin?')}</Button>
    {onPasskey && !reset && webauthnOK() && <>
      <div style={{ height: 8 }} />
      <Button type="button" icon="person" onClick={() => { close(); onPasskey() }}>{t('Sign in with passkey')}</Button>
    </>}
  </>
}
export const openPasswordSignIn = onPasskey => ui().openSheet(close => <PasswordSignInSheet close={close} onPasskey={onPasskey} />)

/* The password half of creating a profile. Name and invite code are the caller's state, so
   switching between passkey and password on the sign-up sheet keeps what was typed. E-mail is
   required (ISO-1596 — the same verified address passkey signup has required since ISO-1397).
   Birth date is required and under-18 blocks it outright (ISO-1521), the same rule and wording as
   the passkey half (SignupFlow.jsx). */
export function PasswordRegisterForm({ close, inviteOnly, name, setName, code, setCode }) {
  const [email, setEmail] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [terms, setTerms] = useState(false)   // never pre-ticked: acceptance is the user's own act
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const age = ageFromBirthDate(birthDate)
  const dateOK = !!birthDate && age != null && age >= MIN_PLAUSIBLE_AGE
  const minor = dateOK && isMinor(birthDate)
  const submit = async ev => {
    ev.preventDefault()
    if (busy || minor) return   // the button is disabled too, but an implicit submit must not get past this
    const n = name.trim()
    const mail = email.trim()
    const bad = !n ? t('Enter a name')
      : !mail ? t('Enter an e-mail address.')
      : !looksLikeEmail(mail) ? t('That is not an e-mail address.')
      : !dateOK ? t('Check your birth date.')
      : inviteOnly && !code.trim() ? t('An invite code is required')
      : length(pw) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : pw !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    if (!terms) return   // the button is disabled too, but an implicit submit must not get past this
    setBusy(true); setErr(null)
    try {
      const u = await passwordRegister(n, pw, code.trim(), mail, birthDate, LEGAL_VERSION)
      const st = useStore.getState()
      // The server recorded this acceptance in the same request (ISO-1390): Settings shows its
      // date from here on, not only after the next /api/me.
      st.setUser({ ...u, termsVersion: LEGAL_VERSION, termsAcceptedAt: new Date().toISOString(), needsTerms: false }); close()
      if (hasData(useStore.getState().S)) { await st.pushState(); toast(t('Profile created — data from this device moved into it')) }
      else { await st.pullState(); toast(t('Welcome, {0}', u.name)) }
    } catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }
  return <form onSubmit={submit} noValidate>
    <input className="input" name="username" autoComplete="username" placeholder={t('Your name')} maxLength={40}
      value={name} onChange={e => setName(e.target.value)} {...field} />
    <div style={{ height: 10 }} />
    <input className="input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('E-mail')} maxLength={254}
      value={email} onChange={e => setEmail(e.target.value)} {...field} />
    <div className="dim small" style={{ marginTop: 6 }}>{t('Confirms your account and is the only way to recover access if you lose this device.')}</div>
    <div style={{ height: 10 }} />
    <input className="input" type="date" name="bday" autoComplete="bday" aria-label={t('Date of birth')}
      value={birthDate} onChange={e => setBirthDate(e.target.value)} />
    {minor && <div className="small" role="alert" style={errStyle}>
      {t('Brilhart Fitness is for people 18 and older. We cannot complete your sign-up.')}
    </div>}
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={codeStyle} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 10 }} />
    <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('Password')}
      value={pw} onChange={e => setPw(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
      value={again} onChange={e => setAgain(e.target.value)} />
    <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
    <TermsCheckbox checked={terms} onChange={setTerms} />
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
    <div style={{ height: 12 }} />
    <Button type="submit" variant="primary" disabled={busy || !terms || minor}>{t('Create profile')}</Button>
  </form>
}

// The same form on its own sheet — Settings, in a browser that cannot make a passkey.
function PasswordRegisterSheet({ close }) {
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={!!config?.invite_only} name={name} setName={setName} code={code} setCode={setCode} />
  </>
}
export const openPasswordRegister = () => ui().openSheet(close => <PasswordRegisterSheet close={close} />)

/* "Confirm it is you" — what the server asks before anything that adds or takes away a way in
   (proveOwner in api/server.js): a passkey this profile already has, or its current password
   where that counts. `passkey`: the profile has one. `password`: its password counts as proof —
   set, and the instance takes passwords (GET /api/account/passkeys → `password`). Hands the body
   the server takes to `onProof` — for a removal, the removal itself — and shows the refusal,
   worded by `explain`, when that throws. For a removal this step is the confirmation too, so
   `danger` colours it and `submitText` names the action on the password's button.

   A proof is made on the tap, for the one request it goes with, and never kept. A passkey prompt
   still open when the sheet closes is called off, and whatever a prompt answers after that is
   dropped: someone who backed out of removing a passkey must not have it removed by a prompt
   they no longer see.

   `resumeAction`, when given, is the third proof (ISO-1597/ISO-1598): confirming identity with
   the Google account already linked to this profile — the only way a profile with neither a
   password nor a passkey (one created straight from a Google signup) can ever confirm anything of
   its own, including deleting itself. Shown only when the profile actually has a Google link and
   this instance still has Google configured. Unlike the other two proofs, this one leaves the
   page entirely (a full OAuth round trip) and comes back on a fresh mount, so there is no `onProof`
   to call here — `resumeAction` is plain, serialisable data (lib/google-reauth.js) describing what
   to finish once the proof is back; App.jsx's resume effect is what actually finishes it. */
export function ProveOwner({ passkey, password, onProof, explain = passwordError, danger = false, submitText, resumeAction }) {
  const name = useStore(s => s.user?.name) || ''
  const google = useStore(s => s.user?.google)
  const googleLoginOn = useStore(s => s.config?.google_login)
  const withGoogle = !!resumeAction && !!google && !!googleLoginOn
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const live = useRef(true)
  const prompt = useRef(null)   // the AbortController of a passkey prompt still open
  useEffect(() => {
    // Set here, not only initially: StrictMode unmounts and mounts again, and the first cleanup
    // must not leave the sheet thinking it is gone.
    live.current = true
    return () => { live.current = false; prompt.current?.abort() }
  }, [])
  const run = async proof => {
    if (busy) return
    setBusy(true); setErr(null)
    const ctl = new AbortController()
    prompt.current = ctl
    try {
      const body = await proof(ctl.signal)
      if (!live.current) return
      await onProof(body)
    } catch (e) {
      if (!live.current) return
      const msg = webauthnOutcome(e, 'password-confirm', 'confirm')
      if (msg !== null) setErr(msg ?? explain(e))
    } finally {
      if (prompt.current === ctl) prompt.current = null
      if (live.current) setBusy(false)
    }
  }
  const withPasskey = !!passkey && webauthnOK()
  const withPassword = ev => {
    ev.preventDefault()
    if (!pw) { setErr(t('Enter your password.')); return }
    run(async () => ({ current: pw }))
  }
  // A removal's buttons are red whichever proof carries it: each of them removes.
  const main = danger ? 'danger' : 'primary'
  const anyOther = withPasskey || password
  return <>
    {withPasskey && <Button variant={main} icon="lock" disabled={busy} onClick={() => run(signal => passkeyAssertion({ signal }))}>{t('Confirm with a passkey')}</Button>}
    {password && <form onSubmit={withPassword} noValidate>
      {withPasskey && <div className="dim small" style={{ margin: '14px 0 8px', textAlign: 'center' }}>{t('or with your password')}</div>}
      {/* Tells a password manager which account the password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
      <input className="input" type="password" name="current-password" autoComplete="current-password" placeholder={t('Current password')}
        value={pw} onChange={e => setPw(e.target.value)} />
      <div style={{ height: 10 }} />
      <Button type="submit" variant={withPasskey && !danger ? 'plain' : main} disabled={busy}>{submitText || t('Continue')}</Button>
    </form>}
    {withGoogle && <>
      {anyOther && <div className="dim small" style={{ margin: '14px 0 8px', textAlign: 'center' }}>{t('or')}</div>}
      <GoogleButton label={t('Confirm with Google')} onClick={() => beginGoogleAuth('reauth', resumeAction)} />
    </>}
    {/* A profile with no passkey whose password no longer counts — the instance switched
        passwords off — and no Google link either has nothing left to answer with
        (docs/SELF_HOSTING.md). */}
    {!withPasskey && !password && !withGoogle && <div className="dim small">{passkey
      ? t('This browser cannot confirm with your passkey. Do this on a device that holds one.')
      : t('This profile has no passkey, and this server does not take passwords, so nothing here can confirm that it is you. Ask your admin.')}</div>}
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
  </>
}

/* Settings' account rows read the server as the screen opens. One that found the server down
   has nothing to show, and stayed missing until Settings was left and opened again, while the
   block above it already said "All synced". It asks again whenever the store hears from the
   server — a push or pull that landed, a check that found both sides in step — until it gets
   an answer. A refusal (a server from before the route, a 403) is an answer: asking again
   would only get the same one. */
export const notReached = e => e?.status == null || e.status >= 500
export function useAgainOnceReached(unreached, load) {
  const reachedAt = useStore(s => s.sync?.lastSynced)
  useEffect(() => { if (unreached) load() }, [reachedAt])
}

/* ------------------------------------------------------------------- Settings -------------
   Settings → Account → Password, for a signed-in browser. A first password needs a passkey
   ceremony right now (a session on its own could be a copied cookie), or — a profile with
   neither a passkey nor a password, created straight from a Google signup (ISO-1597/ISO-1598) —
   a reauthentication with the Google account already linked to it; a change needs the current
   password, or the passkey when it was forgotten. Saving signs every other device out, which the
   sheet says before anyone taps. */
// `version` changes when the profile's passkeys do (Settings, components/Passkeys.jsx): whether the
// password may be removed depends on them, so the row asks again.
export function PasswordRow({ version = 0 }) {
  const [st, setSt] = useState(null)   // GET /api/account/password
  const [unreached, setUnreached] = useState(false)
  const google = useStore(s => s.user?.google)
  const googleLoginOn = useStore(s => s.config?.google_login)
  const load = () => api('/api/account/password').then(r => { setSt(r); setUnreached(false) }).catch(e => setUnreached(notReached(e)))
  useEffect(() => { load() }, [version])
  useAgainOnceReached(unreached, load)
  if (!st) return null
  // Nothing here could confirm a first password without an existing passkey or a linked Google
  // account (ISO-1598) — a profile with neither has nothing to set it with yet.
  const canFirstSet = (webauthnOK() && st.passkeys > 0) || (google && googleLoginOn)
  if (!st.set && !canFirstSet) return null
  const blocked = !st.set && st.nameTaken
  const subtitle = blocked ? t('Another profile already signs in with this name.')
    : st.set ? t('Set · sign in as “{0}”', st.name)
    : t('Not set — lets you sign in where passkeys do not work.')
  return <Row icon="key" iconTint="var(--orange)" title={t('Password')} subtitle={subtitle} accessory={blocked ? 'none' : 'chevron'}
    onClick={blocked ? undefined : () => ui().openSheet(close => <PasswordSheet status={st} close={close} done={load} />)} />
}

export function PasswordSheet({ status, close, done }) {
  const google = useStore(s => s.user?.google)
  const googleLoginOn = useStore(s => s.config?.google_login)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const validate = () => length(next) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
    : next !== again ? t('The two passwords are not the same.')
    : null
  const save = async withPasskey => {
    if (busy) return
    const bad = !withPasskey && !status.set && !current ? t('Enter your password.') : validate()
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      const proof = withPasskey ? await passkeyAssertion() : { current }
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ next, ...proof }) })
      close(); done()
      toast(t('Password saved — you are signed out everywhere else.'))
    } catch (e) {
      const msg = webauthnOutcome(e, 'password-confirm', 'save')
      if (msg !== null) setErr(msg ?? passwordError(e))
    } finally { setBusy(false) }
  }
  // A profile with neither a passkey nor a password confirms this one with Google instead
  // (ISO-1598's "ProveOwner com Google"): validated here, before the redirect, since nothing
  // typed survives the round trip except what travels inside `resumeAction` itself.
  const withGooglePasskeyless = !status.set && !(webauthnOK() && status.passkeys > 0) && google && googleLoginOn
  const goGoogle = () => {
    const bad = validate()
    if (bad) { setErr(bad); return }
    beginGoogleAuth('reauth', { kind: 'set-password', next })
  }
  const remove = () => ui().openSheet(c => <RemovePasswordSheet status={status} close={c} done={() => { close(); done() }} />)
  return <>
    <h3>{status.set ? t('Change password') : t('Set a password')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Sign in as “{0}” with it on devices where passkeys do not work. Saving signs you out everywhere else, and paired phones have to be paired again.', status.name)}
    </div>
    <form onSubmit={ev => { ev.preventDefault(); withGooglePasskeyless ? goGoogle() : save(!status.set) }} noValidate>
      {/* Tells a password manager which account the new password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={status.name} readOnly hidden />
      {status.set && <>
        <input className="input" type="password" name="current-password" autoComplete="current-password" placeholder={t('Current password')}
          value={current} onChange={e => setCurrent(e.target.value)} />
        <div style={{ height: 10 }} />
      </>}
      <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('New password')}
        value={next} onChange={e => setNext(e.target.value)} />
      <div style={{ height: 10 }} />
      <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
        value={again} onChange={e => setAgain(e.target.value)} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      {withGooglePasskeyless
        ? <GoogleButton label={t('Confirm with Google')} disabled={busy} onClick={goGoogle} />
        : <Button type="submit" variant="primary" disabled={busy}>{status.set ? t('Save') : t('Confirm with passkey & save')}</Button>}
    </form>
    {status.set && status.passkeys > 0 && webauthnOK() && <>
      <div style={{ height: 8 }} />
      <Button type="button" variant="ghost" className="dim" disabled={busy} onClick={() => save(true)}>{t('Forgot it? Confirm with your passkey instead')}</Button>
    </>}
    {status.set && status.passkeys > 0 && <>
      <div style={{ height: 8 }} />
      <button type="button" className="btn danger" disabled={busy} onClick={remove}>{t('Remove password')}</button>
    </>}
  </>
}

/* Removing the password asks for the proof setting one does (proveOwner in api/server.js): a
   copied session must not take away the owner's way in where passkeys do not work. The proof is
   the confirmation, so it is asked on the sheet that says what removing means — the password
   itself, or a passkey of this profile. Only offered while a passkey remains (the last way in
   stays), and the password counts here: this row exists only while the instance takes them. */
function RemovePasswordSheet({ status, close, done }) {
  const remove = async proof => {
    await api('/api/account/password', { method: 'DELETE', body: JSON.stringify(proof) })
    close(); done()
    toast(t('Password removed'))
  }
  return <>
    <h3>{t('Remove your password?')}</h3>
    <div className="muted small" style={{ marginBottom: 6 }}>{t('Only your passkeys sign in to this profile afterwards.')}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey={status.passkeys > 0} password danger submitText={t('Remove')} onProof={remove} resumeAction={{ kind: 'remove-password' }} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
