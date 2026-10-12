import { describe, it, expect } from 'vitest'
import { classifyWebauthnFailure, webauthnFailureText } from './webauthn-error.js'

const t = (s) => s

describe('classifyWebauthnFailure', () => {
  it('flags a certificate-refused NotAllowedError even with no elapsed time', () => {
    const e = { name: 'NotAllowedError', message: 'WebAuthn is not supported on sites with TLS certificate errors.' }
    const c = classifyWebauthnFailure(e, { isSecureContext: true, elapsedMs: 10 })
    expect(c.kind).toBe('cert-untrusted')
    expect(c.silent).toBe(false)
  })

  it('flags a non-secure context ahead of everything else', () => {
    const e = { name: 'NotAllowedError', message: 'whatever' }
    const c = classifyWebauthnFailure(e, { isSecureContext: false, elapsedMs: 5000 })
    expect(c.kind).toBe('insecure-context')
  })

  it('flags an instant NotAllowedError with no certificate wording as a platform refusal', () => {
    const e = { name: 'NotAllowedError', message: '' }
    const c = classifyWebauthnFailure(e, { isSecureContext: true, elapsedMs: 40 })
    expect(c.kind).toBe('instant-refusal')
    expect(c.silent).toBe(false)
  })

  it('treats a slow NotAllowedError as a real dismissal, silently', () => {
    const e = { name: 'NotAllowedError', message: '' }
    const c = classifyWebauthnFailure(e, { isSecureContext: true, elapsedMs: 4000 })
    expect(c.kind).toBe('dismissed')
    expect(c.silent).toBe(true)
  })

  it('treats a slow AbortError the same way', () => {
    const e = { name: 'AbortError', message: '' }
    const c = classifyWebauthnFailure(e, { isSecureContext: true, elapsedMs: 2000 })
    expect(c.kind).toBe('dismissed')
    expect(c.silent).toBe(true)
  })

  it('flags NotSupportedError', () => {
    const c = classifyWebauthnFailure({ name: 'NotSupportedError' }, { elapsedMs: 10 })
    expect(c.kind).toBe('unsupported')
  })

  it('falls back to other for anything else, without an elapsed time', () => {
    const c = classifyWebauthnFailure({ name: 'InvalidStateError' }, {})
    expect(c.kind).toBe('other')
  })

  it('does not misclassify a real dismissal with no timing info as an instant refusal', () => {
    const c = classifyWebauthnFailure({ name: 'AbortError' }, { isSecureContext: true, elapsedMs: null })
    expect(c.kind).toBe('dismissed')
  })
})

describe('webauthnFailureText', () => {
  it('returns null for a silent dismissal', () => {
    expect(webauthnFailureText({ kind: 'dismissed' }, t)).toBe(null)
  })

  it('returns a sentence for every non-silent kind', () => {
    for (const kind of ['cert-untrusted', 'insecure-context', 'instant-refusal', 'unsupported']) {
      expect(webauthnFailureText({ kind }, t)).toBeTruthy()
    }
  })
})
