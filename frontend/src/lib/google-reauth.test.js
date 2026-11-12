// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import { savePendingReauth, takePendingReauth, parseGoogleCallback } from './google-reauth.js'

describe('pending Google reauth', () => {
  beforeEach(() => sessionStorage.clear())

  it('round-trips an action across a reload, and only once', () => {
    savePendingReauth({ kind: 'set-password', next: 'correct horse battery' })
    expect(takePendingReauth()).toEqual({ kind: 'set-password', next: 'correct horse battery' })
    expect(takePendingReauth()).toBeNull()   // taken: a second read (e.g. a stray re-render) sees nothing
  })

  it('nothing pending reads as null, not a throw', () => {
    expect(takePendingReauth()).toBeNull()
  })

  it('garbage left behind by an older build reads as null instead of throwing', () => {
    sessionStorage.setItem('gauth_reauth_pending', 'not json')
    expect(takePendingReauth()).toBeNull()
  })
})

describe('parseGoogleCallback', () => {
  it('reads the result code and the reauth proof, when there is one', () => {
    expect(parseGoogleCallback('?google=ok')).toEqual({ google: 'ok', proof: null })
    expect(parseGoogleCallback('?google=reauth-ok&proof=abc123')).toEqual({ google: 'reauth-ok', proof: 'abc123' })
  })

  it('no google param at all is not a callback', () => {
    expect(parseGoogleCallback('')).toBeNull()
    expect(parseGoogleCallback('?billing=sucesso')).toBeNull()
  })
})
