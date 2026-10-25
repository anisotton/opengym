// Settings → Account → "Jeitos de entrar" → Google (ISO-1595 §5, ISO-1597/ISO-1598): linking,
// unlinking, and the read-only row Capacitor (or an instance that switched Google off) still gets
// once a link already exists — the row itself goes through the same "vanishes entirely" rule as
// Password/Passkeys whenever this instance has no Google configured at all.
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { googleLinkStart, unlinkGoogle } from '../lib/api.js'
import { MOBILE } from '../lib/mobile.js'
import { passwordError, ProveOwner } from './PasswordAuth.jsx'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const errStyle = { color: 'var(--red)', marginTop: 10 }
// "linked 18 Oct 2026" — same shape as Passkeys.jsx's own `when()`, a full ISO instant.
const when = iso => { try { return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return '' } }

/* `user` is the store's own (GET /api/me's `google`, always present once ISO-1597 shipped —
   null until a link exists). `googleOn` is config.google_login. `passkeysState` is the same
   GET /api/account/passkeys answer the Password/Passkeys rows already read, reused here only
   for the proof Unlinking asks — no extra request. */
export function GoogleRow({ user, googleOn, passkeysState }) {
  if (!googleOn) return null
  const linked = user?.google || null
  // Google refuses OAuth inside a WebView (docs/MOBILE.md) — neither action can run there, so an
  // unlinked Capacitor profile has nothing to show; one already linked still gets to see it.
  if (MOBILE && !linked) return null
  const subtitle = linked ? t('{0} · linked {1}', linked.email, when(linked.linkedAt)) : t('Not linked')
  if (MOBILE) return <Row icon="globe" iconTint="var(--blue)" title="Google" subtitle={subtitle} />
  return <Row icon="globe" iconTint="var(--blue)" title="Google" subtitle={subtitle} accessory="chevron"
    onClick={() => ui().openSheet(close => linked
      ? <UnlinkGoogleSheet linked={linked} passkeysState={passkeysState} close={close} />
      : <LinkGoogleSheet close={close} />)} />
}

// 4.5's own step 1: the proof, then the redirect — never the other order, since a bare GET could
// carry neither a passkey assertion nor a password. Nothing here can offer "Confirm with Google"
// (ProveOwner's third proof): there is no link yet to reauthenticate against.
function LinkGoogleSheet({ close }) {
  const link = async proof => {
    const { url } = await googleLinkStart(proof)
    window.location.href = url
  }
  const explain = e => e?.data?.code === 'already-linked'
    ? t('This Google account is already linked to a different profile.')
    : passwordError(e)
  return <>
    <h3>{t('Link Google')}</h3>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey password onProof={link} explain={explain} submitText={t('Continue')} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}

// ISO-1595 §5's own "last way in" refusal — the generic wording, not PasswordAuth.jsx's
// password-specific one: the only way in being removed here may be a passkey-less,
// password-less, Google-only profile, for which "this password" would simply be wrong.
const explainUnlink = e => e?.data?.code === 'last-way-in'
  ? t('This is the only way into your profile, so it cannot be removed.')
  : passwordError(e)

function UnlinkGoogleSheet({ linked, passkeysState, close }) {
  const remove = async proof => {
    await unlinkGoogle(proof)
    useStore.getState().setUser({ ...useStore.getState().user, google: null })
    close()
    toast(t('Google unlinked.'))
  }
  return <>
    <h3>{t('Unlink Google?')}</h3>
    <div className="small" style={{ marginBottom: 6, fontWeight: 600, overflowWrap: 'anywhere' }}>{linked.email}</div>
    <div className="muted small" style={{ marginBottom: 6 }}>{t('Afterwards, Google sign-in stops working for this profile. Your password and passkeys keep working.')}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey={passkeysState?.passkeys?.length > 0} password={!!passkeysState?.password} explain={explainUnlink} danger submitText={t('Unlink Google')} onProof={remove} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
