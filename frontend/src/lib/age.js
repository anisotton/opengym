// Age from a birth date, the same plain `YYYY-MM-DD` shape the server accepts and stores
// (api/server.js parseBirthDate) — no timezone: both ends compare calendar dates, not instants.

export function ageFromBirthDate(birthDate, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate || '').trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const birth = new Date(Date.UTC(y, mo - 1, d))
  // Rejects an out-of-range day (2024-02-30) the same way the server's own parseBirthDate does:
  // a Date that doesn't echo the input back exactly rolled over instead of refusing it.
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return null
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  let age = now.getUTCFullYear() - y
  const hadBirthdayThisYear = today >= Date.UTC(now.getUTCFullYear(), mo - 1, d)
  if (!hadBirthdayThisYear) age--
  return age
}

// Decision 2 of ISO-1386: asked, never required. The notice this feeds (ISO-1398) never
// blocks sign-up either way — `null` (no date yet, or one that doesn't parse) is simply "no
// notice", the same as an adult.
export const isMinor = (birthDate, now) => {
  const age = ageFromBirthDate(birthDate, now)
  return age != null && age >= 0 && age < 18
}
