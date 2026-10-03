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
