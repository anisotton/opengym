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
  setStripeCustomerId, getUserIdByStripeCustomer, hasEverSubscribed, getUserById,
  upsertSubscription, getSubscriptionById, getLatestSubscription, getSubscriptionsDueForFirstPeriodNotice,
  getStripeCleanupDue, deleteStripeCleanup, bumpStripeCleanupFailure,
  isBillingCatalogSeeded, getCatalogPlan, getPriceById, getPlanIdForPrice, getCurrentIntroPrice,
  getCurrentPriceAmountForPlan, getAvailablePlans, seedBillingCatalog, isIntroPrice,
  getBillingProductId, nextPlanSortOrder, insertDraftPlanAndPrice, updatePlanDisplay, reorderPlans,
  setPlanAvailabilityRow, insertDraftPrice, publishPriceVersionRows,
  insertReconciledDraftPrice, insertReconciledRetiredPrice, getUnknownSubscriptionPriceIds,
  claimBillingAdminAction, finishBillingAdminAction, listCatalogAdmin, listBillingAdminActions
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

// Catalog-first, env as a fallback that only ever fires for a row the catalog has never heard of
// (an instance that hasn't seeded yet, per ISO-1623 §6.2 — "deploy is safe even before the seed
// runs"). Deliberately NOT narrowed to `state = 'current'`: a subscription billed off a Price
// that has since been retired must keep showing its plan's name forever (ISO-1619 principle #2).
export async function planFromPrice(pool, priceId) {
  if (!priceId) return null;
  const catalogPlan = await getPlanIdForPrice(pool, priceId);
  if (catalogPlan) return catalogPlan;
  for (const [plan, envName] of Object.entries(PLAN_PRICE_ENV)) {
    if (process.env[envName] === priceId) return plan;
  }
  return null;
}

// Checkout's own gate (ISO-1623 §4): a plan the catalog knows about may only be sold while it is
// `available` AND its linked Price is still `current` — the Stripe side enforces the same thing
// independently (an `active:false` Price is refused by a new Checkout Session), this is just the
// app's own check so a disabled plan answers with a clean 400 rather than a raw Stripe error.
// Falls back to the legacy env lookup only when the catalog has no row for this slug at all —
// once it's seeded, an existing slug with `available:false` is refused even if the env var it
// used to read from is still set.
async function resolvePlanForCheckout(pool, plan) {
  const row = await getCatalogPlan(pool, plan);
  if (row) {
    if (!row.available || !row.currentPriceId) return null;
    const price = await getPriceById(pool, row.currentPriceId);
    return price?.state === 'current' ? price.id : null;
  }
  return planPriceId(plan);
}

// The once-per-account first-period Price (R$1,99): the catalog's shared `current` intro Price
// once seeded, the env var before that.
async function resolveIntroPriceId(pool) {
  if (await isBillingCatalogSeeded(pool)) return (await getCurrentIntroPrice(pool))?.id || null;
  return process.env.STRIPE_PRICE_INTRO || null;
}

const SEED_PLAN_ORDER = ['monthly', 'quarterly', 'yearly'];
const SEED_DISPLAY_NAME = { monthly: 'Mensal', quarterly: 'Trimestral', yearly: 'Anual' };

function seedPriceProblem(price, label) {
  if (price.currency !== 'brl') return `${label}: currency is ${price.currency}, expected brl`;
  if (!price.recurring) return `${label}: not a recurring Price`;
  if (!['month', 'year'].includes(price.recurring.interval)) return `${label}: unexpected interval ${price.recurring.interval}`;
  if (![1, 3, 6, 12].includes(price.recurring.interval_count)) return `${label}: unexpected interval_count ${price.recurring.interval_count}`;
  // ISO-1630 (T1a loose end): a sandbox key seeding a live Price (or vice versa) used to go
  // unnoticed — stripeIsLive() with no Price argument reads the configured key's own prefix, so
  // this is the key's mode, not a guess derived from the Price being validated.
  if (price.livemode !== stripeIsLive()) return `${label}: livemode is ${price.livemode}, but the configured key is ${stripeIsLive() ? 'live' : 'sandbox'}`;
  return null;
}

const productIdOf = price => (typeof price.product === 'string' ? price.product : price.product.id);

// ISO-1630: whether this instance's Stripe key is a live one — the prefix (`sk_`/`rk_` restricted
// keys both carry `_live_`/`_test_` right after) decides on its own for every ordinary caller. The
// one caller that has a Price in hand before it has ever looked at a key it minted itself
// (seedPriceProblem below, validating a Price against the *key's* mode) passes it in as a
// fallback — never the other way around: a key's own prefix is always trusted over a Price's
// `livemode` when both are available, since the key is what actually decides what any write here
// would do.
export function stripeIsLive(price) {
  const key = process.env.STRIPE_API_KEY || '';
  if (/^(sk|rk)_live_/.test(key)) return true;
  if (/^(sk|rk)_test_/.test(key)) return false;
  return !!price?.livemode;
}

// The live gate (plan §4 of ISO-1619/ISO-1630): every admin catalog write that touches Stripe is
// refused with 423 `live-writes-disabled` against a live key unless an operator has explicitly
// set `BILLING_ADMIN_LIVE=1` — the one override this issue allows, and the one env var server.js
// needs to decide `liveWritesDisabled` for the admin UI (GET /api/admin/billing/catalog) without
// duplicating this check.
export function liveWritesDisabled() {
  return stripeIsLive() && process.env.BILLING_ADMIN_LIVE !== '1';
}

// Boot-time, idempotent (ISO-1623 §3): fills billing_plans/billing_prices from the env's own
// STRIPE_PRICE_* the very first time an instance boots with the catalog migration applied — never
// again after that (isBillingCatalogSeeded short-circuits above), so a later admin edit is never
// clobbered by a redeploy. Any divergence (wrong currency, an interval the catalog doesn't
// expect, a missing env var) aborts the WHOLE seed instead of half-filling the catalog — billing
// simply keeps reading PLAN_PRICE_ENV/PLAN_AMOUNT_CENTS until whoever's deploying fixes the env
// and the next boot tries again. The four STRIPE_PRICE_* vars stay mandatory either way (§6.3,
// rollback): this seed is additive, never a replacement for them.
export async function seedCatalogFromEnv(pool) {
  if (!BILLING_ON) return;
  if (await isBillingCatalogSeeded(pool)) return;
  const introId = process.env.STRIPE_PRICE_INTRO;
  const planIds = SEED_PLAN_ORDER.map(slug => [slug, process.env[PLAN_PRICE_ENV[slug]]]);
  if (!introId || planIds.some(([, id]) => !id)) {
    console.error('billing: catalog seed skipped — STRIPE_PRICE_MONTHLY/QUARTERLY/YEARLY/INTRO must all be set');
    return;
  }
  const stripe = getStripe();
  let introPrice;
  const plans = [];
  try {
    introPrice = await stripe.prices.retrieve(introId);
    const introProblem = seedPriceProblem(introPrice, 'STRIPE_PRICE_INTRO');
    if (introProblem) throw new Error(introProblem);
    for (const [slug, priceId] of planIds) {
      const price = await stripe.prices.retrieve(priceId);
      const problem = seedPriceProblem(price, slug);
      if (problem) throw new Error(problem);
      plans.push({
        id: slug,
        display: { 'pt-BR': { name: SEED_DISPLAY_NAME[slug] } },
        price: {
          id: price.id, unitAmount: price.unit_amount, currency: price.currency,
          interval: price.recurring.interval, intervalCount: price.recurring.interval_count,
          livemode: price.livemode, stripeProductId: productIdOf(price)
        }
      });
    }
  } catch (e) {
    console.error('billing: catalog seed skipped —', e.message);
    return;
  }
  await seedBillingCatalog(pool, {
    intro: {
      id: introPrice.id, unitAmount: introPrice.unit_amount, currency: introPrice.currency,
      interval: introPrice.recurring.interval, intervalCount: introPrice.recurring.interval_count,
      livemode: introPrice.livemode, stripeProductId: productIdOf(introPrice)
    },
    plans
  });
  console.log('billing: catalog seeded from env (monthly/quarterly/yearly + intro)');
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
// ISO-1447: a deleted account's row is gone, but a webhook event naming it (its own metadata, or
// a customer id that no longer resolves to anyone) can still arrive afterwards — Stripe retries,
// or an event queued before the delete lands after it. Every candidate is checked against `users`
// before being handed back, not just trusted off the payload: metadata.userId in particular is
// never re-validated by Stripe itself, and handing it to upsertSubscription for an id nothing
// references any more would throw on that table's own FK instead of the plain no-op this should
// be (and, had the FK not caught it, would have resurrected a subscription row for an account that
// no longer exists).
async function resolveUserId(pool, obj) {
  const candidate = obj.metadata?.userId || (obj.customer ? await getUserIdByStripeCustomer(pool, obj.customer) : null);
  if (!candidate) return null;
  return (await getUserById(pool, candidate)) ? candidate : null;
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
      // ISO-1630: the catalog's own kind='intro' column, not a straight env-var compare — see
      // isIntroPrice's own comment (store.js) for why that stopped being true once an admin could
      // mint a new intro Price through the catalog instead of STRIPE_PRICE_INTRO.
      const firstPeriod = await isIntroPrice(pool, priceId);
      await upsertSubscription(pool, obj.id, userId, {
        status: obj.status,
        plan: (await planFromPrice(pool, priceId)) || obj.metadata?.plan || null,
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
      const isFullPriceInvoice = invoicePriceId != null && !(await isIntroPrice(pool, invoicePriceId));
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
  const priceId = await resolvePlanForCheckout(pool, plan);
  if (!priceId) return { error: 'invalid plan' };
  // ISO-1623 §5.4: two tabs completing Checkout at once must not end up with two live
  // subscriptions charged in parallel — the webhook's own `duplicateOf` handling (T2b) is the
  // backstop for the race that slips past this, not a replacement for refusing it here first.
  const last = await getLatestSubscription(pool, user.id);
  if (last && (canWrite(last) || last.pauseCollection)) return { error: 'already subscribed', code: 'already-subscribed' };
  const customerId = await ensureStripeCustomer(pool, user);
  const firstTime = !(await hasEverSubscribed(pool, user.id));
  const introPrice = await resolveIntroPriceId(pool);
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
export async function nextChargeAmountCents(pool, sub) {
  if (!sub?.firstPeriod) return sub?.priceAmount ?? null;
  const catalogAmount = await getCurrentPriceAmountForPlan(pool, sub.plan);
  return catalogAmount ?? (PLAN_AMOUNT_CENTS[sub.plan] ?? null);
}

// The exact app-facing contract from ISO-1392's spec (item 1 / "Ponto em aberto"): `status` is
// Stripe's own (never `trialing`), `firstPeriod` carries what `status` alone cannot say, and
// `nextChargeAmount` during a first period is the UPCOMING full-plan charge, not the R$1,99
// already on the subscription's current item. `lastInvoiceStatus` (ISO-1395, Sentinel review of
// SettingsPlan.jsx) is what tells a `canceled` subscription apart from one Stripe's own retries
// gave up on — `invoice.payment_failed` sets it to 'failed' and nothing else clears it before a
// `customer.subscription.deleted` lands, so a `canceled`+`'failed'` pair means the cancellation
// came from a payment failure, not someone cancelling on purpose.
export async function billingStatus(pool, userId) {
  const sub = await getLatestSubscription(pool, userId);
  if (!sub) return { enabled: true, status: 'none', active: false, firstPeriod: false };
  return {
    enabled: true,
    status: sub.status || 'none',
    active: canWrite(sub),
    plan: sub.plan || null,
    firstPeriod: !!sub.firstPeriod,
    since: sub.createdAt || null,
    nextChargeDate: sub.currentPeriodEnd || null,
    nextChargeAmount: await nextChargeAmountCents(pool, sub),
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    firstFullCharge: sub.firstFullCharge || null,
    lastInvoiceStatus: sub.lastInvoiceStatus || null
  };
}

/* ---------- account deletion: the Stripe side (ISO-1447, Phase 4 — LGPD) ----------
 * deleteAccount (server.js) queues a `stripe_cleanup` row (store.js) in the same transaction as
 * the user row's own delete, then calls attemptStripeCleanup once, right away, outside that
 * transaction — success removes the row on the spot; a failure (Stripe down, a transient error)
 * leaves it for tickStripeCleanup's retry. Either way the local deletion has already committed:
 * Stripe is cleaned up best-effort, never a reason the account delete itself fails or half-applies.
 */

// Cancels every subscription this account had that was still live (immediately — never
// cancel_at_period_end, which would leave it billing someone no longer there) and the Stripe
// customer itself. A Subscription Schedule outlives the subscription it is driving (ISO-1393's
// own two-phase schedules), so it is released first — cancelling the subscription alone would
// leave the schedule behind, driving a subscription that no longer exists. "Already gone" (a
// previous attempt that got far enough, or an operator who cleaned it up by hand in the Stripe
// dashboard) is treated as success, not an error to retry forever on.
async function cleanupStripeCustomer(stripe, { customerId, subscriptionIds }) {
  const missing = e => e?.code === 'resource_missing' || e?.statusCode === 404;
  for (const subId of subscriptionIds) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subId);
      if (subscription.schedule) {
        // subscriptionSchedules.cancel cancels the schedule AND its subscription in one call —
        // calling subscriptions.cancel next would hit a subscription Stripe already considers
        // canceled (a 400, not the 404/resource_missing `missing` treats as "already gone").
        const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id;
        await stripe.subscriptionSchedules.cancel(scheduleId);
      } else {
        await stripe.subscriptions.cancel(subId);
      }
    } catch (e) { if (!missing(e)) throw e; }
  }
  try { await stripe.customers.del(customerId); }
  catch (e) { if (!missing(e)) throw e; }
}

// One pending cleanup. Exported so deleteAccount (server.js) can try the row it just queued right
// after its own transaction commits, without waiting for the next tick — and so tickStripeCleanup
// below and this are the same code path either way.
export async function attemptStripeCleanup(pool, row) {
  await cleanupStripeCustomer(getStripe(), row);
  await deleteStripeCleanup(pool, row.id);
}

// The periodic retry (server.js registers this on an interval, same shape as
// tickFirstPeriodNotices above) — every pending cleanup whose backoff has elapsed
// (getStripeCleanupDue), oldest first. A failure here is exactly what bumpStripeCleanupFailure's
// backoff is for: logged, not thrown, so one stuck row never stops the rest of the tick.
export async function tickStripeCleanup(pool) {
  for (const row of await getStripeCleanupDue(pool)) {
    try { await attemptStripeCleanup(pool, row); }
    catch (e) {
      console.error('billing: stripe cleanup failed for customer', row.customerId, e.message);
      await bumpStripeCleanupFailure(pool, row.id, e.message);
    }
  }
}

/* ---------- admin catalog writes (ISO-1619/ISO-1630) ----------
 * Called only after server.js has already done requireAdmin, the live gate (liveWritesDisabled
 * above, for whichever of these touch Stripe), proveOwner and the `reason ≥ 10` check — this file
 * orchestrates Stripe + the DB, not auth. The shape constants below mirror migrations/010's own
 * CHECK constraints, so a bad request is refused with 400 here rather than a raw 23514 from
 * Postgres.
 */
const CATALOG_INTERVALS = ['month', 'year'];
const CATALOG_INTERVAL_COUNTS = [1, 3, 6, 12];
export const validPlanId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(id);
export const validDisplay = d => !!d && typeof d === 'object' && !Array.isArray(d)
  && typeof d['pt-BR']?.name === 'string' && d['pt-BR'].name.trim().length > 0;
export const validInterval = i => CATALOG_INTERVALS.includes(i);
export const validIntervalCount = n => CATALOG_INTERVAL_COUNTS.includes(n);
export const validUnitAmount = n => Number.isInteger(n) && n >= 100 && n <= 1000000;

// The idempotency wrapper every Stripe-touching write below shares (createOffer,
// setPlanAvailability, createPriceVersion, publishPriceVersion) — claims the Idempotency-Key first
// (store.js's claimBillingAdminAction, the same one-time-claim shape claimStripeEvent uses for a
// webhook event), so a replay of the same key — the same confirm dialog submitted twice, a client
// retry after a dropped response — is handed back the first attempt's own result instead of
// calling Stripe a second time. `fn` does the actual Stripe + DB work and returns either
// `{ error, code, stripeIds? }` or `{ after, before?, stripeIds }`; `after` is exactly the payload
// server.js answers the request with, so a replay can hand it back verbatim.
async function runBillingAdminAction(pool, { idempotencyKey, actor, targetUserId, action, reason, request }, fn) {
  const claim = await claimBillingAdminAction(pool, { idempotencyKey, actorId: actor.id, targetUserId, action, reason, request });
  if (!claim.claimed) {
    const row = claim.row;
    if (row.status === 'succeeded') return { ok: true, replay: true, after: row.after };
    if (row.status === 'failed') return { error: row.error || 'the previous attempt with this Idempotency-Key failed', code: 'action-failed', replay: true };
    return { error: 'a previous attempt with this Idempotency-Key is still in progress', code: 'action-in-progress' };
  }
  let result;
  try { result = await fn(); }
  catch (e) {
    await finishBillingAdminAction(pool, claim.row.id, { status: 'failed', error: e.message });
    throw e;
  }
  if (result.error) {
    await finishBillingAdminAction(pool, claim.row.id, { status: 'failed', error: result.error, stripeIds: result.stripeIds });
    return result;
  }
  await finishBillingAdminAction(pool, claim.row.id, {
    status: 'succeeded', before: result.before ?? null, after: result.after ?? null, stripeIds: result.stripeIds
  });
  return { ok: true, after: result.after };
}

// "Criar oferta" (plan §3): mints a `prices.create` with `active:false` and `metadata.bf_plan`/
// `bf_version` (what reconcile below matches on), then persists the plan (`available:false`) and
// its first Price (`draft`) in one DB transaction. Reuses the catalog's single Stripe Product
// (`getBillingProductId`) — refuses with `no-product` rather than ever minting a second one.
export async function createOffer(pool, { id, display, interval, intervalCount, unitAmount, decisionRef, actor, reason, idempotencyKey }) {
  return runBillingAdminAction(pool, {
    idempotencyKey, actor, targetUserId: null, action: 'catalog.plan.create', reason,
    request: { id, display, interval, intervalCount, unitAmount, decisionRef }
  }, async () => {
    if (await getCatalogPlan(pool, id)) return { error: 'a plan with this id already exists', code: 'id-taken' };
    const productId = await getBillingProductId(pool);
    if (!productId) return { error: 'the catalog has no known Stripe product yet — run stripe:setup first', code: 'no-product' };
    const introPrice = await getCurrentIntroPrice(pool);
    const sortOrder = await nextPlanSortOrder(pool);
    const price = await getStripe().prices.create({
      product: productId, currency: 'brl', unit_amount: unitAmount,
      recurring: { interval, interval_count: intervalCount },
      active: false, metadata: { bf_plan: id, bf_version: '1' }
    }, { idempotencyKey });
    const result = await insertDraftPlanAndPrice(pool,
      { id, display, interval, intervalCount, sortOrder, introPriceId: introPrice?.id || null },
      {
        id: price.id, unitAmount: price.unit_amount, currency: price.currency, interval: price.recurring.interval,
        intervalCount: price.recurring.interval_count, livemode: price.livemode, stripeProductId: productIdOf(price),
        createdBy: actor.id, decisionRef
      }
    );
    if (result.error) return { ...result, stripeIds: { priceId: price.id } };
    return { ok: true, after: { plan: result.plan }, stripeIds: { priceId: price.id, productId } };
  });
}

// "Ativar/desativar plano": Stripe's own `prices.update active` on the plan's *current* Price,
// then the DB compare-and-set (store.js's setPlanAvailabilityRow) — in that order, so a version
// race lost after Stripe already flipped is reported as `stale-after-stripe`, never silently
// leaving Stripe and the DB disagreeing about whether the plan is on sale.
export async function setPlanAvailability(pool, { id, version, available, actor, reason, idempotencyKey }) {
  return runBillingAdminAction(pool, {
    idempotencyKey, actor, targetUserId: null, action: available ? 'catalog.plan.activate' : 'catalog.plan.deactivate', reason,
    request: { id, version, available }
  }, async () => {
    const plan = await getCatalogPlan(pool, id);
    if (!plan) return { error: 'no such plan', code: 'not-found' };
    if (plan.version !== version) return { error: 'changed since you loaded it', code: 'stale', current: plan };
    if (!plan.currentPriceId) return { error: 'this plan has no published price yet', code: 'no-current-price' };
    await getStripe().prices.update(plan.currentPriceId, { active: available }, { idempotencyKey });
    const result = await setPlanAvailabilityRow(pool, id, version, available);
    if (result.error) return { ...result, stripeIds: { priceId: plan.currentPriceId } };
    return { ok: true, after: { plan: result.plan }, before: plan, stripeIds: { priceId: plan.currentPriceId } };
  });
}

// "Nova versão de valor": a second (or later) `draft` Price for a plan that already sells one —
// `publishPriceVersion` below is the separate, explicit act that makes it `current`.
export async function createPriceVersion(pool, { planId, unitAmount, decisionRef, actor, reason, idempotencyKey }) {
  return runBillingAdminAction(pool, {
    idempotencyKey, actor, targetUserId: null, action: 'catalog.price.new-version', reason,
    request: { planId, unitAmount, decisionRef }
  }, async () => {
    const plan = await getCatalogPlan(pool, planId);
    if (!plan) return { error: 'no such plan', code: 'not-found' };
    const productId = await getBillingProductId(pool);
    if (!productId) return { error: 'the catalog has no known Stripe product yet', code: 'no-product' };
    const stripePrice = await getStripe().prices.create({
      product: productId, currency: 'brl', unit_amount: unitAmount,
      recurring: { interval: plan.interval, interval_count: plan.intervalCount },
      active: false, metadata: { bf_plan: planId, bf_version: String(plan.version) }
    }, { idempotencyKey });
    const row = await insertDraftPrice(pool, {
      id: stripePrice.id, planId, unitAmount: stripePrice.unit_amount, currency: stripePrice.currency,
      interval: stripePrice.recurring.interval, intervalCount: stripePrice.recurring.interval_count,
      livemode: stripePrice.livemode, stripeProductId: productIdOf(stripePrice), createdBy: actor.id, decisionRef
    });
    return { ok: true, after: { price: row }, stripeIds: { priceId: row.id, productId } };
  });
}

// "Publicar versão": Stripe first (activates the new Price, deactivates the old one — plan §3),
// then one DB transaction flips both Prices' `state` and the plan's `current_price_id` together.
// Distinct derived Idempotency-Keys per Stripe call: Stripe's own idempotency cache is keyed on
// (key, request) and refuses a second, different request under the same key outright, so reusing
// one key for both the activate and the deactivate call would throw on the second call, every
// time. Publishing never migrates an existing subscriber onto the new Price (grandfathering,
// ISO-1619 principle #2) — only Checkout reading `current_price_id` for new sales changes.
export async function publishPriceVersion(pool, { planId, newPriceId, version, actor, reason, idempotencyKey }) {
  return runBillingAdminAction(pool, {
    idempotencyKey, actor, targetUserId: null, action: 'catalog.price.publish', reason,
    request: { planId, newPriceId, version }
  }, async () => {
    const plan = await getCatalogPlan(pool, planId);
    if (!plan) return { error: 'no such plan', code: 'not-found' };
    if (plan.version !== version) return { error: 'changed since you loaded it', code: 'stale', current: plan };
    const newPrice = await getPriceById(pool, newPriceId);
    if (!newPrice || newPrice.planId !== planId || newPrice.state !== 'draft') {
      return { error: 'not a draft price of this plan', code: 'invalid-price' };
    }
    const oldPriceId = plan.currentPriceId;
    const stripe = getStripe();
    await stripe.prices.update(newPriceId, { active: true }, { idempotencyKey: `${idempotencyKey}:activate` });
    if (oldPriceId) await stripe.prices.update(oldPriceId, { active: false }, { idempotencyKey: `${idempotencyKey}:deactivate` });
    const result = await publishPriceVersionRows(pool, { planId, version, newPriceId, oldPriceId });
    if (result.error) return { ...result, stripeIds: { newPriceId, oldPriceId } };
    return { ok: true, after: { plan: result.plan }, before: plan, stripeIds: { newPriceId, oldPriceId } };
  });
}

// "Reorder" and the admin's full catalog read have no Stripe side at all — straight passthroughs
// to store.js, kept here only so server.js has one module to import the whole admin surface from.
export async function reorderCatalog(pool, order) {
  return reorderPlans(pool, order);
}
export async function editPlanDisplay(pool, id, version, display) {
  return updatePlanDisplay(pool, id, version, display);
}
export async function getCatalogAdminView(pool) {
  return listCatalogAdmin(pool);
}
export async function getBillingAdminActions(pool, limit) {
  return listBillingAdminActions(pool, limit);
}

// Reconcile (plan §3): every Stripe Price tagged `metadata.bf_plan` that this catalog doesn't
// know about yet is adopted as a `draft` (never auto-published — see insertReconciledDraftPrice's
// own comment); every `subscriptions.priceId` this catalog has never heard of is read straight off
// Stripe and recorded `retired` (never invents a value). Read-only against Stripe — no live gate,
// this never writes to Stripe at all.
export async function reconcileCatalog(pool) {
  const productId = await getBillingProductId(pool);
  if (!productId) return { error: 'the catalog has no known Stripe product yet', code: 'no-product' };
  const stripe = getStripe();
  const { data: stripePrices } = await stripe.prices.list({ product: productId, limit: 100 });
  const adopted = [];
  for (const price of stripePrices) {
    const planId = price.metadata?.bf_plan;
    if (!planId) continue; // not ours — a Price minted by hand in the Dashboard for something else
    if (await getPriceById(pool, price.id)) continue; // already known
    if (!(await getCatalogPlan(pool, planId))) continue; // its own plan doesn't exist here — nothing sane to attach it to
    const row = await insertReconciledDraftPrice(pool, {
      id: price.id, planId, unitAmount: price.unit_amount, currency: price.currency,
      interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count,
      livemode: price.livemode, stripeProductId: productIdOf(price)
    });
    if (row) adopted.push(row.id);
  }
  const retired = [];
  for (const priceId of await getUnknownSubscriptionPriceIds(pool)) {
    let price;
    try { price = await stripe.prices.retrieve(priceId); }
    catch { continue; } // gone from Stripe too — nothing left to adopt, nothing to invent
    const metaPlanId = price.metadata?.bf_plan;
    const planId = metaPlanId && (await getCatalogPlan(pool, metaPlanId)) ? metaPlanId : null;
    const row = await insertReconciledRetiredPrice(pool, {
      id: price.id, planId, unitAmount: price.unit_amount, currency: price.currency,
      interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count,
      livemode: price.livemode, stripeProductId: productIdOf(price)
    });
    if (row) retired.push(row.id);
  }
  return { ok: true, adopted, retired };
}
