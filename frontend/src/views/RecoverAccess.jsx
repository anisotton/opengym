// #/recuperar?token= (ISO-1398): "Perdi meu acesso" (Login.jsx) -> POST /api/recover/request ->
// this link, mailed to that address -> POST /api/recover/redeem. A redeemed token is burned for
// one device-link code ({code, expires}, api/server.js) — the exact shape App.jsx's own
// `linkCode` effect already knows how to finish (DeviceLinkRedeemSheet: fetch the challenge,
// create the passkey, verify), so success here just hands the code to that store field instead
// of duplicating the WebAuthn ceremony. Reachable signed in or signed out: App.jsx renders this
// ahead of the authed/Login branch, since the person opening the mailed link has usually lost
// access to any signed-in session on this device. See EmailVerify.jsx for why "expired" and
// "already used" collapse into one generic failure state here too (same anti-enumeration
// contract, api/server.js's POST /api/recover/redeem).
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { recoverRedeem } from '../lib/api.js'
import { Button } from '../components/ui.jsx'
import logoColor from '../assets/brand/brilhart-fitness-vertical-cor.svg'
import logoNegative from '../assets/brand/brilhart-fitness-vertical-negativo.svg'

const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

export default function RecoverAccess() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [state, setState] = useState('checking')   // 'checking' | 'ready' | 'invalid'
  useEffect(() => {
    const token = (params.get('token') || '').trim()
    if (!token) { setState('invalid'); return }
    recoverRedeem(token)
      .then(r => { useStore.setState({ linkCode: r.code }); setState('ready') })
      .catch(() => setState('invalid'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const head = <h1 className="brand-logo">
    <img className="on-light" src={logoColor} alt="Brilhart Fitness" />
    <img className="on-dark" src={logoNegative} alt="Brilhart Fitness" />
  </h1>
  return <div className="narrow" style={wrap}>
    {head}
    {state === 'checking' && <div className="muted">{t('Checking your link…')}</div>}
    {/* App.jsx's linkCode effect opens the device-link sheet itself the moment `ready` + this
        code land together — this line is what the person sees underneath it. */}
    {state === 'ready' && <div className="muted">{t('Create a passkey on this device to finish.')}</div>}
    {state === 'invalid' && <>
      <div className="muted" style={{ marginBottom: 20 }}>{t('That link is invalid or expired.')}</div>
      <Button variant="primary" onClick={() => nav('/home')}>{t('Open Brilhart Fitness')}</Button>
    </>}
  </div>
}
