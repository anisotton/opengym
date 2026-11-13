// @vitest-environment happy-dom
// Issue #238: Brilhart Fitness behind a reverse proxy that serves it under a subpath. The assets were
// already relative; the API call was not, so it went to the proxy's own root where nothing
// answers it. The base is read from where the app is being served.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, appBase, beacon } from './api.js'

const at = pathname => appBase({ pathname })

describe('the app knows where it is served from', () => {
  it('is the site root for an ordinary deployment', () => {
    expect(at('/')).toBe('/')
    expect(at('/index.html')).toBe('/')
  })

  it('keeps the proxy prefix of a subpath deployment', () => {
    expect(at('/myGym/')).toBe('/myGym/')
    expect(at('/myGym/index.html')).toBe('/myGym/')
    expect(at('/a/b/c/')).toBe('/a/b/c/')
  })

  it('drops a stale deep path rather than inventing a base from it', () => {
    // nginx sends these back to the app root before React boots; this is the belt and braces.
    expect(at('/myGym/plan/r/x')).toBe('/myGym/plan/r/')
    expect(at('/plan')).toBe('/')
  })

  it('survives a missing or odd location', () => {
    expect(appBase(null)).toBe('/')
    expect(at('')).toBe('/')
  })
})

describe('the "left" beacon of the web app', () => {
  afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/') })

  it('goes to the API of the copy it was served from, as JSON', async () => {
    history.replaceState(null, '', '/myGym/')
    const sendBeacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon })
    expect(beacon('/api/activity', { active: false })).toBe(true)
    const [url, blob] = sendBeacon.mock.calls[0]
    expect(url).toBe('/myGym/api/activity')
    expect(blob.type).toBe('application/json')
    expect(JSON.parse(await blob.text())).toEqual({ active: false })
  })

  it('a browser without sendBeacon just skips it', () => {
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined })
    expect(beacon('/api/activity', { active: false })).toBe(false)
  })
})

// A path that begins with two slashes is still served the real app on the real origin: nginx
// merges the slashes and resolves an encoded "..%2F" before it looks for a file, so
// https://gym.example//evil.example/..%2F/ is the shell, with its scripts. Taken as-is, that
// path is a protocol-relative URL, and every API call, the passkey sign-in included, went to
// evil.example (GHSA-375x-wfvj-jf7q, openGym v1.4.2).
const ORIGIN = 'https://gym.test'
const lands = base => new URL(base.replace(/\/$/, '') + '/api/login/verify', ORIGIN).origin

describe('the base never leaves the page\'s origin', () => {
  it.each([
    ['//evil.example/', '/evil.example/'],
    ['//evil.example//', '/evil.example/'],
    ['///evil.example/', '/evil.example/'],
    ['//evil.example/..%2F/', '/evil.example/..%2F/'],
    ['/gym//evil.example/', '/gym/evil.example/'],
    ['//', '/'],
    ['///', '/'],
    ['//index.html', '/'],
    ['/\\evil.example/', '/evil.example/'],
  ])('%s is the path %s on this origin', (pathname, base) => {
    expect(at(pathname)).toBe(base)
    expect(lands(at(pathname))).toBe(ORIGIN)
  })

  it.each([
    ['/', '/'],
    ['/gym/', '/gym/'],
    ['/gym/index.html', '/gym/'],
  ])('an ordinary %s is unchanged', (pathname, base) => {
    expect(at(pathname)).toBe(base)
    expect(lands(at(pathname))).toBe(ORIGIN)
  })

  it('a base the URL parser would still read as another host is refused, not used', () => {
    // A real location never has a raw tab in its path (the parser drops it on the way in), which
    // is exactly why the last word goes to the parser rather than to the slash rule alone.
    expect(() => at('/\t/evil.example/')).toThrow(/another site/)
  })
})

// The same pages through api() itself. Each is the real shell on the stock web image: "//",
// "///" and "//index.html" because nginx merges the slashes, "//evil.example/..%2F/" because it
// also resolves the encoded "..". Read as-is, the first three sent every call to https://api/...
// and the last one to evil.example.
describe('api() on a page whose path starts with two slashes', () => {
  const home = location.href
  afterEach(() => { vi.unstubAllGlobals(); window.happyDOM.setURL(home) })

  it.each([
    ['//', '/api/login/options'],
    ['///', '/api/login/options'],
    ['//index.html', '/api/login/options'],
    ['//evil.example/..%2F/', '/evil.example/..%2F/api/login/options'],
  ])('a page at %s still calls this origin, never the host its path names', async (path, expected) => {
    window.happyDOM.setURL(ORIGIN + path)
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await api('/api/login/options', { method: 'POST', body: '{}' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0]
    expect(new URL(url, location.href).origin).toBe(ORIGIN)
    expect(url).toBe(expected)
  })
})
