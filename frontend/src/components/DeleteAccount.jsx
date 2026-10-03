// Settings → "Delete account" (ISO-1449/ISO-1394, Phase 4 — LGPD), spec by Atena in ISO-1448's
// `spec-ux` document: the account itself, server-side — not just this device's copy. Three
// sheets, the same shape RemovePasskeySheet/ProveOwner already use for "remove a way in" (what
// goes + an export offer, the proof, a final confirmation that names the account again), reusing
// the admin's own two-step pattern for the last one. The proof is captured on sheet 2 and only
// ever spent on sheet 3 — "Continue to delete" on sheet 1 never calls the server, and neither does
// a successful proof on its own; only the sheet 3 tap does, and only its 2xx wipes this device's
// copy (useStore deleteAccount, same clearing a sign-out does).
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { nav } from '../lib/nav.js'
import { useOnline } from './ServerSync.jsx'
import { ProveOwner, passwordError } from './PasswordAuth.jsx'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const errStyle = { color: 'var(--red)', marginTop: 10 }

// Settings → Account, the last row of the section (spec §1): same danger styling as "Reset
// everything" and the sign-out rows, but its subtitle already says this is more than a data
// reset, so nobody opens the flow to find that out partway through.
export function DeleteAccountRow({ doExport, doExportZip, hasMedia, passkeysState }) {
  if (!passkeysState) return null
  return <Row icon="trash" iconTint="var(--red)" title={t('Delete account')} danger
    subtitle={t('Erases everything — your data, your subscription, and the account itself.')}
    onClick={() => ui().openSheet(close =>
      <WhatGoesSheet close={close} doExport={doExport} doExportZip={doExportZip} hasMedia={hasMedia} passkeysState={passkeysState} />,
      { kind: 'center' })} />
}

// Sheet 1 — what goes, and the export offer (spec §2, "Sheet 1"). The export buttons never close
// this sheet: exporting is not a step on the way to deleting, it is the alternative to regretting
// it. Offline, there is nothing to delete yet — the local export still works.
function WhatGoesSheet({ close, doExport, doExportZip, hasMedia, passkeysState }) {
  const online = useOnline()
  const next = () => ui().openSheet(c => <ProveIdentitySheet close={c} passkeysState={passkeysState} />)
  return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>{t('Delete your account?')}</h3>
    <div className="muted" style={{ marginBottom: 14, lineHeight: 1.5, textAlign: 'start' }}>
      <div style={{ marginBottom: 6 }}>{t('This erases, for good:')}</div>
      <ul style={{ margin: '0 0 10px', paddingInlineStart: 20 }}>
        <li>{t('Your plan, workouts and body-weight history')}</li>
        <li>{t('Photos and videos on custom exercises')}</li>
        <li>{t('Your passkeys and password')}</li>
        <li>{t('Your subscription — canceled right now, with no refund for the time left on it')}</li>
      </ul>
      {t('Once deleted, nobody — not even you, not even an admin — can bring the account back.')}
    </div>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Download a copy first if you want to keep your history.')}</div>
    {!online && <div className="small" style={{ color: 'var(--orange)', marginBottom: 14 }}>{t("You're offline — connect to delete your account.")}</div>}
    <Button icon="download" onClick={doExport}>{t('Export backup (JSON)')}</Button>
    <div style={{ height: 8 }} />
    {hasMedia && <><Button icon="download" onClick={doExportZip}>{t('Export with photos & videos (.zip)')}</Button><div style={{ height: 8 }} /></>}
    <button className="btn danger" disabled={!online} onClick={next}>{t('Continue to delete')}</button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </div>
}

// Sheet 2 — the same ProveOwner RemovePasskeySheet/RemovePasswordSheet already use. No request
// carries the proof here: `onProof` only stores it and opens sheet 3, which is where the
// confirmation — and the one call that spends it — actually happens (spec §2, "Sheet 2").
function ProveIdentitySheet({ close, passkeysState }) {
  const toFinal = proof => { close(); ui().openSheet(c => <FinalConfirmSheet proof={proof} close={c} />, { kind: 'center', locked: true }) }
  return <>
    <h3>{t('Confirm it’s you')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Before deleting, confirm with a passkey or your current password.')}</div>
    <ProveOwner passkey={passkeysState.passkeys.length > 0} password={passkeysState.password} danger submitText={t('Delete account')} onProof={toFinal} />
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}

// Sheet 3 — the point of no return (spec §2, "Sheet 3"): names the account again, like the
// admin's own second delete confirm does. Locked (no backdrop/Escape dismiss) so a stray tap
// cannot lose the result of a passkey ceremony already spent. A network failure leaves the sheet
// open with nothing cleared; the last-admin refusal replaces the body with its own explanation
// and offers only Cancel, since no retry here can fix it.
function FinalConfirmSheet({ proof, close }) {
  const name = useStore(s => s.user?.name) || ''
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [lastAdmin, setLastAdmin] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true); setErr(null); setLastAdmin(false)
    try {
      await useStore.getState().deleteAccount(proof)
      ui().closeAll()
      nav('/home')
      toast(t('Account deleted'))
    } catch (e) {
      if (e?.data?.code === 'last-admin') setLastAdmin(true)
      else if (e?.status == null) setErr(t('Could not delete — are you online?'))
      else setErr(passwordError(e))
      setBusy(false)
    }
  }
  return <div style={{ textAlign: 'center', padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>{t('Delete for good?')}</h3>
    {lastAdmin ? <>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
        {t('You’re the only admin — promote someone else before deleting your account.')}
      </div>
      <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
    </> : <>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
        {t('Last chance. {0} and everything we listed is gone now, with no backup on the server.', name)}
      </div>
      <button className="btn danger" disabled={busy} onClick={run}>{t('Delete my account')}</button>
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" disabled={busy} onClick={close}>{t('Cancel')}</Button>
    </>}
  </div>
}
