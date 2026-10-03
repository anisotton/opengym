/* Stripe billing (Phase 3 — ISO-1393, contract fixed by ISO-1392's UX spec): Checkout, Customer
 * Portal and webhook processing for the three plans (monthly, quarterly, yearly) plus the
 * once-per-account R$1,99 first month.
 *
 * There is no `trialing`: ISO-1392's status-mapping table is explicit that the first month is a
 * sub-state of `active`, not a Stripe trial — so a first-ever Checkout sells only the recurring
 * intro Price (`STRIPE_PRICE_INTRO`, one billing cycle, R$1,99), with no `trial_period_days`
 * anywhere. The subscription that creates is `active` from its very first invoice. Once Stripe
 * reports it as created, the webhook converts it into a two-phase Subscription Schedule — phase 1
 * is the one cycle already on it, phase 2 is the chosen plan's own Price, open-ended — which is
 * what makes the second invoice bill the full plan price without the subscription's status ever
 * leaving `active` (this is the "Plano B" the issue described as the fallback, now the only
 * approach: ISO-1392 ruled out `trialing` before the Plano A sandbox check ever ran). A returning
 * subscriber (one with a `subscriptions` row already, from a prior cancellation) never sees the
 * intro Price at all — Checkout sells the chosen plan's Price directly, full price, no schedule.
 *
 * The official `stripe` SDK, used only as a thin client (`new Stripe(key)`) — the one new
 * dependency this issue allows in api/.
 */
import Stripe from 'stripe';
import {
  setStripeCustomerId, getUserIdByStripeCustomer, hasEverSubscribed,
  upsertSubscription, getSubscriptionById, getLatestSubscription, getSubscriptionsDueForFirstPeriodNotice
} from './store.js';

const STRIPE_API_VERSION = '2026-08-26.dahlia';

// Off until both are set — the same "optional piece gated by an env var" shape as ADMIN_UIDS/
// INVITE_ONLY/ALLOW_GUEST: an instance that never sets these is byte-for-byte the self-hosted app
// it was before Phase 3, and every existing test that calls PUT /api/data without ever hearing of
// Stripe keeps passing unmodified — none of them sets a STRIPE_* variable.
export const BILLING_ON = !!(process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET);

let stripeClient = null;
export function getStripe() {
  if (!stripeClient) {
    const opts = { apiVersion: STRIPE_API_VERSION };
    // Test-only seam (never set outside the test suite): points the SDK at a local mock instead
    // of api.stripe.com, so billing.test.js can assert on the exact request convertToSchedule
    // sends without a real network call or a mocking dependency.
    if (process.env.STRIPE_API_HOST) {
      opts.host = process.env.STRIPE_API_HOST;
      opts.protocol = 'http';
      if (process.env.STRIPE_API_PORT) opts.port = Number(process.env.STRIPE_API_PORT);
    }
    stripeClient = new Stripe(process.env.STRIPE_API_KEY, opts);
  }
  return stripeClient;
}

// Plan -> which env var names its recurring Price. The reverse lookup (planFromPrice) is read off
// the subscription's own first item at webhook time — a plan name is only ever taken from a
// request body at POST /api/billing/checkout, never trusted back out of a webhook payload.
const PLAN_PRICE_ENV = { monthly: 'STRIPE_PRICE_MONTHLY', quarterly: 'STRIPE_PRICE_QUARTERLY', yearly: 'STRIPE_PRICE_YEARLY' };

// The fixed business pricing (ISO-1392/ISO-1393, Anderson's 30/09 decision), in centavos — mirrors
// api/scripts/stripe-setup.mjs, which is what actually creates these Prices in Stripe. Needed here
// only to show the UPCOMING full charge while still in the first (R$1,99) period: the
// subscription's own current item during that period is the intro Price, not the chosen plan's, so
// its amount can't be read off the webhook payload the way it can once the schedule has moved on.
const PLAN_AMOUNT_CENTS = { monthly: 8900, quarterly: 23700, yearly: 76800 };

export function planPriceId(plan) {
  const envName = PLAN_PRICE_ENV[plan];
  return envName ? process.env[envName] || null : null;
}

export function planFromPrice(priceId) {
  if (!priceId) return null;
  for (const [plan, envName] of Object.entries(PLAN_PRICE_ENV)) {
    if (process.env[envName] === priceId) return plan;
  }
  return null;
}

// The one place that decides whether an account may write (Oráculo, ISO-1393 comment thread,
// 2026-10-01): a later change — e.g. a few free days before the first charge — is one edit here,
// not a hunt through every caller. `active` and `past_due` both write (ISO-1392's own mapping
// table: past_due is "Stripe still retrying", not yet a block); `canceled`/`unpaid` and no
// subscription at all do not. No `trialing` anywhere — see the module comment.
const WRITABLE_STATUSES = new Set(['active', 'past_due']);
export function canWrite(subscription) {
  return WRITABLE_STATUSES.has(subscription?.status);
}

export async function hasActiveAccess(pool, userId) {
  return canWrite(await getLatestSubscription(pool, userId));
}

// Resolves to the owning account's id from whatever a webhook event's object carries. Every
// Checkout Session, Subscription and Invoice object Stripe sends has `customer`, and
// users.stripe_customer_id (store.js, set once at that account's first checkout) is unique both
// ways — so this one lookup works for every event type below without depending on `metadata`
// surviving the particular kind of object a given event happens to wrap.
async function resolveUserId(pool, obj) {
  if (obj.metadata?.userId) return obj.metadata.userId;
  if (!obj.customer) return null;
  return getUserIdByStripeCustomer(pool, obj.customer);
}

const toIso = unixSeconds => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

// Set by server.js, same pattern as coachJobs.setProposalHook/jobs.setPool: billing.js has no
// business importing mail.js/mail-templates itself, so the "mail the first-period-ending warning"
// side effect is handed in from outside instead.
let firstPeriodNoticeHook = null;
export function setFirstPeriodNoticeHook(fn) { firstPeriodNoticeHook = fn; }

// Replaces the Stripe `trial_will_end` webhook this issue originally planned to hook the warning
// e-mail off: there is no Stripe trial anywhere in this design (ISO-1392), so Stripe never sends
// that event, and relying on it would have meant the e-mail silently never goes out. Checked on
// our own clock instead — server.js runs this on an interval, same shape as coach/cadence.js's own
// tick. One hook call per due subscription; `getSubscriptionsDueForFirstPeriodNotice` (store.js)
// already excludes anything already marked sent, so a slow hook or an overlapping tick can at
// worst mail the same account twice, never zero times.
export async function tickFirstPeriodNotices(pool) {
  if (!firstPeriodNoticeHook) return;
  for (const sub of await getSubscriptionsDueForFirstPeriodNotice(pool)) {
    try {
      await firstPeriodNoticeHook(sub.userId, sub);
      await upsertSubscription(pool, sub.id, sub.userId, { firstPeriodNoticeSent: true });
    } catch (e) {
      console.error('billing: first-period notice failed for', sub.id, e.message);
    }
  }
}

// Turns the plain subscription Checkout just created (a first-ever subscriber, selling only the
// intro Price) into a two-phase Subscription Schedule: one more cycle at the price already on it
// (R$1,99), then `targetPriceId` (the plan actually chosen), open-ended. A schedule's own phase
// change never touches the subscription's `status` — it stays `active` the whole time, which is
// the entire point (ISO-1392: there is no `trialing`). Stripe fires its own `customer.subscription.
// updated` for this conversion and for the later phase change, both landing back in
// applyStripeEvent as ordinary updates; `obj.schedule` being set by then is what stops this from
// running a second time (see the guard at the call site).
async function convertToSchedule(stripe, subscriptionId, targetPriceId) {
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId });
  const firstPhase = schedule.phases[0];
  // `iterations: 1` is rejected by the account's pinned API version (2026-08-26.dahlia) —
  // `parameter_unknown` on `phases[iterations]`, confirmed against the real sandbox. `end_date`
  // (the end of the cycle already in progress, which `create({ from_subscription })` already
  // computed for us) is the version-correct way to say "one more cycle at this price".
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    phases: [
      { items: firstPhase.items.map(i => ({ price: i.price })), end_date: firstPhase.end_date, start_date: firstPhase.start_date },
      { items: [{ price: targetPriceId }] }
    ]
  });
}

// Applied only after claimStripeEvent (server.js, store.js) has already won this event's
// single-use claim — never called twice for the same event.id, so nothing here needs its own
// idempotency beyond the upserts already being safe to repeat with the same data.
export async function applyStripeEvent(pool, event) {
  const obj = event.data.object;
  switch (event.type) {
    // Only linking account <-> customer here: the subscription's own created/updated event —
    // which always exists for a completed Checkout in subscription mode — is what records status.
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id || obj.metadata?.userId;
      if (userId && obj.customer) await setStripeCustomerId(pool, userId, obj.customer);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const userId = await resolveUserId(pool, obj);
      if (!userId) break;
      // First-ever subscription, still on the intro Price, not a schedule yet: convert it and stop
      // — the conversion's own update event re-enters this same case with the final shape, so
      // nothing below needs to run against the pre-conversion object.
      if (event.type === 'customer.subscription.created' && obj.metadata?.scheduleTo && !obj.schedule) {
        await convertToSchedule(getStripe(), obj.id, obj.metadata.scheduleTo);
        break;
      }
      const priceId = obj.items?.data?.[0]?.price?.id || null;
      const priceAmount = obj.items?.data?.[0]?.price?.unit_amount ?? null;
      const firstPeriod = priceId != null && priceId === process.env.STRIPE_PRICE_INTRO;
      await upsertSubscription(pool, obj.id, userId, {
        status: obj.status,
        plan: planFromPrice(priceId) || obj.metadata?.plan || null,
        priceId,
        priceAmount,
        customerId: obj.customer,
        firstPeriod,
        // Monotonic, unlike `firstPeriod` itself: the schedule's own phase-change update flips
        // `firstPeriod` back to false the moment the subscription moves off the intro Price, which
        // can land before or after the matching `invoice.paid` for that same transition. This stays
        // true forever once true once, so invoice.paid below can tell "this account once had a
        // first period" apart from "never had one" (a returning subscriber) regardless of which of
        // the two events happens to arrive first.
        ...(firstPeriod ? { hadFirstPeriod: true } : {}),
        // `current_period_end` moved off the subscription object itself under this account's API
        // version (Stripe's "flexible billing" shape) — it only exists per-item now. Fallback kept
        // for the pre-dahlia shape (older webhook replays, or an instance pinned to an earlier
        // version), confirmed against the real sandbox payload.
        currentPeriodEnd: toIso(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end),
        cancelAtPeriodEnd: !!obj.cancel_at_period_end
      });
      break;
    }

    // Terminal. "Access continues until current_period_end" is enforced by cancel_at_period_end
    // already being true from the update above in the meantime — this event only fires once that
    // date is reached, and access ends the moment this status is what the 402 gate reads next.
    case 'customer.subscription.deleted': {
      const userId = await resolveUserId(pool, obj);
      if (!userId) break;
      await upsertSubscription(pool, obj.id, userId, { status: 'canceled', cancelAtPeriodEnd: false });
      break;
    }

    // The invoice that turns the R$1,99 period into a full-price one. Checked off the invoice's
    // own line price, not off `billing_reason`: the schedule's phase-change update and this event
    // can land in either order, but the invoice itself always says which Price it was actually for.
    case 'invoice.paid': {
      // Same API-version move as current_period_end above: the invoice's subscription id moved
      // under `parent.subscription_details.subscription` — the root-level field is gone. Fallback
      // kept for the pre-dahlia shape.
      const subId = obj.subscription ?? obj.parent?.subscription_details?.subscription;
      if (!subId) break;
      const existing = await getSubscriptionById(pool, subId);
      const userId = existing?.userId || await resolveUserId(pool, obj);
      if (!userId) break;
      // Same API-version move again: an invoice line's price moved from `price.id` (an object) to
      // `pricing.price_details.price` (already a string id) — confirmed against a real, paid
      // full-price invoice in the sandbox, where the old path left this always null and
      // firstFullCharge was never recorded. Fallback kept for the pre-dahlia shape.
      const invoicePriceId = obj.lines?.data?.[0]?.price?.id
        ?? obj.lines?.data?.[0]?.pricing?.price_details?.price
        ?? null;
      const isFullPriceInvoice = invoicePriceId != null && invoicePriceId !== process.env.STRIPE_PRICE_INTRO;
      const data = { status: 'active', lastInvoiceStatus: 'paid' };
      // Recorded once — the first full-price invoice after a first (intro) period — never
      // overwritten by a later renewal.
      if (existing?.hadFirstPeriod && isFullPriceInvoice && !existing.firstFullCharge) {
        data.firstFullCharge = { at: toIso(obj.created), amount: obj.amount_paid, currency: obj.currency };
        data.firstPeriod = false;
      }
      await upsertSubscription(pool, subId, userId, data);
      break;
    }

    // Issue rule: "a Stripe tenta de novo antes de cancelar" — access stays whatever it already
    // was (`past_due` still writes — canWrite above). Stripe's own `customer.subscription.updated`
    // normally reports `past_due` on the subscription itself too; set here as well so the status
    // the 402 gate and the UI banner read moves the instant the failure is known, not only once
    // that separate event (if it arrives at all for this account's dunning settings) lands.
    case 'invoice.payment_failed': {
      const subId = obj.subscription ?? obj.parent?.subscription_details?.subscription;
      if (!subId) break;
      const existing = await getSubscriptionById(pool, subId);
      const userId = existing?.userId || await resolveUserId(pool, obj);
      if (!userId) break;
      await upsertSubscription(pool, subId, userId, { status: 'past_due', lastInvoiceStatus: 'failed' });
      break;
    }

    default:
      break; // every event type is still claimed and stored by claimStripeEvent either way
  }
}

// Once per account, lazily, at its first checkout — store.js's setStripeCustomerId is the only
// writer of this column, so every later checkout and the Portal reuse the same customer rather
// than asking Stripe for a new one each time.
export async function ensureStripeCustomer(pool, user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { userId: user.id }
  });
  await setStripeCustomerId(pool, user.id, customer.id);
  return customer.id;
}

// mode: 'subscription', always — never a `payment_method_types` array (issue rule: forms of
// payment live in the Dashboard, never in code). A first-ever subscriber's Checkout sells only the
// intro Price (R$1,99, one recurring cycle) — no trial, so the subscription is `active` from its
// first invoice, per ISO-1392. `scheduleTo` on the subscription's own metadata is what tells the
// webhook which plan to hand the Subscription Schedule once Stripe confirms the subscription
// exists (see convertToSchedule). A returning subscriber (hasEverSubscribed already true — the
// once-per-account rule) skips the intro Price and schedule entirely: Checkout sells the chosen
// plan's Price directly, full price from the start.
export async function createCheckoutSession(pool, user, plan, { successUrl, cancelUrl }) {
  const priceId = planPriceId(plan);
  if (!priceId) return { error: 'invalid plan' };
  const customerId = await ensureStripeCustomer(pool, user);
  const firstTime = !(await hasEverSubscribed(pool, user.id));
  const introPrice = process.env.STRIPE_PRICE_INTRO;
  const useIntro = firstTime && !!introPrice;
  const lineItems = [{ price: useIntro ? introPrice : priceId, quantity: 1 }];
  const subscriptionData = { metadata: { userId: user.id, plan, ...(useIntro ? { scheduleTo: priceId } : {}) } };
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: lineItems,
    subscription_data: subscriptionData,
    success_url: successUrl,
    cancel_url: cancelUrl
  });
  return { ok: true, url: session.url };
}

export async function createPortalSession(pool, user, { returnUrl }) {
  if (!user.stripeCustomerId) return { error: 'no stripe customer' };
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: returnUrl });
  return { ok: true, url: session.url };
}

// The upcoming invoice's amount, in centavos: during a first period that's the full plan price
// (PLAN_AMOUNT_CENTS, not read off the row — the subscription's current item is still the intro
// Price), otherwise it's simply the price already on the subscription. Shared by billingStatus and
// server.js's first-period-ending mail hook, so the two never state a different number for the
// same account.
export function nextChargeAmountCents(sub) {
  return sub?.firstPeriod ? (PLAN_AMOUNT_CENTS[sub.plan] ?? null) : (sub?.priceAmount ?? null);
}

// The exact app-facing contract from ISO-1392's spec (item 1 / "Ponto em aberto"): `status` is
// Stripe's own (never `trialing`), `firstPeriod` carries what `status` alone cannot say, and
// `nextChargeAmount` during a first period is the UPCOMING full-plan charge, not the R$1,99
// already on the subscription's current item.
export async function billingStatus(pool, userId) {
  const sub = await getLatestSubscription(pool, userId);
  if (!sub) return { enabled: true, status: 'none', active: false, firstPeriod: false };
  return {
    enabled: true,
    status: sub.status || 'none',
    active: canWrite(sub),
    plan: sub.plan || null,
    firstPeriod: !!sub.firstPeriod,
    nextChargeDate: sub.currentPeriodEnd || null,
    nextChargeAmount: nextChargeAmountCents(sub),
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    firstFullCharge: sub.firstFullCharge || null
  };
}
