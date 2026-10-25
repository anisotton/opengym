// Whether this device may write training data, from the billing status the client last learned
// (GET /api/billing/status — billingStatus in api/billing.js, cached offline in useStore's
// `billing`). Mirrors the server's own canWrite (api/billing.js) exactly: 'active' and 'past_due'
// write, nothing else does — there is no Stripe `trialing` anywhere in this design (ISO-1392), so
// the once-per-account R$1,99 first month is just `active` with `firstPeriod: true`, not a status
// of its own. Billing off (self-hosted instance with no STRIPE_* configured) or never fetched yet
// (no server reached since install) both read as writable: the 402 on PUT /api/data (ISO-1393) is
// the real gate, never this — a false "writable" here costs one refused sync, kept on the device
// until the next one; a false "read-only" would block a self-hosted instance that never has a
// subscription at all.
export function canWriteFromBilling(billing) {
  if (!billing || billing.enabled === false) return true
  return billing.status === 'active' || billing.status === 'past_due'
}

// Centavos (api/billing.js's own unit, never floating reais) to the fixed "R$ 89,00" shape every
// plan is priced in (ISO-1392/ISO-1393: BRL only, no currency localization). A plain division, not
// Intl.NumberFormat('pt-BR'): the UI language and the currency are independent here — a German
// reader still owes reais, in the same digits a Brazilian one would see.
export function fmtCentsBRL(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null
  return 'R$ ' + (cents / 100).toFixed(2).replace('.', ',')
}

// The admin's own "R$ 99,00" input (new price version, ISO-1627) back to centavos — the inverse
// of fmtCentsBRL, not a generic currency parser: it only accepts the exact shape the field's own
// mask produces (optional "R$ ", digits with "." as the thousands separator, "," then exactly two
// decimals), so a stray paste that doesn't look like that is rejected rather than guessed at.
// Range mirrors `billing_prices.unit_amount`'s own CHECK (api/migrations/010_billing_catalog.sql):
// 100..1000000 centavos, i.e. R$1,00..R$10.000,00 — the same floor/ceiling the server re-checks,
// so a value this rejects would 400 there too; this just gives the admin the error before the trip.
export function parseCentsBRL(str) {
  if (typeof str !== 'string') return null
  const m = str.trim().match(/^(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/)
  if (!m) return null
  const cents = parseInt(m[1].replace(/\./g, ''), 10) * 100 + parseInt(m[2], 10)
  if (!Number.isFinite(cents) || cents < 100 || cents > 1000000) return null
  return cents
}

// `interval`/`interval_count` (billing_plans) to whole months, so a yearly plan (interval:'year',
// interval_count:1) and a quarterly one (interval:'month', interval_count:3) compare on the same
// footing — the only two shapes the schema's own CHECK allows ('month'|'year').
function monthsOf(interval, intervalCount) {
  return interval === 'year' ? intervalCount * 12 : intervalCount
}

// A plan's price, divided down to what one month of it costs — the "Equivalent to R$ X/month"
// line (SettingsPlan, ISO-1627 §4.1). Rounded, like fmtCentsBRL's own cents are always whole.
export function monthlyEquivalentCents(unitAmountCents, interval, intervalCount) {
  const months = monthsOf(interval, intervalCount)
  if (typeof unitAmountCents !== 'number' || !Number.isFinite(unitAmountCents) || !months) return null
  return Math.round(unitAmountCents / months)
}

// How much cheaper a plan's monthly-equivalent price is than the monthly plan's own price, as a
// whole-number percentage ("11% less than the monthly plan") — never negative-looking math shown
// to a customer: a plan priced at or above the monthly one (shouldn't happen, but the catalog
// doesn't enforce it) reports 0, not a negative "-3%".
export function savingsPercentVsMonthly(monthlyEquivCents, monthlyPlanCents) {
  if (typeof monthlyEquivCents !== 'number' || typeof monthlyPlanCents !== 'number' ||
    !Number.isFinite(monthlyEquivCents) || !Number.isFinite(monthlyPlanCents) || monthlyPlanCents <= 0) return null
  return Math.max(0, Math.round((1 - monthlyEquivCents / monthlyPlanCents) * 100))
}
