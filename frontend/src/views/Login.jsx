import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, webauthnOK, passkeyLogin } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { useState, useEffect } from 'react'
import { Button, Segmented } from '../components/ui.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { passwordOn, PasswordRegisterForm, openPasswordSignIn } from '../components/PasswordAuth.jsx'
import SignupFlow from '../components/SignupFlow.jsx'
import { openRecoverRequest } from '../components/AccountEmail.jsx'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const inviteOnly = !!config?.invite_only
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
    <Segmented options={[{ value: 'passkey', label: t('Passkey'), icon: 'person' }, { value: 'password', label: t('Password'), icon: 'key' }]}
      value={how} onChange={setHow} />
    <div style={{ height: 12 }} />
  </>
  if (pwOn && how === 'password') return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={inviteOnly} name={name} setName={setName} code={code} setCode={setCode} />
  </>
  return <SignupFlow name={name} setName={setName} code={code} setCode={setCode} inviteOnly={inviteOnly} close={close}
    onCreated={onCreated} header={<>{<h3>{t('Create your profile')}</h3>}{choose}</>} />
}

export default function Login() {
  const { setUser, adoptProfile, setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const pwOn = passwordOn(config)
  const register = () => useUI.getState().openSheet(close => <RegisterSheet close={close} />)
  const signIn = async () => {
    try {
      const u = await passkeyLogin()
      // login/verify answers only {id,name,admin} — unlike boot()'s GET /api/me, which also
      // carries email/emailVerified/needsEmail (ISO-1397, PASSWORD_LOGIN off only). Asked for
      // here too, so the reminder banner and Settings' row are right from this sign-in on,
      // not only after the next full reload. A failure here still leaves a signed-in user;
      // the fields just catch up on the next boot.
      const me = await api('/api/me').catch(() => null)
      setUser(me && 'needsEmail' in me ? { ...u, email: me.email, emailVerified: !!me.emailVerified, needsEmail: !!me.needsEmail } : u, { adopt: true })
      await adoptProfile(askAddDeviceData)
      useUI.getState().toast(t('Welcome back, {0}', u.name))
    }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
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
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'start', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Passkey sign-in and sync across your devices come with the Brilhart Fitness server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Conditioning for ballet.')}</div>
      {webauthnOK() ? <>
        <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
        <div style={{ height: 10 }} />
        {pwOn && <><Button icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button><div style={{ height: 10 }} /></>}
        <Button icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
        {/* Brilhart Fitness: no "Use a code from your other device" button here. Passkeys sync
            across a person's devices, and the QR code from Settings → Add a device still opens
            the redeem sheet by itself (App.jsx, linkCode). */}
        <div style={{ height: 14 }} />
        <Button variant="ghost" className="dim" size="sm" onClick={() => openRecoverRequest()}>{t('Lost access to your device?')}</Button>
        {canGuest && <div style={{ height: 10 }} />}
      </> : pwOn ? <>
        {/* Plain http on a LAN address, or a browser without passkey support: the password is
            the way in, and the only way to create a profile from here. */}
        <div className="card small muted" style={{ textAlign: 'start', marginBottom: 14 }}>{t("This browser doesn't support passkeys — sign in with your name and password instead.")}</div>
        <Button variant="primary" icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button>
        <div style={{ height: 10 }} />
        <Button icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
        {canGuest && <div style={{ height: 10 }} />}
      </> : <div className="card small muted" style={{ textAlign: 'start' }}>{canGuest
        ? t("This browser doesn't support passkeys — you can still use Brilhart Fitness locally on this device.")
        // Without passkeys and without the guest entrance there is no way in from this browser,
        // so say that plainly instead of offering a local profile that cannot be created.
        : t("This browser doesn't support passkeys, and this instance requires an account. Try a browser or device with passkey support.")}</div>}
      {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Today’s strength is tomorrow’s lightness.')}</div>
    </div>
  )
}
