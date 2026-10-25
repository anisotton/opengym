// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://gym.test/" }
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
// What the server answers each POST /api/push/subscribe, in order; an Error is thrown the way
// api() throws one (message and status). Empty: { ok: true }.
const subscribeAnswers = []
const refusal = (status, message) => Object.assign(new Error(message), { status })
vi.mock('./api.js', () => ({
  api: vi.fn(async (path, opts) => {
    calls.push([path, opts?.method || 'GET', opts?.body ? JSON.parse(opts.body) : null])
    if (path === '/api/push/public-key') return { key: KEY }
    if (path.startsWith('/api/push/status')) return { subscribed: serverHas }
    if (path === '/api/push/subscribe' && subscribeAnswers.length) {
      const a = subscribeAnswers.shift()
      if (a instanceof Error) throw a
      return a
    }
    return { ok: true }
  })
}))

const KEY = 'BPqx2m6xQ6pQK5hQtMz6d3kM2s7gq4yHqQvWzZ1sK1c'   // any base64url string
const keyBytes = b64 => {
  const padded = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0)).buffer
}
let serverHas = true
let sub = null
// A subscription the push service hands out; the one a test starts with is e1, and every one
// made after it (pushManager.subscribe) is a new endpoint with new keys, as a real one is.
let made = 1
const makeSub = (key, n = 1) => {
  const s = {
    endpoint: 'https://push.example/e' + n, options: { applicationServerKey: keyBytes(key) },
    toJSON: () => ({ endpoint: 'https://push.example/e' + n, keys: n === 1 ? { p256dh: 'p', auth: 'a' } : { p256dh: 'p' + n, auth: 'a' + n } }),
    unsubscribe: vi.fn(async () => { if (sub === s) sub = null; return true })
  }
  return s
}
const reg = {
  pushManager: {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async ({ applicationServerKey }) => { sub = makeSub(KEY, ++made); sub.options.applicationServerKey = applicationServerKey; return sub })
  }
}
const posts = () => calls.filter(c => c[0] === '/api/push/subscribe').map(c => c[2].subscription.endpoint)

beforeEach(() => {
  calls.length = 0
  subscribeAnswers.length = 0
  made = 1
  reg.pushManager.subscribe.mockClear()
  serverHas = true
  sub = null
  localStorage.clear()
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg) }, configurable: true })
  globalThis.PushManager = function () {}
  globalThis.Notification = { permission: 'granted', requestPermission: vi.fn(async () => 'granted') }
})

describe('deviceId', () => {
  it('makes one token per browser and keeps it', async () => {
    const { deviceId } = await import('./push.js')
    const a = deviceId()
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(deviceId()).toBe(a)
    expect(localStorage.getItem('gym_device')).toBe(a)
  })
})

describe('syncPushSubscription', () => {
  it('does nothing without permission or without a subscription', async () => {
    const { syncPushSubscription } = await import('./push.js')
    Notification.permission = 'default'
    expect(await syncPushSubscription()).toBe(false)
    Notification.permission = 'granted'
    expect(await syncPushSubscription()).toBe(false)
    expect(calls).toEqual([])
  })

  it('asks the server and does not write when it already holds the endpoint', async () => {
    const { syncPushSubscription } = await import('./push.js')
    sub = makeSub(KEY)
    expect(await syncPushSubscription()).toBe(true)
    expect(calls.map(c => c[1] + ' ' + c[0].split('?')[0])).toEqual(['GET /api/push/public-key', 'GET /api/push/status'])
  })

  it('re-registers a subscription the server lost, with the device id', async () => {
    const { syncPushSubscription, deviceId } = await import('./push.js')
    sub = makeSub(KEY)
    serverHas = false
    expect(await syncPushSubscription()).toBe(true)
    const post = calls.find(c => c[0] === '/api/push/subscribe')
    expect(post[2]).toEqual({ subscription: { endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } }, deviceId: deviceId() })
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('replaces a subscription made against a key the server no longer has', async () => {
    const { syncPushSubscription } = await import('./push.js')
    const old = makeSub('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    sub = old
    expect(await syncPushSubscription()).toBe(true)
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(reg.pushManager.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(new Uint8Array(keyBytes(KEY)))
    expect(calls.some(c => c[0] === '/api/push/subscribe')).toBe(true)
    expect(calls.some(c => c[0].startsWith('/api/push/status'))).toBe(false)
  })
})

// Since the server refuses to move an endpoint filed under another account unless the caller
// sends that row's own keys (409, GHSA-568g-hg5j-h53q), a browser that holds the endpoint with
// other keys could never register again, and the switch read "on" from the browser's side all
// the while. The way out is a fresh subscription: a new endpoint and new keys, which nobody else
// can hold.
describe('a subscription the server has under another account', () => {
  const conflict = () => refusal(409, 'this subscription belongs to another account')

  it('is replaced by a fresh one, which is sent once more', async () => {
    const { syncPushSubscription } = await import('./push.js')
    const old = makeSub(KEY)
    sub = old
    serverHas = false
    subscribeAnswers.push(conflict())
    expect(await syncPushSubscription()).toBe(true)
    expect(old.unsubscribe).toHaveBeenCalledTimes(1)
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(reg.pushManager.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(new Uint8Array(keyBytes(KEY)))
    expect(posts()).toEqual(['https://push.example/e1', 'https://push.example/e2'])
    expect(calls.at(-1)[2].subscription.keys).toEqual({ p256dh: 'p2', auth: 'a2' })
    expect(sub.endpoint).toBe('https://push.example/e2')     // the browser keeps the fresh one
  })

  it('turning the switch on goes the same way', async () => {
    const { enablePush } = await import('./push.js')
    sub = makeSub(KEY)                                        // subscribe() hands back the one it has
    reg.pushManager.subscribe.mockImplementationOnce(async () => sub)
    subscribeAnswers.push(conflict())
    await expect(enablePush()).resolves.toBeUndefined()
    expect(posts()).toEqual(['https://push.example/e1', 'https://push.example/e2'])
    expect(sub.endpoint).toBe('https://push.example/e2')
  })

  it('a fresh one refused as well is dropped, and the caller gets the server\'s words and `refused`', async () => {
    const { syncPushSubscription } = await import('./push.js')
    sub = makeSub(KEY)
    serverHas = false
    subscribeAnswers.push(conflict(), refusal(400, 'push endpoint not allowed'))
    const e = await syncPushSubscription().catch(x => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ message: 'push endpoint not allowed', status: 400, refused: true })
    expect(posts()).toHaveLength(2)                           // one retry, never a loop
    expect(sub).toBeNull()                                    // no subscription the server does not hold
  })

  it('a retry that never reaches the server is not the server refusing, and leaves nothing behind', async () => {
    const { enablePush } = await import('./push.js')
    subscribeAnswers.push(conflict(), new TypeError('Failed to fetch'))
    const e = await enablePush().catch(x => x)
    expect(e).toBeInstanceOf(TypeError)
    expect(e.message).toBe('Failed to fetch')
    expect(e.refused).toBeUndefined()
    expect(sub).toBeNull()
  })

  it('any other failure is not retried and is thrown as it was', async () => {
    const { syncPushSubscription } = await import('./push.js')
    const old = makeSub(KEY)
    sub = old
    serverHas = false
    subscribeAnswers.push(refusal(500, 'HTTP 500'))
    const e = await syncPushSubscription().catch(x => x)
    expect(e).toMatchObject({ message: 'HTTP 500', status: 500 })
    expect(e.refused).toBeUndefined()
    expect(old.unsubscribe).not.toHaveBeenCalled()
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
    expect(posts()).toHaveLength(1)
  })
})

describe('pushSupported', () => {
  it('needs the service worker, PushManager, Notification and an https origin', async () => {
    const { pushSupported } = await import('./push.js')
    expect(pushSupported()).toBe(true)
    expect(location.protocol).toBe('https:')
  })
})
