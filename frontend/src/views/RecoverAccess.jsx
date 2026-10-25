// #/recuperar?token= (ISO-1398, redesigned by ISO-1595 §3.2/ISO-1596/ISO-1598): "Esqueci minha
// senha" / "Perdi meu acesso" (Login.jsx) -> POST /api/recover/request -> this link, mailed to
// that address -> POST /api/recover/redeem. The token is single-use either way (api/server.js) —
// with `password_login` on, it is a choice between setting a new password (burns it on submit)
// and creating a passkey (burns it on tap, exactly as before); with it off, there is only one
// path, and it still redeems on load the way it always has. Either way, the token must NOT be
// spent just by opening this screen with password_login on — only by the person actually
// choosing something — so the redeem call moves from this component's mount to whichever action
// they take. Reachable signed in or signed out: App.jsx renders this ahead of the authed/Login
// split, since the person opening the mailed link has usually lost access to any signed-in
// session on this device. A redeemed token for a passkey is burned for one device-link code
// ({code, expires}, api/server.js) — the exact shape App.jsx's own `linkCode` effect already
// knows how to finish (DeviceLinkRedeemSheet). See EmailVerify.jsx for why "expired" and "already
// used" collapse into one generic failure state here too (anti-enumeration contract).
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { recoverRedeem, webauthnOK } from '../lib/api.js'
import { passwordOn, passwordError, MIN_PASSWORD } from '../components/PasswordAuth.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { Button } from '../components/ui.jsx'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }
const errStyle = { color: 'var(--red)', marginTop: 10 }
const length = s => [...String(s || '')].length

// "Definir nova senha" (ISO-1595 §3.2): the same screen, its two choices replaced by the form —
// never a sheet over the page, which stacked-sheet problems elsewhere in this app (CHANGELOG)
// already warn against on a page a full-page redirect might still be mid-flight on.
function SetPasswordForm({ token, onBack, onDone }) {
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const bad = length(next) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : next !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    // This call is the one that spends the token on this path — not the mount, not typing.
    try { onDone(await recoverRedeem(token, next)) }
    catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }
  return <form onSubmit={submit} noValidate>
    <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('New password')}
      value={next} onChange={e => setNext(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
      value={again} onChange={e => setAgain(e.target.value)} />
    <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
    <div style={{ height: 12 }} />
    <Button type="submit" variant="primary" disabled={busy}>{t('Set password & sign in')}</Button>
    <div style={{ height: 8 }} />
    {/* Only possible before this form is submitted — once "Set password & sign in" has been
        tapped and answered (success, or a token already spent by a concurrent tab), the token
        itself is gone either way and there is nothing left to go back to. */}
    <Button type="button" variant="ghost" className="dim" disabled={busy} onClick={onBack}>{t('Create a passkey instead')}</Button>
  </form>
}

export default function RecoverAccess() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const config = useStore(s => s.config)
  const pwOn = passwordOn(config)
  const token = (params.get('token') || '').trim()
  // 'choosing' (password_login on, nothing spent yet) | 'password-form' | 'redeeming' (the
  // passkey path, or password_login off) | 'ready' (device-link code landed) | 'invalid'
  const [state, setState] = useState(!token ? 'invalid' : pwOn ? 'choosing' : 'redeeming')
  const [busy, setBusy] = useState(false)

  const redeemForPasskey = async () => {
    if (busy) return
    setBusy(true)
    try { useStore.setState({ linkCode: (await recoverRedeem(token)).code }); setState('ready') }
    catch { setState('invalid') }
    finally { setBusy(false) }
  }
  // password_login off: the same single path this screen has always had — redeem on load.
  useEffect(() => { if (!pwOn && token) redeemForPasskey() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const signedInWithPassword = async r => {
    useStore.getState().setUser(r.user, { adopt: true })
    await useStore.getState().adoptProfile(askAddDeviceData)
    useUI.getState().toast(t('Welcome back, {0}', r.user.name))
    nav('/home')
  }

  const head = <h1 className="brand-logo">
    <img className="on-light" src={logoColor} alt="Brilhart Fitness" />
    <img className="on-dark" src={logoNegative} alt="Brilhart Fitness" />
  </h1>

  return <div className="narrow" style={wrap}>
    {head}
    {state === 'redeeming' && <div className="muted">{t('Checking your link…')}</div>}
    {state === 'choosing' && <>
      <div className="muted" style={{ marginBottom: 20 }}>{t('Choose how you want to get back in.')}</div>
      <Button variant="primary" onClick={() => setState('password-form')}>{t('Set a new password')}</Button>
      {webauthnOK() && <>
        <div style={{ height: 10 }} />
        <Button disabled={busy} onClick={redeemForPasskey}>{t('Create a passkey on this device')}</Button>
      </>}
    </>}
    {state === 'password-form' && <SetPasswordForm token={token} onBack={() => setState('choosing')} onDone={signedInWithPassword} />}
    {/* App.jsx's linkCode effect opens the device-link sheet itself the moment `ready` + this
        code land together — this line is what the person sees underneath it. */}
    {state === 'ready' && <div className="muted">{t('Create a passkey on this device to finish.')}</div>}
    {state === 'invalid' && <>
      <div className="muted" style={{ marginBottom: 20 }}>{t('That link is invalid or expired.')}</div>
      <Button variant="primary" onClick={() => nav('/home')}>{t('Open Brilhart Fitness')}</Button>
    </>}
  </div>
}
