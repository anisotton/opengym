// #/verificar-email?token= (ISO-1398): the link api/server.js's mailEmail (confirmation mail)
// points at. Reachable signed in or signed out — App.jsx renders this ahead of the
// authed/Login branch, same reasoning as RecoverAccess.jsx. api/server.js's
// POST /api/account/email/verify collapses every failure (unknown, expired, already-used token)
// into the same { code: 'token-invalid' } on purpose (ISO-1397 anti-enumeration) — so unlike the
// three states the spec asks for (success, expired, already-used), the server can only ever give
// two: success, or one generic "no longer valid". The one thing this screen does know on its
// own is whether the signed-in account is already confirmed, which is what an old link opened
// after the fact looks like — that case is shown as the good news it is, not as a failure.
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { accountEmailVerify } from '../lib/api.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { ResendEmailButton } from '../components/AccountEmail.jsx'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

export default function EmailVerify() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const [state, setState] = useState('checking')   // 'checking' | 'ok' | 'invalid'
  useEffect(() => {
    const token = (params.get('token') || '').trim()
    if (!token) { setState('invalid'); return }
    accountEmailVerify(token)
      .then(() => {
        if (user) useStore.getState().setUser({ ...user, emailVerified: true })
        setState('ok')
      })
      .catch(() => setState('invalid'))
    // Intentionally once: re-running on a user/token change would re-spend a token that already
    // got its answer, for no benefit — the result does not change on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const head = <h1 className="brand-logo">
    <img className="on-light" src={logoColor} alt="Brilhart Fitness" />
    <img className="on-dark" src={logoNegative} alt="Brilhart Fitness" />
  </h1>
  // A refused token with the account already confirmed on this device: the link was simply used
  // (or superseded) after the job was done — good news, said as such.
  const already = state === 'invalid' && !!user?.emailVerified
  // Signed in with the address still pending, the fix is right here: a fresh link, no detour
  // through Settings. Signed out, the app is the only place to ask for one.
  const canResend = state === 'invalid' && !already && !!user?.email && !user.emailVerified
  const open = <Button variant={canResend ? 'plain' : 'primary'} onClick={() => nav('/home')}>{t('Open Brilhart Fitness')}</Button>
  return <div className="narrow" style={wrap}>
    {head}
    {state === 'checking' && <>
      <div className="vfy-mark pending" aria-hidden="true"><Icon name="envelope" /></div>
      <h2 className="t-title vfy-title">{t('Confirming…')}</h2>
      <div className="muted vfy-text">{t('Just a moment.')}</div>
    </>}
    {(state === 'ok' || already) && <>
      <div className="vfy-mark ok" aria-hidden="true"><Icon name="check" /></div>
      <h2 className="t-title vfy-title">{t('E-mail confirmed.')}</h2>
      <div className="muted vfy-text">
        {already ? t('Your e-mail was already confirmed.') : t('Your account is confirmed. If you ever lose this device, this e-mail is how you get back in.')}
      </div>
      {open}
    </>}
    {state === 'invalid' && !already && <>
      <div className="vfy-mark bad" aria-hidden="true"><Icon name="clock" /></div>
      <h2 className="t-title vfy-title">{t('This link no longer works')}</h2>
      <div className="muted vfy-text">{t('It expired or was already used. Ask for a new one and open the latest e-mail.')}</div>
      {canResend && <><ResendEmailButton variant="primary" label={t('Send a new link')} /><div style={{ height: 10 }} /></>}
      {open}
    </>}
  </div>
}
