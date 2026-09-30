import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkForUpdate, fetchLatest, sha256, resetUpdateCheck, UPDATE_FEED } from './update.js'

// __APP_VERSION__ is defined at build time by vite.config.js (reads package.json).
// In the test environment vitest applies the same define, so it's available here.

describe('sha256', () => {
  it('computes the correct hash for a known input', async () => {
    const input = new TextEncoder().encode('hello world')
    const hash = await sha256(input.buffer)
    // Well-known SHA-256 of "hello world"
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('computes a different hash for different input', async () => {
    const a = await sha256(new TextEncoder().encode('aaa').buffer)
    const b = await sha256(new TextEncoder().encode('bbb').buffer)
    expect(a).not.toBe(b)
  })

  it('returns a 64-character hex string', async () => {
    const hash = await sha256(new TextEncoder().encode('test').buffer)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('checkForUpdate — disabled (no UPDATE_FEED configured for this fork)', () => {
  let originalFetch
  beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = vi.fn(); resetUpdateCheck() })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('is off by default', () => {
    expect(UPDATE_FEED).toBeFalsy()
  })

  it('resolves without ever calling fetch', async () => {
    const result = await checkForUpdate()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(result).toEqual({ hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null })
  })

  it('stays disabled across repeated calls and resetUpdateCheck()', async () => {
    await checkForUpdate()
    resetUpdateCheck()
    await checkForUpdate()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('fetchLatest — the fetch-and-compare mechanism, kept working for when a feed exists', () => {
  let originalFetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  const FEED = 'https://example.com/api/v4/projects/1/releases'

  function mockFetch(body, status = 200) {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }))
  }

  it('reports no update when the latest release matches the current version', async () => {
    mockFetch([{ tag_name: 'v' + __APP_VERSION__, assets: { links: [] } }])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBe(__APP_VERSION__)
    expect(result.apkUrl).toBe(null)
    expect(result.hashUrl).toBe(null)
  })

  it('reports no update when the latest release is older than current', async () => {
    // Older relative to the running version, not a hardcoded floor like "0.0.1": a fork's own
    // numbering can restart low (__APP_VERSION__ is "0.0.0-alpha" here), so an absolute literal
    // is not guaranteed to be lower than whatever is currently running.
    const [maj, min, patch] = __APP_VERSION__.split('+')[0].split('.').map(s => parseInt(s, 10) || 0)
    const older = 'v' + [maj, min, Math.max(0, patch - 1)].join('.')
    mockFetch([{ tag_name: older, assets: { links: [] } }])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBe(older.slice(1))
  })

  it('reports an update when the latest release is newer', async () => {
    mockFetch([{ tag_name: 'v99.0.0', assets: { links: [] } }])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(true)
    expect(result.latestVersion).toBe('99.0.0')
  })

  it('strips the v prefix from the tag name', async () => {
    mockFetch([{ tag_name: 'v99.1.2', assets: { links: [] } }])
    const result = await fetchLatest(FEED)
    expect(result.latestVersion).toBe('99.1.2')
  })

  it('handles tag names without a v prefix', async () => {
    mockFetch([{ tag_name: '99.0.0', assets: { links: [] } }])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(true)
    expect(result.latestVersion).toBe('99.0.0')
  })

  it('finds the APK download URL from release asset links', async () => {
    const apkUrl = 'https://example.com/project/-/releases/v2.0.0/downloads/app.apk'
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: { links: [{ url: apkUrl, direct_asset_url: apkUrl }] }
    }])
    const result = await fetchLatest(FEED)
    expect(result.apkUrl).toBe(apkUrl)
  })

  it('prefers direct_asset_url over url for APK links', async () => {
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: {
        links: [{
          url: 'https://redirect.example/app.apk',
          direct_asset_url: 'https://direct.example/app.apk'
        }]
      }
    }])
    const result = await fetchLatest(FEED)
    expect(result.apkUrl).toBe('https://direct.example/app.apk')
  })

  it('returns null apkUrl when no .apk link exists', async () => {
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: { links: [{ url: 'https://example.com/changelog.md', direct_asset_url: 'https://example.com/changelog.md' }] }
    }])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(true)
    expect(result.apkUrl).toBe(null)
  })

  it('finds the .sha256 hash URL from release asset links', async () => {
    const hashUrl = 'https://example.com/project/-/releases/v2.0.0/downloads/app.apk.sha256'
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: {
        links: [
          { url: 'https://example.com/app.apk', direct_asset_url: 'https://example.com/app.apk' },
          { url: hashUrl, direct_asset_url: hashUrl },
        ]
      }
    }])
    const result = await fetchLatest(FEED)
    expect(result.hashUrl).toBe(hashUrl)
  })

  it('finds hash URL by link name containing sha256', async () => {
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: {
        links: [
          { name: 'APK', url: 'https://example.com/app.apk', direct_asset_url: 'https://example.com/app.apk' },
          { name: 'SHA256 checksum', url: 'https://example.com/checksum.txt', direct_asset_url: 'https://example.com/checksum.txt' },
        ]
      }
    }])
    const result = await fetchLatest(FEED)
    expect(result.hashUrl).toBe('https://example.com/checksum.txt')
  })

  // A real GitLab-API-shaped release payload (assets.links, generic-package checksum listed
  // BEFORE the APK) — the detection must not confuse the two regardless of order.
  const REAL_RELEASE = [
    {
      "tag_name": "v1.3.1",
      "name": "app v1.3.1",
      "assets": {
        "count": 7,
        "sources": [
          { "format": "zip", "url": "https://example.com/archive/v1.3.1/app-v1.3.1.zip" },
        ],
        "links": [
          {
            "id": 12790840,
            "name": "Container images (api + web)",
            "url": "https://example.com/container_registry",
            "direct_asset_url": "https://example.com/container_registry",
            "link_type": "image"
          },
          {
            "id": 12790839,
            "name": "app-1.3.1.apk.sha256 (checksum)",
            "url": "https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk.sha256",
            "direct_asset_url": "https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk.sha256",
            "link_type": "other"
          },
          {
            "id": 12790838,
            "name": "app-1.3.1.apk (Android, sideload)",
            "url": "https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk",
            "direct_asset_url": "https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk",
            "link_type": "package"
          }
        ]
      }
    }
  ]

  it('finds the APK and its checksum in a real GitLab-shaped release payload', async () => {
    mockFetch(REAL_RELEASE)
    const result = await fetchLatest(FEED)
    expect(result.latestVersion).toBe('1.3.1')
    expect(result.apkUrl).toBe('https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk')
    expect(result.hashUrl).toBe('https://example.com/packages/generic/app-android/1.3.1/app-1.3.1.apk.sha256')
  })

  it('returns null hashUrl when no hash link exists', async () => {
    mockFetch([{
      tag_name: 'v99.0.0',
      assets: { links: [{ url: 'https://example.com/app.apk', direct_asset_url: 'https://example.com/app.apk' }] }
    }])
    const result = await fetchLatest(FEED)
    expect(result.hashUrl).toBe(null)
  })

  it('returns no update when the releases array is empty', async () => {
    mockFetch([])
    const result = await fetchLatest(FEED)
    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBe(__APP_VERSION__)
    expect(result.hashUrl).toBe(null)
  })

  it('throws when the feed responds with an error status', async () => {
    mockFetch(null, 500)
    await expect(fetchLatest(FEED)).rejects.toThrow('Release feed 500')
  })

  it('throws on network failure', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('Network error')))
    await expect(fetchLatest(FEED)).rejects.toThrow('Network error')
  })
})

describe('semver comparison (via fetchLatest behavior)', () => {
  let originalFetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  const FEED = 'https://example.com/api/v4/projects/1/releases'

  function mockRelease(tag) {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve([{ tag_name: tag, assets: { links: [] } }]),
    }))
  }

  // Versions are derived from the running __APP_VERSION__ so the suite never breaks
  // when package.json bumps. bump(2, +1) raises the patch; bump(0, +1) raises the major.
  // Read without its build metadata, the way compareSemver reads it: a build that sets
  // APP_BUILD (#244) runs this suite as "1.3.8+<build>", and then it checks the installed side.
  const [MAJ, MIN, PATCH] = __APP_VERSION__.split('+')[0].split('.').map(s => parseInt(s, 10) || 0)
  const bump = (idx, by) => {
    const parts = [MAJ, MIN, PATCH]
    parts[idx] += by
    return 'v' + parts.join('.')
  }

  it('detects a patch bump as an update', async () => {
    mockRelease(bump(2, 1))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(true)
  })

  it('detects a minor bump as an update', async () => {
    mockRelease(bump(1, 1))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(true)
  })

  it('detects a major bump as an update', async () => {
    mockRelease(bump(0, 1))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(true)
  })

  // A version may say which build it came from, as semver build metadata ("1.3.8+2026-09-18.2").
  // It takes no part in precedence, and splitting it on "." used to make the patch NaN — which
  // read as 0, so a tag carrying it compared as x.y.0 and a real update went unnoticed. Dropped
  // on both operands, so the same holds whichever side carries it; here it is the tag. The
  // installed side is __APP_VERSION__, a build-time define: run the suite with APP_BUILD set
  // and every case in this block reads it with metadata too.
  const BUILD = '+2026-09-18.2'
  const [MAJOR, MINOR, PATCH_N] = __APP_VERSION__.split('+')[0].split('.').map(s => parseInt(s, 10) || 0)
  const tagged = (maj, min, patch) => 'v' + [maj, min, patch].join('.') + BUILD

  it('judges a tag that carries build metadata on its numbers alone', async () => {
    mockRelease(tagged(MAJOR, MINOR, PATCH_N + 1))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(true)

    // Same numeric version as running (build metadata aside), built from the exact running
    // version string rather than reconstructed from parsed ints — so a pre-release suffix like
    // "-alpha" round-trips exactly in the echoed latestVersion instead of being dropped.
    const sameTag = 'v' + __APP_VERSION__.split('+')[0] + BUILD
    mockRelease(sameTag)
    const same = await fetchLatest(FEED)
    expect(same.hasUpdate).toBe(false)                                   // the running release
    expect(same.latestVersion).toBe(__APP_VERSION__.split('+')[0] + BUILD)   // echoed as it came

    mockRelease(tagged(MAJOR, Math.max(0, MINOR - 1), 0))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(false)

    mockRelease(tagged(MAJOR + 1, 0, 0))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(true)
  })

  it('does not flag an older patch as an update', async () => {
    // One patch below current (current patch is always >= our test floor)
    mockRelease('v' + [MAJ, MIN, Math.max(0, PATCH - 1)].join('.'))
    // Only meaningful when we could actually go lower; when patch is 0 this equals current,
    // which correctly reports no update either way.
    expect((await fetchLatest(FEED)).hasUpdate).toBe(false)
  })

  it('does not flag an older minor as an update', async () => {
    // A version guaranteed lower than any 1.x+ release: same major, minor 0, patch 0,
    // minus one on the minor when possible.
    mockRelease('v' + [MAJ, Math.max(0, MIN - 1), 0].join('.'))
    expect((await fetchLatest(FEED)).hasUpdate).toBe(false)
  })
})
