import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, webauthnOK, passkeyLogin, passwordLogin, beginGoogleAuth, registerGoogle } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { MOBILE } from '../lib/mobile.js'
import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Segmented } from '../components/ui.jsx'
import GoogleButton from '../components/GoogleButton.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { passwordOn, PasswordRegisterForm, passwordError, webauthnOutcome } from '../components/PasswordAuth.jsx'
import SignupFlow from '../components/SignupFlow.jsx'
import { openRecoverRequest } from '../components/AccountEmail.jsx'
import { ageFromBirthDate, isMinor, MIN_PLAUSIBLE_AGE } from '../lib/age.js'
import TermsCheckbox from '../components/TermsCheckbox.jsx'
import { LEGAL_VERSION } from '../legal/version.js'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

// ISO-1480 (Atena review): the classifier's sentences run long (a certificate explanation is
// ~230 characters) and the one thing this screen cannot assume is that a first-time visitor
// glances at exactly the right moment — the 2.2s toast every other message here uses is built for
// "Welcome back", not for the one message someone actually needs to read and act on. Persistent,
// role="alert" text in the flow itself, same shape as every other real WebAuthn call site
// (SignupFlow.jsx, Passkeys.jsx, PasswordAuth.jsx) — never the toast, which is still right for
// "Welcome back, {name}" right above it.
const errStyle = { color: 'var(--red)', marginTop: 10, textAlign: 'start' }
const field = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const inviteOnly = !!config?.invite_only
  const googleOn = !!config?.google_login && !MOBILE
  // A password is offered only where the instance allows it (#118), and is the only choice in a
  // browser that cannot make a passkey. Where both work, the passkey stays the first one.
  const pwOn = passwordOn(config)
  const [how, setHow] = useState(webauthnOK() ? 'passkey' : 'password')
  // Boot already fetched this; retry here only if that attempt failed, so the invite field still
  // appears on an instance whose config arrived late rather than never.
  useEffect(() => { loadConfig() }, [loadConfig])
  const onCreated = async u => {
    setUser(u)
    if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
    else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
  }
  const choose = pwOn && webauthnOK() && <>
    <Segmented options={[{ value: 'passkey', label: t('Passkey'), icon: 'fingerprint' }, { value: 'password', label: t('Password'), icon: 'key' }]}
      value={how} onChange={setHow} />
    <div style={{ height: 12 }} />
  </>
  const google = googleOn && <>
    <div style={{ height: 10 }} />
    <GoogleButton label={t('Continue with Google')} onClick={() => beginGoogleAuth('signup')} />
  </>
  if (pwOn && how === 'password') return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={inviteOnly} name={name} setName={setName} code={code} setCode={setCode} />
    {google}
  </>
  return <>
    <SignupFlow name={name} setName={setName} code={code} setCode={setCode} inviteOnly={inviteOnly} close={close}
      onCreated={onCreated} header={<>{<h3>{t('Create your profile')}</h3>}{choose}</>} />
    {google}
  </>
}

// "Completar cadastro" (ISO-1595 §4.1): the one account-creation path that starts from a signed,
// pending ticket (gauth_signup cookie) instead of a WebAuthn ceremony or a typed password —
// Google already proved the e-mail, so only name/birth date/Terms (and an invite, if the instance
// needs one) are left to collect. `prefill` is the `name`/`email` the callback put in the query
// string (api/server.js's own `done('signup', { name, email })`).
function CompleteGoogleSignup({ prefill, onDone }) {
  const config = useStore(s => s.config)
  const inviteOnly = !!config?.invite_only
  const [name, setName] = useState(prefill.name || '')
  const [code, setCode] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [terms, setTerms] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const age = ageFromBirthDate(birthDate)
  const dateOK = !!birthDate && age != null && age >= MIN_PLAUSIBLE_AGE
  const minor = dateOK && isMinor(birthDate)
  const submit = async ev => {
    ev.preventDefault()
    if (busy || minor) return
    const bad = !name.trim() ? t('Enter a name')
      : !dateOK ? t('Check your birth date.')
      : inviteOnly && !code.trim() ? t('An invite code is required')
      : null
    if (bad) { setErr(bad); return }
    if (!terms) return
    setBusy(true); setErr(null)
    try { onDone(await registerGoogle({ name: name.trim(), code: code.trim(), birthDate, termsVersion: LEGAL_VERSION })) }
    catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }
  return <div className="narrow">
    <h3>{t('Almost there')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('We still need your birth date and your acceptance of the Terms to finish.')}</div>
    <form onSubmit={submit} noValidate>
      <input className="input" name="username" autoComplete="username" placeholder={t('Your name')} maxLength={40}
        value={name} onChange={e => setName(e.target.value)} {...field} />
      <div style={{ height: 10 }} />
      {/* Already confirmed by Google — fixed text, not an editable field, and never asked to
          confirm again. */}
      <div className="dim small" style={{ marginBottom: 10, overflowWrap: 'anywhere' }}>{prefill.email}</div>
      <input className="input" type="date" name="bday" autoComplete="bday" aria-label={t('Date of birth')}
        value={birthDate} onChange={e => setBirthDate(e.target.value)} />
      {minor && <div className="small" role="alert" style={errStyle}>
        {t('Brilhart Fitness is for people 18 and older. We cannot complete your sign-up.')}
      </div>}
      {inviteOnly && <>
        <div style={{ height: 10 }} />
        <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
          onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      </>}
      <TermsCheckbox checked={terms} onChange={setTerms} />
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy || !terms || minor}>{t('Finish creating your profile')}</Button>
    </form>
  </div>
}

export default function Login() {
  const { setUser, setUserFromMe, adoptProfile, setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const pwOn = passwordOn(config)
  const googleOn = !!config?.google_login && !MOBILE
  const [err, setErr] = useState(null)
  const [identifier, setIdentifier] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [params, setParams] = useSearchParams()
  const google = params.get('google')
  const [googleBusy, setGoogleBusy] = useState(false)
  const register = () => useUI.getState().openSheet(close => <RegisterSheet close={close} />)

  const afterSignIn = async (u, toastMsg) => {
    // login/verify and login/password answer only {id,name,admin} — unlike boot()'s GET /api/me,
    // which also carries email/emailVerified/needsEmail/google (ISO-1397/1596/1597) and the terms
    // fields (ISO-1390). Asked for here too, so the reminder banner, Settings' row and the terms
    // sheet are right from this sign-in on, not only after the next full reload. A failure here
    // still leaves a signed-in user; the fields just catch up on the next boot.
    const me = await api('/api/me').catch(() => null)
    if (me) setUserFromMe(me, u, { adopt: true }); else setUser(u, { adopt: true })
    await adoptProfile(askAddDeviceData)
    useUI.getState().toast(toastMsg)
  }
  const signIn = async () => {
    setErr(null)
    try { const u = await passkeyLogin(); await afterSignIn(u, t('Welcome back, {0}', u.name)) }
    catch (e) {
      const msg = webauthnOutcome(e, 'login', 'assertion')
      if (msg !== null) setErr(msg ?? (e.message || t('Sign-in failed')))
    }
  }
  const passwordSubmit = async ev => {
    ev.preventDefault()
    if (busy) return
    const id = identifier.trim()
    const bad = !id ? t('Enter your name or e-mail.') : !pw ? t('Enter your password.') : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      const u = await passwordLogin(id, pw)
      await afterSignIn(u, t('Welcome back, {0}', u.name))
    } catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }

  // Google's own redirect back (ISO-1595 §4): a full-page navigation, never a popup, so by the
  // time any of this runs the tab that showed the button is gone and this is a fresh mount. `ok`/
  // `linked` already carry a fresh session cookie (api/server.js's own callback) — nothing left to
  // sign in with, just the same /api/me merge every other sign-in path does.
  useEffect(() => {
    if (google !== 'ok' && google !== 'linked') return
    let cancelled = false
    setGoogleBusy(true)
    api('/api/me').then(async me => {
      if (cancelled) return
      setUserFromMe(me, me.user, { adopt: true })
      await adoptProfile(askAddDeviceData)
      useUI.getState().toast(google === 'linked' ? t('Signed in — your profile is now linked with Google.') : t('Welcome back, {0}', me.user.name))
    }).catch(() => { if (!cancelled) setErr(t("We couldn't complete sign-in with Google. Try again, or use your e-mail and password.")) })
      .finally(() => { if (!cancelled) { setGoogleBusy(false); setParams({}, { replace: true }) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google])
  // `cancelled` (ISO-1595 §4.6): a real decline, never an error — the screen just goes back to
  // normal, in silence, same philosophy as webauthnOutcome's own silent dismissal. `disabled`/the
  // generic fallback (§4.4/§4.7) show through the same persistent alert every other sign-in
  // failure here uses, worded to match whether this instance even offers a password.
  useEffect(() => {
    if (!google || google === 'ok' || google === 'linked' || google === 'signup' || google === 'email-unverified') return
    if (google === 'disabled') setErr(t('This account has been disabled.'))
    else if (google !== 'cancelled') {
      setErr(pwOn
        ? t("We couldn't complete sign-in with Google. Try again, or use your e-mail and password.")
        : t("We couldn't complete sign-in with Google. Try again, or use a passkey."))
    }
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google])

  const head = <>
    {/* The brand guide's vertical logo: the colour version on the light theme, the negative on dark. */}
    <h1 className="brand-logo">
      <img className="on-light" src={logoColor} alt="Brilhart Fitness" />
      <img className="on-dark" src={logoNegative} alt="Brilhart Fitness" />
    </h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo. Everything stays in this browser.')}</div>
      <Button variant="primary" icon="play" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'start', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data. Nothing is sent anywhere. Passkey sign-in and sync across your devices come with the Brilhart Fitness server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  if (google === 'signup') return <CompleteGoogleSignup
    prefill={{ name: params.get('name') || '', email: params.get('email') || '' }}
    onDone={u => afterSignIn(u, t('Welcome, {0}', u.name)).then(() => setParams({}, { replace: true }))} />

  // ISO-1397 anti-hijack rule: Google proved the e-mail, not ownership of the matching Brilhart
  // Fitness account — a blocking screen, read deliberately, never a toast or an inline alert.
  if (google === 'email-unverified') return (
    <div className="narrow" style={wrap}>
      {head}
      <h3>{t('Confirm your e-mail first')}</h3>
      <div className="muted small" style={{ marginBottom: 20 }}>
        {t("There is already an account using that e-mail, but it is not confirmed yet. For your security, we can't sign you in with Google until it is. Sign in the way you did before and confirm your e-mail — then Google will work too.")}
      </div>
      <Button variant="primary" onClick={() => setParams({}, { replace: true })}>{t('Go to sign-in')}</Button>
    </div>
  )

  if (googleBusy) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted">{t('Checking your link…')}</div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Conditioning for ballet.')}</div>
      {pwOn ? <>
        <form onSubmit={passwordSubmit} noValidate>
          <input className="input" name="username" autoComplete="username" inputMode="email" placeholder={t('E-mail')} maxLength={254}
            value={identifier} onChange={e => setIdentifier(e.target.value)} {...field} />
          <div style={{ height: 10 }} />
          <input className="input" type="password" name="password" autoComplete="current-password" placeholder={t('Password')}
            value={pw} onChange={e => setPw(e.target.value)} />
          <div style={{ marginTop: 10 }}>
            <Button type="button" variant="ghost" className="dim" size="sm" onClick={() => openRecoverRequest()}>{t('Forgot your password?')}</Button>
          </div>
          {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
          <div style={{ height: 12 }} />
          <Button type="submit" variant="primary" disabled={busy}>{t('Sign in')}</Button>
        </form>
        <div style={{ height: 10 }} />
        {googleOn && <><GoogleButton label={t('Sign in with Google')} onClick={() => beginGoogleAuth('login')} /><div style={{ height: 10 }} /></>}
        {webauthnOK() && <><Button icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button><div style={{ height: 10 }} /></>}
        <Button icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
        {canGuest && <div style={{ height: 10 }} />}
      </> : webauthnOK() ? <>
        <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
        {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
        <div style={{ height: 10 }} />
        {googleOn && <><GoogleButton label={t('Sign in with Google')} onClick={() => beginGoogleAuth('login')} /><div style={{ height: 10 }} /></>}
        <Button icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
        {/* Brilhart Fitness: no "Use a code from your other device" button here. Passkeys sync
            across a person's devices, and the QR code from Settings → Add a device still opens
            the redeem sheet by itself (App.jsx, linkCode). */}
        <div style={{ height: 14 }} />
        <Button variant="ghost" className="dim" size="sm" onClick={() => openRecoverRequest()}>{t('Lost access to your device?')}</Button>
        {canGuest && <div style={{ height: 10 }} />}
      </> : <div className="card small muted" style={{ textAlign: 'start' }}>{canGuest
        ? t("This browser doesn't do passkeys, but you can still use Brilhart Fitness locally on this device.")
        // Without passkeys and without the guest entrance there is no way in from this browser,
        // so say that plainly instead of offering a local profile that cannot be created.
        : t("This browser doesn't support passkeys, and this instance requires an account. Try a browser or device with passkey support.")}</div>}
      {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Today’s strength is tomorrow’s lightness.')}</div>
    </div>
  )
}
