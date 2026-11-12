// ProveOwner's third option (ISO-1597/ISO-1598): confirming identity with the Google account
// already linked to this profile, for someone with neither a password nor a passkey. The proof
// itself only exists after a full-page round trip to accounts.google.com and back — by the time it
// comes back there is no closure left to resume, so whatever the tap was for has to survive the
// reload as plain, serialisable data, not a function. `kind` is what App.jsx's resume effect reads
// back to make the one request the action needed all along (api.js's resumeGoogleReauth); `next`/
// `email` ride along only for the actions that need a value typed before the redirect
// ('set-password', 'set-email'). 'add-passkey' is the one kind that resume does not finish outright
// — a WebAuthn ceremony needs its own fresh tap, which a browser navigation cannot carry forward
// (see components/Passkeys.jsx).
const KEY = 'gauth_reauth_pending'

export function savePendingReauth(action) {
  try { sessionStorage.setItem(KEY, JSON.stringify(action)) }
  catch { /* private/incognito mode: the reauth still happens, it just cannot resume anything */ }
}

export function takePendingReauth() {
  let raw = null
  try { raw = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY) }
  catch { return null }
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// `#/entrar?google=ok` (login/signup) or `#/configuracoes?google=reauth-ok&proof=…` (link/reauth) —
// api/server.js's own result code, and, reauth only, the one-time proof for OwnerProof.googleProof.
export function parseGoogleCallback(search) {
  const p = new URLSearchParams(search)
  const google = p.get('google')
  return google ? { google, proof: p.get('proof') || null } : null
}
