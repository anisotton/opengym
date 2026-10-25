// Pure rules for the admin Program catalog (ISO-1485) — mirrors api/programs.js's validation so
// the form can give immediate feedback; the server re-validates everything regardless (this is
// convenience, not the security boundary). The admin dashboard is deliberately English-only (see
// views/Admin.jsx's own note), so this carries plain strings — no t()/locale entries.

export const CATEGORIES = [
  { value: 'strength', label: 'Strength' },
  { value: 'hypertrophy', label: 'Hypertrophy' },
  { value: 'conditioning', label: 'Conditioning' },
  { value: 'mobility', label: 'Mobility' },
  { value: 'general', label: 'General fitness' }
]
export const DIFFICULTIES = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' }
]

export const TITLE_MIN = 3, TITLE_MAX = 120
export const DESCRIPTION_MAX = 5000
export const SESSION_MINUTES_MIN = 1, SESSION_MINUTES_MAX = 600
export const COVER_ALT_MIN = 3, COVER_ALT_MAX = 200
export const COVER_WIDTH_MIN = 640, COVER_HEIGHT_MIN = 360

// Trim + collapse internal whitespace, same rule the server applies before its own uniqueness
// check — used here only so the "type the title to confirm" purge gate matches exactly.
export function normalizeTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim()
}

// "1 h 30 min" / "45 min" / "1 h" — the list and form's duration display.
export function formatMinutes(n) {
  if (!Number.isFinite(n) || n <= 0) return '–'
  const h = Math.floor(n / 60), m = n % 60
  if (!h) return `${m} min`
  if (!m) return `${h} h`
  return `${h} h ${m} min`
}

// The purge confirmation's own gate — the server checks the same thing again (programs.js's
// titleMatchesForPurge), never trusting this alone.
export function canPurge(typed, title) {
  const t = normalizeTitle(title)
  return t.length > 0 && normalizeTitle(typed) === t
}

// Required whenever a cover is present; must describe the image, not restate the title or name
// the file — same rule (and same regex) as api/programs.js's validateCoverAlt.
const FILENAME_LIKE = /\.(jpe?g|png|webp|gif|heic|avif)$|^(img|cover|image|photo|dsc)[_-]?\d*$/i
export function coverAltError(alt, title) {
  const v = String(alt ?? '').trim()
  if (v.length < COVER_ALT_MIN || v.length > COVER_ALT_MAX) return `Must be ${COVER_ALT_MIN}-${COVER_ALT_MAX} characters`
  if (title && v.toLowerCase() === normalizeTitle(title).toLowerCase()) return 'Describe the image, not the title'
  if (FILENAME_LIKE.test(v)) return 'Describe the image, not the file name'
  return null
}

// One field's immediate feedback, for blur/submit — mirrors api/programs.js's validateProgram
// field-by-field. Returns a message, or null when the value is fine.
export function fieldError(field, value) {
  switch (field) {
    case 'title': {
      const t = normalizeTitle(value)
      return t.length < TITLE_MIN || t.length > TITLE_MAX ? `Must be ${TITLE_MIN}-${TITLE_MAX} characters` : null
    }
    case 'description':
      return String(value ?? '').length > DESCRIPTION_MAX ? `Must be at most ${DESCRIPTION_MAX} characters` : null
    case 'sessionMinutes':
      return Number.isInteger(value) && value >= SESSION_MINUTES_MIN && value <= SESSION_MINUTES_MAX
        ? null : `Must be a whole number, ${SESSION_MINUTES_MIN}-${SESSION_MINUTES_MAX}`
    default:
      return null
  }
}

// The centre 16:9 crop of a `sw`x`sh` source, capped at `maxW` wide — pure geometry, so it's
// testable without a canvas. The component does the actual pixel drawing (ctx.drawImage with
// this rectangle); this only decides where. Null for a source smaller than the minimum in either
// dimension — the form refuses those before ever getting here.
export function cropRectFor16x9(sw, sh, maxW = 1600) {
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw < COVER_WIDTH_MIN || sh < COVER_HEIGHT_MIN) return null
  const ratio = 16 / 9
  let cw = sw, ch = Math.round(sw / ratio)
  if (ch > sh) { ch = sh; cw = Math.round(sh * ratio) }
  const sx = Math.round((sw - cw) / 2), sy = Math.round((sh - ch) / 2)
  const outW = Math.min(maxW, cw)
  const outH = Math.round(outW * 9 / 16)
  return { sx, sy, sw: cw, sh: ch, outW, outH }
}
