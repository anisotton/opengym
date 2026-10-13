// What a rejected navigator.credentials.create()/get() actually means (ISO-1480). Until now every
// NotAllowedError/AbortError was shown as "the person cancelled" and swallowed in silence
// (Passkeys.jsx, SignupFlow.jsx, ServerSync.jsx, PasswordAuth.jsx) — right for a real tap-away, but
// the same two names also cover a prompt that never opened at all: a certificate Chrome does not
// trust (it lets the page load past "Advanced → Continue" but refuses WebAuthn outright, with a
// message naming the certificate), a device with no screen lock or no credential manager, or a
// plain non-secure origin. Those three looked identical to "nothing happened" three times in a
// row on Android. `name`/`message` come straight off the DOMException; `elapsedMs` is timed by the
// caller (lib/api.js) around the create()/get() call itself, since a real human dismissal takes
// perceptibly longer than an instant platform refusal.
const CERT_RE = /certificat|tls|ssl/i
const INSTANT_REFUSAL_MS = 500

export function classifyWebauthnFailure({ name, message } = {}, { isSecureContext = true, elapsedMs = null } = {}) {
  if (!isSecureContext) return { kind: 'insecure-context', silent: false }
  if ((name === 'NotAllowedError' || name === 'SecurityError') && CERT_RE.test(message || '')) {
    return { kind: 'cert-untrusted', silent: false }
  }
  if (name === 'NotSupportedError') return { kind: 'unsupported', silent: false }
  if (name === 'NotAllowedError' || name === 'AbortError') {
    if (elapsedMs != null && elapsedMs < INSTANT_REFUSAL_MS) return { kind: 'instant-refusal', silent: false }
    return { kind: 'dismissed', silent: true }
  }
  return { kind: 'other', silent: false }
}

// The sentence for every `kind` above except 'dismissed', which stays silent as before — a real
// tap-away is the person's answer, not an error. `t` is passed in rather than imported so this
// stays a plain function of its inputs for the test alongside it.
export function webauthnFailureText(classification, t) {
  switch (classification.kind) {
    case 'cert-untrusted':
      return t('This device does not trust this site’s security certificate, so the browser refuses to create or use a passkey here — even though the page itself opened. Ask your admin for the certificate and install it, or open the site from an address your device already trusts.')
    case 'insecure-context':
      return t('Passkeys need a secure (https) address. This page did not open over one.')
    case 'instant-refusal':
      return t('The device refused to show the passkey prompt. Check that your screen lock is set up and that a passkey manager (like Google Password Manager) is available, then try again.')
    case 'unsupported':
      return t('This browser cannot create passkeys here.')
    default:
      return null
  }
}
