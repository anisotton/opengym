// #/verificar-email?token= (ISO-1398): the link api/server.js's mailEmail (confirmation mail)
// points at. Reachable signed in or signed out — App.jsx renders this ahead of the
// authed/Login branch, same reasoning as RecoverAccess.jsx. api/server.js's
// POST /api/account/email/verify collapses every failure (unknown, expired, already-used token)
// into the same { code: 'token-invalid' } on purpose (ISO-1397 anti-enumeration) — so unlike the
// three states the spec asks for (success, expired, already-used), this can only ever show two:
// success, or one generic "that link is no longer valid" state. Flagged for Atena's review.
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { accountEmailVerify } from '../lib/api.js'
import { Button } from '../components/ui.jsx'
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
  return <div className="narrow" style={wrap}>
    {head}
    {state === 'checking' && <div className="muted">{t('Confirming…')}</div>}
    {state === 'ok' && <>
      <div className="muted" style={{ marginBottom: 20 }}>{t('E-mail confirmed.')}</div>
      <Button variant="primary" onClick={() => nav('/home')}>{t('Open Brilhart Fitness')}</Button>
    </>}
    {state === 'invalid' && <>
      <div className="muted" style={{ marginBottom: 20 }}>{t('That link is invalid or expired.')}</div>
      <Button variant="primary" onClick={() => nav('/home')}>{t('Open Brilhart Fitness')}</Button>
    </>}
  </div>
}
