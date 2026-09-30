// Update check — compares the installed version (__APP_VERSION__) against the latest release
// tag on a GitLab-shaped releases feed, and optionally downloads + installs the APK.
//
// UPDATE_FEED is null: this fork does not publish a release feed of its own yet, so
// checkForUpdate() resolves without ever reaching the network. The fetch-and-compare mechanism
// (fetchLatest, below) is kept intact and independently testable for whenever UPDATE_FEED points
// at a real GitLab-API-shaped feed again.
// On Android (Capacitor), the APK asset is downloaded to the cache directory
// and handed to the system installer via a content:// URI.

import { MOBILE } from './mobile.js'

export const UPDATE_FEED = null

/**
 * Compares two semver strings (e.g. "1.2.11" vs "1.3.0").
 * Returns  1 if a > b, -1 if a < b, 0 if equal.
 *
 * Build metadata is dropped first. A version that says which build it came from carries it as
 * semver build metadata ("1.3.8+2026-09-18.2"), and splitting that on "." makes the patch NaN —
 * which read as 0, so a release tagged that way compared as 1.3.0 and a real update went
 * unnoticed. Semver says the metadata plays no part in precedence, so "1.3.7+anything" and
 * "1.3.7" are the same version here. Dropped on both operands, so it holds whichever side
 * carries it.
 */
function compareSemver(a, b) {
  // parseInt, not Number: a running version can carry a pre-release suffix on top of build
  // metadata ("0.0.0-alpha"), and Number("0-alpha") is NaN where parseInt reads the leading
  // digits and stops. NaN propagated silently as "equal" (falsy || 0), so a release compared
  // as x.y.0 against a suffixed patch and some real updates went unnoticed.
  const pa = a.replace(/^v/, '').split('+')[0].split('.').map(s => parseInt(s, 10) || 0)
  const pb = b.replace(/^v/, '').split('+')[0].split('.').map(s => parseInt(s, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff > 0) return 1
    if (diff < 0) return -1
  }
  return 0
}

const NO_UPDATE = { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }

/**
 * Checks UPDATE_FEED for a newer version. Resolves to NO_UPDATE without any network call when
 * UPDATE_FEED is unset (the default for this fork).
 * Returns { hasUpdate, latestVersion, apkUrl, hashUrl } or throws on network failure.
 *   - hasUpdate: true if the latest release tag is newer than the running build
 *   - latestVersion: the semver string of the latest release (without "v" prefix)
 *   - apkUrl: direct download URL of the first .apk asset, or null
 *   - hashUrl: direct download URL of the .apk.sha256 hash file, or null
 */
// One request per app session: Settings is opened often, a configured feed does not need to
// hear about it every time. The promise is cached, a failure is not.
let cached = null
export function resetUpdateCheck() { cached = null }
export async function checkForUpdate() {
  if (!UPDATE_FEED) return NO_UPDATE
  if (!cached) cached = fetchLatest(UPDATE_FEED).catch(e => { cached = null; throw e })
  return cached
}

/**
 * The fetch-and-compare mechanism, kept independently testable (and reusable once a real feed
 * is configured) regardless of whether checkForUpdate() is currently wired to call it.
 * `feedUrl` is a GitLab releases-API-shaped endpoint (…/releases).
 */
export async function fetchLatest(feedUrl) {
  const res = await fetch(feedUrl + '?per_page=1')
  if (!res.ok) throw new Error(`Release feed ${res.status}`)
  const releases = await res.json()
  if (!releases.length) return NO_UPDATE

  const latest = releases[0]
  const latestVersion = latest.tag_name.replace(/^v/, '')
  const hasUpdate = compareSemver(latestVersion, __APP_VERSION__) > 0

  // Find the APK asset among the release links (generic package links) or assets.sources
  let apkUrl = null
  let hashUrl = null
  if (latest.assets?.links?.length) {
    const apkLink = latest.assets.links.find(l => /\.apk$/i.test(l.url) || /\.apk$/i.test(l.direct_asset_url))
    if (apkLink) apkUrl = apkLink.direct_asset_url || apkLink.url
    // Look for a matching .sha256 hash file
    const hashLink = latest.assets.links.find(l => /\.apk\.sha256$/i.test(l.url) || /\.apk\.sha256$/i.test(l.direct_asset_url) || /sha256/i.test(l.name))
    if (hashLink) hashUrl = hashLink.direct_asset_url || hashLink.url
  }

  return { hasUpdate, latestVersion, apkUrl, hashUrl }
}

/**
 * Computes the SHA-256 hash of an ArrayBuffer using the Web Crypto API.
 * Returns the hex-encoded digest string.
 */
export async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Downloads the APK from `url`, verifies its SHA-256 hash against `expectedHash`
 * (if provided), and triggers the Android installer.
 * Only works on the MOBILE (Capacitor) build with Android.
 *
 * @param {string} url - Direct download URL for the APK
 * @param {string|null} expectedHash - Expected SHA-256 hex string (from .sha256 asset), or null to skip verification
 * @param {function|null} onProgress - Called with (received, total) bytes during download, or null
 */
export async function downloadAndInstall(url, expectedHash = null, onProgress = null) {
  // The in-app installer only ever runs from the MOBILE Android update row (Settings.jsx),
  // which is itself gated on UPDATE_FEED — nothing calls this on the web build.
  if (!MOBILE) return

  const { Filesystem, Directory } = await import('@capacitor/filesystem')

  // Download with progress tracking via ReadableStream
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)

  const total = parseInt(res.headers.get('content-length') || '0', 10)
  const reader = res.body.getReader()
  const chunks = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (onProgress) onProgress(received, total)
  }

  // Reassemble into a single blob
  const blob = new Blob(chunks)

  // Size check: an APK should be at least 100 KB
  if (blob.size < 100_000) {
    throw new Error('Downloaded file is too small to be a valid APK (' + blob.size + ' bytes)')
  }

  // SHA-256 integrity check
  if (expectedHash) {
    const buffer = await blob.arrayBuffer()
    const actualHash = await sha256(buffer)
    if (actualHash !== expectedHash.toLowerCase().trim()) {
      throw new Error('SHA-256 mismatch — download may be corrupted or tampered with')
    }
  }

  // Convert blob to base64
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  const fileName = 'opengym-update.apk'
  await Filesystem.writeFile({
    path: fileName,
    directory: Directory.Cache,
    data: base64,
  })

  // Use the local InstallPlugin to trigger the Android package installer
  const { registerPlugin } = await import('@capacitor/core')
  const Install = registerPlugin('Install')
  await Install.installApk({ fileName })
}
