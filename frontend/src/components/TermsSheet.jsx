// "We updated our terms" (ISO-1390): a signed-in account whose accepted version is behind the
// server's current one sees this, locked — no close button, no backdrop/swipe/Escape — until it
// accepts. App.jsx decides when (online, once per visit); this sheet only owns the answer.
//
// The version sent is always this bundle's own LEGAL_VERSION, never the server's: acceptance is
// of the text this app can actually show. When the server is already on a newer one (announced
// in /api/config, or refused as stale) the only honest way forward is a newer app, so the accept
// button gives way to "update the app" instead of a loop of refusals.
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { termsAccept } from '../lib/api.js'
import { MOBILE } from '../lib/mobile.js'
import { LEGAL_VERSION } from '../legal/version.js'
import { useUI } from '../store/useUI.js'
import { openLegalSheet } from './LegalText.jsx'
import { Button } from './ui.jsx'

export function TermsSheet({ close }) {
  const config = useStore(s => s.config)
  const [stale, setStale] = useState(() => !!config?.legal_version && config.legal_version !== LEGAL_VERSION)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const accept = async () => {
    setErr(null); setBusy(true)
    try {
      const r = await termsAccept(LEGAL_VERSION)
      const st = useStore.getState()
      st.setUser({ ...st.user, termsVersion: r.termsVersion, termsAcceptedAt: r.termsAcceptedAt, needsTerms: false })
      close()
    } catch (e) {
      if (e?.data?.code === 'terms-version-stale') setStale(true)
      // Anything else — usually no network: the sheet stays, and says why nothing happened.
      else setErr(t('Could not save your acceptance — are you online?'))
    } finally { setBusy(false) }
  }
  return <>
    <h3>{t('We updated our terms')}</h3>
    <p>{t('To keep using Brilhart Fitness, read and accept the current Terms of Use and Privacy Policy.')}</p>
    <div className="small" style={{ marginBottom: 12 }}>
      <button type="button" className="linklike" onClick={() => openLegalSheet('termos')}>{t('Read the Terms of Use')}</button>
      {' · '}
      <button type="button" className="linklike" onClick={() => openLegalSheet('privacidade')}>{t('Read the Privacy Policy')}</button>
    </div>
    {stale ? <>
      <p role="status">{t('Update the app to accept the new terms.')}</p>
      {/* The phone app updates through its store, not a reload; the web build is one reload away. */}
      {!MOBILE && <Button onClick={() => window.location.reload()}>{t('Reload')}</Button>}
    </> : <>
      {err && <div role="alert" className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
      <Button variant="primary" disabled={busy} onClick={accept}>{t('Accept and continue')}</Button>
    </>}
  </>
}

export const openTermsSheet = () => useUI.getState().openSheet(close => <TermsSheet close={close} />, { locked: true })
