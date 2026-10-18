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

// ISO-1521 (Decision 18/10/2026, replacing ISO-1386's "ask, never block"): sign-up now refuses
// anyone this returns true for. `null` (no date yet, or one that doesn't parse) is "not a minor"
// here — callers gate submission on a parsed, plausible date separately (see
// components/SignupFlow.jsx's `dateOK`), so this never has to tell "no date" apart from "adult".
export const isMinor = (birthDate, now) => {
  const age = ageFromBirthDate(birthDate, now)
  return age != null && age >= 0 && age < 18
}

// Below this the birth date is treated the same as a malformed field (a typo, a wrong-century
// slip), not a reason to show the under-18 refusal — ordinary input sanity, same category as "not
// a valid e-mail", checked before isMinor rather than folded into it. Shared by SignupFlow.jsx and
// PasswordAuth.jsx's PasswordRegisterForm, the two places a birth date is collected at sign-up.
export const MIN_PLAUSIBLE_AGE = 5
