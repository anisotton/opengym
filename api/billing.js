/* Stripe billing (Phase 3 — ISO-1393): Checkout, Customer Portal and webhook processing for the
 * three plans (monthly, quarterly, yearly) plus the once-per-account R$1,99 first month, sold as
 * a 30-day-trial subscription with a one-time Price added to the same Checkout Session (the
 * issue's preferred approach over a Subscription Schedule — one hosted Checkout, and the
 * subscription's own `trial_will_end` event is the natural hook for the warning e-mail). The
 * official `stripe` SDK, used only as a thin client (`new Stripe(key)`) — the one new dependency
 * this issue allows in api/.
 */
import Stripe from 'stripe';
import {
  setStripeCustomerId, getUserIdByStripeCustomer, hasEverSubscribed,
  upsertSubscription, getSubscriptionById, getLatestSubscription
} from './store.js';

const STRIPE_API_VERSION = '2026-08-26.dahlia';

// Off until both are set — the same "optional piece gated by an env var" shape as ADMIN_UIDS/
// INVITE_ONLY/ALLOW_GUEST: an instance that never sets these is byte-for-byte the self-hosted app
// it was before Phase 3, and every existing test that calls PUT /api/data without ever hearing of
// Stripe keeps passing unmodified — none of them sets a STRIPE_* variable.
export const BILLING_ON = !!(process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET);

let stripeClient = null;
export function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_API_KEY, { apiVersion: STRIPE_API_VERSION });
  return stripeClient;
}

// Plan -> which env var names its recurring Price. The reverse lookup (planFromPrice) is read off
// the subscription's own first item at webhook time — a plan name is only ever taken from a
// request body at POST /api/billing/checkout, never trusted back out of a webhook payload.
const PLAN_PRICE_ENV = { monthly: 'STRIPE_PRICE_MONTHLY', quarterly: 'STRIPE_PRICE_QUARTERLY', yearly: 'STRIPE_PRICE_YEARLY' };

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

// `trialing` counts as a paid-up account (issue rule: "trialing conta como assinatura ativa: libera
// tudo") — the R$1,99 charge already happened at Checkout, so the trial is never a free period,
// only a deferral of the first full-price invoice to the plan's own cadence.
const ACTIVE_STATUSES = new Set(['trialing', 'active']);
export function isActiveStatus(status) { return ACTIVE_STATUSES.has(status); }

export async function hasActiveAccess(pool, userId) {
  const sub = await getLatestSubscription(pool, userId);
  return isActiveStatus(sub?.status);
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
// business importing mail.js/mail-templates itself, so the "mail the trial-ending warning" side
// effect is handed in from outside instead.
let trialWillEndHook = null;
export function setTrialWillEndHook(fn) { trialWillEndHook = fn; }

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
      const priceId = obj.items?.data?.[0]?.price?.id || null;
      await upsertSubscription(pool, obj.id, userId, {
        status: obj.status,
        plan: planFromPrice(priceId),
        priceId,
        customerId: obj.customer,
        currentPeriodEnd: toIso(obj.current_period_end),
        cancelAtPeriodEnd: !!obj.cancel_at_period_end,
        trialEnd: toIso(obj.trial_end)
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

    // The natural hook for the Phase-2 e-mail (issue: don't depend on Stripe's own trial e-mails —
    // they don't go out in the sandbox), fired 3 days before the R$1,99 month turns into the first
    // full-price invoice.
    case 'customer.subscription.trial_will_end': {
      const userId = await resolveUserId(pool, obj);
      if (userId && trialWillEndHook) {
        try { await trialWillEndHook(userId, obj); }
        catch (e) { console.error('billing: trial_will_end hook failed', e.message); }
      }
      break;
    }

    // The invoice that turns a trialing account into a paying one. `billing_reason` tells a
    // renewal apart from the R$1,99 Checkout charge (a one-time Price, never this subscription's
    // own invoice) and from every cycle after the first.
    case 'invoice.paid': {
      const subId = obj.subscription;
      if (!subId) break;
      const existing = await getSubscriptionById(pool, subId);
      const userId = existing?.userId || await resolveUserId(pool, obj);
      if (!userId) break;
      const data = { status: 'active', lastInvoiceStatus: 'paid' };
      // Recorded once — the first time status flips from trialing on a subscription-cycle invoice
      // — never overwritten by a later renewal.
      if (existing?.status === 'trialing' && obj.billing_reason === 'subscription_cycle' && !existing.firstFullCharge) {
        data.firstFullCharge = { at: toIso(obj.created), amount: obj.amount_paid, currency: obj.currency };
      }
      await upsertSubscription(pool, subId, userId, data);
      break;
    }

    // Issue rule: "a Stripe tenta de novo antes de cancelar" — access stays whatever it already
    // was; only `lastInvoiceStatus` moves, for the app's own banner and reminder e-mail, never the
    // status the 402 gate reads.
    case 'invoice.payment_failed': {
      const subId = obj.subscription;
      if (!subId) break;
      const existing = await getSubscriptionById(pool, subId);
      const userId = existing?.userId || await resolveUserId(pool, obj);
      if (!userId) break;
      await upsertSubscription(pool, subId, userId, { lastInvoiceStatus: 'failed' });
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
// payment live in the Dashboard, never in code). The trial is fixed at 30 days regardless of plan
// cadence, so "the full period starts in month 2" holds the same way for the quarterly and yearly
// plans as for the monthly one: it only ever defers the FIRST invoice, never shortens or lengthens
// whichever interval the chosen Price itself bills at afterwards.
//
// Whether this truly charges the R$1,99 one-time Price immediately, together with the trial
// starting, is the issue's own "first mandatory step" to confirm against a real sandbox — pending
// for this run (see the ISO-1393 comment thread: a Stripe connection was requested and is still
// outstanding). If it turns out not to, the documented fallback is a Subscription Schedule
// (phase 1 = one month at the intro price, phase 2 = the chosen plan) instead of this function.
export async function createCheckoutSession(pool, user, plan, { successUrl, cancelUrl }) {
  const priceId = planPriceId(plan);
  if (!priceId) return { error: 'invalid plan' };
  const customerId = await ensureStripeCustomer(pool, user);
  const firstTime = !(await hasEverSubscribed(pool, user.id));
  const lineItems = [{ price: priceId, quantity: 1 }];
  const subscriptionData = { metadata: { userId: user.id, plan } };
  if (firstTime) {
    const introPrice = process.env.STRIPE_PRICE_INTRO;
    if (introPrice) lineItems.push({ price: introPrice, quantity: 1 });
    subscriptionData.trial_period_days = 30;
  }
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

export async function billingStatus(pool, userId) {
  const sub = await getLatestSubscription(pool, userId);
  if (!sub) return { enabled: true, status: 'none', active: false };
  return {
    enabled: true,
    status: sub.status || 'none',
    active: isActiveStatus(sub.status),
    plan: sub.plan || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    trialEnd: sub.trialEnd || null,
    firstFullCharge: sub.firstFullCharge || null
  };
}
