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
import { withTransaction } from './db.js';
import {
  setStripeCustomerId, getUserIdByStripeCustomer, hasEverSubscribed, getUserById,
  upsertSubscription, getSubscriptionById, getSubscriptionsForUser,
  getSubscriptionsDueForFirstPeriodNotice,
  getStripeCleanupDue, deleteStripeCleanup, bumpStripeCleanupFailure,
  isBillingCatalogSeeded, getCatalogPlan, getPriceById, getPlanIdForPrice, getCurrentIntroPrice,
  getCurrentPriceAmountForPlan, getAvailablePlans, seedBillingCatalog, isIntroPrice,
  getBillingProductId, nextPlanSortOrder, insertDraftPlanAndPrice, updatePlanDisplay, reorderPlans,
  setPlanAvailabilityRow, insertDraftPrice, publishPriceVersionRows,
  insertReconciledDraftPrice, insertReconciledRetiredPrice, getUnknownSubscriptionPriceIds,
  claimBillingAdminAction, finishBillingAdminAction, listCatalogAdmin, listBillingAdminActions,
  listBillingAdminActionsForUser
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
  // ISO-1625 (T1b review): a key set but with a prefix neither pattern matches (a future Stripe
  // key format, a typo) used to fall through to `!!price?.livemode` — false for every ordinary
  // caller, which never passes a price, so an unrecognized key silently read as sandbox and the
  // live gate below would wave through a write this instance has no business making. Fail closed
  // instead: a key that exists but isn't recognizably sandbox counts as live.
  if (key) return true;
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
// ISO-1625 (T2b): a suspended collection never grants free access — `status` itself stays
// `active` while paused (there is no synthetic `paused` status, ISO-1626), so pauseCollection is
// its own, separate condition here rather than a status value. Read off the DB mirror, not a live
// Stripe call: applyStripeEvent's own customer.subscription.* handling (below) is what keeps
// `subscriptions.data.pauseCollection` converged, same as every other field canWrite already
// trusted before this.
export function canWrite(subscription) {
  return WRITABLE_STATUSES.has(subscription?.status) && !subscription?.pauseCollection;
}

// ISO-1625 (Oráculo review, T2b): the row every write-gate reads — never simply "whichever row
// was touched most recently" (getLatestSubscription), which a duplicate's own cancellation can
// make true even while the account's real, still-writable subscription sits untouched:
// markDuplicateSubscriptions clears the canceled duplicate's own duplicateOf, bumping exactly
// that row's updated_at, so getLatestSubscription would hand back the just-canceled duplicate
// instead of the primary subscription the account is actually paying for. Prefers the oldest
// writable row — the same "primary" markDuplicateSubscriptions itself settled on — and falls
// back to whichever row was touched most recently only when none is writable at all (so a fully
// cancelled/no-subscription account still reads the most relevant row for billingStatus to show).
export async function getAccountSubscription(pool, userId) {
  const rows = await getSubscriptionsForUser(pool, userId);
  const writable = rows.filter(canWrite).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return writable[0] || rows[0] || null;
}

export async function hasActiveAccess(pool, userId) {
  return canWrite(await getAccountSubscription(pool, userId));
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
// `idempotencyKey` is optional — the webhook call site below relies on claimStripeEvent's own
// idempotency instead and passes none; the admin "trocar plano" action (ISO-1624 T2a) that reuses
// this same shape passes its own, suffixed by step per plan §5.1 (one action, more than one
// Stripe call). Returns the schedule's id so a caller that needs it for `stripeIds`/`after` isn't
// forced into a second retrieve just to learn it.
async function convertToSchedule(stripe, subscriptionId, targetPriceId, idempotencyKey) {
  const schedule = await stripe.subscriptionSchedules.create(
    { from_subscription: subscriptionId }, idempotencyKey ? { idempotencyKey: `${idempotencyKey}:create` } : undefined
  );
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
  }, idempotencyKey ? { idempotencyKey: `${idempotencyKey}:update` } : undefined);
  return schedule.id;
}

// Shared by every admin subscription action below that has to branch on "is this subscription
// still schedule-governed" (plan §5's own "sem schedule" / "com schedule" split) — `subscription.
// schedule` comes back as a bare id unless the caller expanded it.
const scheduleIdOf = sub => (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id) || null;
const lastPhaseOf = schedule => schedule.phases[schedule.phases.length - 1];

// Which phase of `schedule` is in effect right now — NOT the same as "the last phase": Stripe
// keeps a schedule attached to its subscription well past the transition into its final, open-
// ended phase (there is no automatic `release` the moment that phase starts), so a two-phase
// schedule this app created at Checkout can still have both phases long after the first month —
// `cancelAtPeriodEnd`/`resumeCancellation` below both have to know which one is actually current,
// not just reach for `phases[length-1]`. `current_phase` is Stripe's own answer when present
// (matched back to its entry in `phases` by `start_date`, since that's the one field guaranteed
// to line up); the date comparison is the fallback for a schedule object that omits it.
function activePhaseIndex(schedule, nowUnix) {
  if (schedule.current_phase) {
    const idx = schedule.phases.findIndex(p => p.start_date === schedule.current_phase.start_date);
    if (idx !== -1) return idx;
  }
  let idx = schedule.phases.length - 1;
  for (let i = 0; i < schedule.phases.length; i++) {
    const p = schedule.phases[i];
    if (p.start_date <= nowUnix && (p.end_date == null || nowUnix < p.end_date)) { idx = i; break; }
  }
  return idx;
}

// The subscription-row shape shared by applyStripeEvent's own created/updated case and the
// "sincronizar" admin action (ISO-1624 T2a) — "mesmo mapeamento do webhook" per the plan, read off
// whichever Stripe Subscription object `obj` is (a webhook payload or a live retrieve, the two
// shapes we ever call this with) rather than two copies of the same field-by-field mapping.
// `source` (ISO-1625 T2b) is pure provenance, not a business field: which mechanism last wrote
// this mirror row, for an operator reading `subscriptions.data` by hand when a convergence bug is
// suspected — applyStripeEvent's own call passes nothing (defaults to 'webhook'), reconcileSubscriptionFromStripe
// (the "sincronizar" action and the automatic post-timeout recovery) passes 'sync'.
async function subscriptionWriteFields(pool, obj, source = 'webhook') {
  const priceId = obj.items?.data?.[0]?.price?.id || null;
  const priceAmount = obj.items?.data?.[0]?.price?.unit_amount ?? null;
  // ISO-1630: the catalog's own kind='intro' column, not a straight env-var compare — see
  // isIntroPrice's own comment (store.js) for why that stopped being true once an admin could mint
  // a new intro Price through the catalog instead of STRIPE_PRICE_INTRO.
  const firstPeriod = await isIntroPrice(pool, priceId);
  const scheduleId = scheduleIdOf(obj);
  // ISO-1625 (T2b): one extra retrieve, only while a schedule actually governs this subscription —
  // the subscription object alone never carries its schedule's own phases. Best-effort: a schedule
  // that has just been released/canceled between the subscription retrieve above and this one is
  // left as scheduledPriceId: null rather than failing the whole write; the schedule's own webhook
  // event (below) converges this independently anyway.
  let scheduledPriceId = null;
  if (scheduleId) {
    try {
      const schedule = await getStripe().subscriptionSchedules.retrieve(scheduleId);
      scheduledPriceId = lastPhaseOf(schedule).items[0]?.price ?? null;
    } catch (e) { console.error('billing: schedule retrieve failed for', scheduleId, e.message); }
  }
  return {
    status: obj.status,
    plan: (await planFromPrice(pool, priceId)) || obj.metadata?.plan || null,
    priceId,
    priceAmount,
    customerId: obj.customer,
    // Admin ficha item #1 (ISO-1624 T2a): the one case this app's own code ever tags is
    // `metadata.source=admin_link` ("gerar link" — generateSubscriptionLink below); anything else
    // is the account's own self-serve Checkout. Read off the subscription's own metadata, which
    // Stripe persists unchanged for the life of the object, not re-derived from whichever route
    // happens to be looking at it.
    origin: obj.metadata?.source === 'admin_link' ? 'admin_link' : 'self',
    firstPeriod,
    // Monotonic, unlike `firstPeriod` itself: the schedule's own phase-change update flips
    // `firstPeriod` back to false the moment the subscription moves off the intro Price, which can
    // land before or after the matching `invoice.paid` for that same transition. This stays true
    // forever once true once, so invoice.paid below can tell "this account once had a first
    // period" apart from "never had one" (a returning subscriber) regardless of which of the two
    // events happens to arrive first.
    ...(firstPeriod ? { hadFirstPeriod: true } : {}),
    // `current_period_end` moved off the subscription object itself under this account's API
    // version (Stripe's "flexible billing" shape) — it only exists per-item now. Fallback kept for
    // the pre-dahlia shape (older webhook replays, or an instance pinned to an earlier version),
    // confirmed against the real sandbox payload.
    currentPeriodEnd: toIso(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end),
    cancelAtPeriodEnd: !!obj.cancel_at_period_end,
    // ISO-1625 (T2b): persisted now (it never was before — see openapi.yaml's own updated note on
    // BillingSubscriptionRow) so canWrite's 402 gate can read it without a live Stripe call on
    // every PUT /api/data — applyStripeEvent's own fetch-latest retrieve and "sincronizar" are
    // the only writers, same as every other field here; no admin route ever sets this directly.
    pauseCollection: obj.pause_collection || null,
    scheduleId,
    scheduledPriceId,
    source
  };
}

// ISO-1625 (T2b, plan §5.3): a second *writable* subscription on the same account — a race that
// slipped past createCheckoutSession's own guard (two tabs, or a self-serve checkout racing an
// admin-generated link), or simply two accounts' worth of history colliding after a support fix —
// is marked, never refunded automatically (D-A3 is still open; a human decides from the ficha).
// Recomputed from scratch on every subscription-touching event for this account, rather than
// patched incrementally, so it self-heals the moment only one writable row is left (a
// cancellation, cancelImmediately) without needing its own cleanup path. The oldest writable row
// is always "primary" (duplicateOf: null) — stable across repeated runs since createdAt never
// changes, so this never flips which one is "the" subscription back and forth.
async function markDuplicateSubscriptions(pool, userId) {
  const rows = await getSubscriptionsForUser(pool, userId);
  const live = rows.filter(canWrite).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const primaryId = live[0]?.id ?? null;
  for (const row of rows) {
    const desired = live.length > 1 && row.id !== primaryId && live.some(r => r.id === row.id) ? primaryId : null;
    if ((row.duplicateOf ?? null) !== desired) await upsertSubscription(pool, row.id, userId, { duplicateOf: desired });
  }
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

    // ISO-1625 (T2b): fetch-latest, never this event's own payload — Stripe does not guarantee
    // webhook delivery order, so writing exactly what one delivery says can regress a newer state
    // a slower-to-arrive-but-earlier-fired delivery already wrote. Retrieving the subscription
    // fresh makes every delivery (created, updated, deleted alike — `deleted` is just `updated`
    // with status already `canceled` once retrieved) converge on whatever Stripe currently says,
    // independent of arrival order. `claimStripeEvent`'s own per-event-id claim still means this
    // exact delivery is applied only once; it is convergence across *different* deliveries this
    // fixes, not a second idempotency layer.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = await resolveUserId(pool, obj);
      if (!userId) break;
      // First-ever subscription, still on the intro Price, not a schedule yet: convert it and stop
      // — the conversion's own update event re-enters this same case with the final shape, so
      // nothing below needs to run against the pre-conversion object.
      if (event.type === 'customer.subscription.created' && obj.metadata?.scheduleTo && !obj.schedule) {
        await convertToSchedule(getStripe(), obj.id, obj.metadata.scheduleTo);
        break;
      }
      const live = await getStripe().subscriptions.retrieve(obj.id);
      await upsertSubscription(pool, obj.id, userId, await subscriptionWriteFields(pool, live));
      await markDuplicateSubscriptions(pool, userId);
      break;
    }

    // ISO-1625 (T2b, then Oráculo review): the schedule's own lifecycle, mirrored onto whichever
    // subscription it drives — fetch-latest here too, same reasoning as customer.subscription.*
    // above: a delayed `updated` arriving after a `released`/`canceled` already landed must not
    // resurrect scheduleId/scheduledPriceId onto a subscription this schedule no longer governs.
    // "Still governs" is decided by the schedule's own current `status` (`not_started`/`active`
    // mean it does; `released`/`canceled`/`completed` mean it doesn't) — never by which event
    // type happened to arrive, which only says a change happened, not what the latest one left
    // behind. `released_subscription` is where Stripe puts the id once `subscription` itself has
    // already gone back to null on release.
    case 'subscription_schedule.updated':
    case 'subscription_schedule.released':
    case 'subscription_schedule.canceled': {
      const subId = (typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id)
        || (typeof obj.released_subscription === 'string' ? obj.released_subscription : obj.released_subscription?.id);
      if (!subId) break;
      const existing = await getSubscriptionById(pool, subId);
      if (!existing) break;
      const live = await getStripe().subscriptionSchedules.retrieve(obj.id);
      const stillGoverning = live.status === 'active' || live.status === 'not_started';
      await upsertSubscription(pool, subId, existing.userId, {
        scheduleId: stillGoverning ? live.id : null,
        scheduledPriceId: stillGoverning ? (lastPhaseOf(live).items[0]?.price ?? null) : null
      });
      break;
    }

    // ISO-1625 (T2b, plan §3): a Price minted or flipped active/inactive — in the Dashboard, by
    // this app's own admin routes converging a `stale-after-stripe` race (billing.js's own
    // compensation above already reverts the common case; this is the independent, order-agnostic
    // backstop for whatever it misses), or by a later operator action nothing here has to name
    // ahead of time. `reconcilePriceFromStripe` only ever adopts a Price this catalog has never
    // heard of as a `draft` — an already-known row's money/shape is immutable by DB trigger and is
    // never touched here either, matching the plan's own "só active/metadata, nunca valor".
    case 'price.created':
    case 'price.updated': {
      await reconcilePriceFromStripe(pool, obj);
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
// `extraMetadata` (ISO-1624 T2a): the admin "gerar link" action's own `metadata.source=admin_link`
// tag, folded into the same subscription_data.metadata every other Checkout already carries —
// never a second code path, so the once-per-account intro-Price rule above applies identically
// whether the link was opened by the user themselves or handed to them by an admin.
export async function createCheckoutSession(pool, user, plan, { successUrl, cancelUrl, extraMetadata, idempotencyKey } = {}) {
  const priceId = await resolvePlanForCheckout(pool, plan);
  if (!priceId) return { error: 'invalid plan' };
  // ISO-1623 §5.4: two tabs completing Checkout at once must not end up with two live
  // subscriptions charged in parallel — the webhook's own `duplicateOf` handling (T2b) is the
  // backstop for the race that slips past this, not a replacement for refusing it here first.
  // canWrite's own pauseCollection check (T2b) already covers "paused, not actually free to
  // re-subscribe" — a suspended account still counts as "already subscribed" here.
  // getAccountSubscription (Oráculo review), not getLatestSubscription: a duplicate already
  // cancelled is the most recently touched row, but the account's still-writable primary is the
  // one that actually means "already subscribed".
  const existing = await getAccountSubscription(pool, user.id);
  if (existing && canWrite(existing)) return { error: 'already subscribed', code: 'already-subscribed' };
  const customerId = await ensureStripeCustomer(pool, user);
  const firstTime = !(await hasEverSubscribed(pool, user.id));
  const introPrice = await resolveIntroPriceId(pool);
  const useIntro = firstTime && !!introPrice;
  const lineItems = [{ price: useIntro ? introPrice : priceId, quantity: 1 }];
  const subscriptionData = { metadata: { userId: user.id, plan, ...(useIntro ? { scheduleTo: priceId } : {}), ...extraMetadata } };
  const stripe = getStripe();
  // `idempotencyKey` is optional — the self-serve route (POST /api/billing/checkout) has never
  // sent one, since a user clicking twice is a UX concern (a disabled button), not a replay this
  // app has to dedupe server-side. The admin "gerar link" action (ISO-1624 T2a) passes its own,
  // the same requirement every other admin action's Stripe call follows (plan §5.1).
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: lineItems,
    subscription_data: subscriptionData,
    success_url: successUrl,
    cancel_url: cancelUrl
  }, idempotencyKey ? { idempotencyKey } : undefined);
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

/* ---------- admin subscription action e-mails (ISO-1619/ISO-1625, T2b, plan §5 item 5) ----------
 * Small, pure readers server.js's own mail step uses right after an action's route succeeds —
 * never Stripe calls themselves, and billing.js still has no business importing mail.js or a
 * template (same reasoning as the firstPeriodNoticeHook seam above). `after` is exactly what each
 * action already returned to its caller, never re-fetched.
 */

// changePlan's own `after` is always schedule-shaped (it either just converted one or updated the
// existing one) — the new plan's price takes effect at the last phase's own start_date.
export function changePlanEffectiveUnix(after) {
  return after?.phases ? (lastPhaseOf(after).start_date ?? null) : null;
}

// cancelAtPeriodEnd's own `after` is a plain subscription (sem schedule) or a schedule (com
// schedule) — `phases` is what tells the two apart, same duck-typing scheduleIdOf itself uses.
export function cancellationEffectiveUnix(after) {
  if (!after) return null;
  if (after.phases) return lastPhaseOf(after).end_date ?? null;
  return after.current_period_end ?? after.items?.data?.[0]?.current_period_end ?? null;
}

// The new plan's display name and current price, for the "troca agendada" e-mail — `newPlanId`
// is already known from the request itself; this only resolves it to what the account will
// actually pay, the same catalog lookup createOffer/changePlan themselves use.
export async function planSummaryForMail(pool, planId) {
  const plan = await getCatalogPlan(pool, planId);
  if (!plan) return null;
  const price = plan.currentPriceId ? await getPriceById(pool, plan.currentPriceId) : null;
  return { name: plan.display?.['pt-BR']?.name || planId, amountCents: price?.unitAmount ?? null };
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
  // getAccountSubscription (Oráculo review): a cancelled duplicate must never eclipse the
  // account's own still-active primary just because it was the row most recently touched.
  const sub = await getAccountSubscription(pool, userId);
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
    // ISO-1625 (T1b review): the same key reused for a different action — a client bug reusing a
    // stale key, or a key guessed/replayed deliberately — must never be handed back as if it were
    // a harmless retry of the SAME action. Checked before `status`, since a mismatched action is
    // wrong regardless of what that other action's own outcome was.
    if (row.action !== action) return { error: 'this Idempotency-Key was already used for a different action', code: 'idempotency-key-reused' };
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

// Shared by setPlanAvailability's and publishPriceVersion's own `stale-after-stripe` handling
// below (Oráculo review): a losing CAS never inverts *this* action's own write — that is only
// correct when this write was the only thing touching Stripe, and it is wrong the moment the
// winner was another instance of the *same* action. Two deactivates (or two activates) racing the
// same plan would have one revert the other's own correct write right back; two publishes racing
// the same plan (sharing the same `oldPriceId`) would have the loser reactivate the Price the
// winner just correctly retired. Converging to the fresh row instead is safe precisely because
// the winner's own Stripe write already landed before its own CAS could succeed — by the time
// this action's CAS has lost, there is nothing left in flight to race against, only the plan's
// current, settled state to read and match: whichever Price this action touched is `active` only
// if it is still the plan's `currentPriceId`, and only if that plan is itself `available` — every
// other Price this action touched is `active:false`, unconditionally.
async function convergeToCurrentPlanState(stripe, pool, planId, touchedPriceIds, idempotencyKey) {
  const plan = await getCatalogPlan(pool, planId);
  for (const priceId of new Set(touchedPriceIds.filter(Boolean))) {
    const shouldBeActive = !!plan && priceId === plan.currentPriceId && plan.available;
    await stripe.prices.update(priceId, { active: shouldBeActive }, { idempotencyKey: `${idempotencyKey}:converge:${priceId}` })
      .catch(e => console.error('billing: stale-after-stripe convergence failed for', priceId, e.message));
  }
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
    const stripe = getStripe();
    await stripe.prices.update(plan.currentPriceId, { active: available }, { idempotencyKey });
    const result = await setPlanAvailabilityRow(pool, id, version, available);
    if (result.error) {
      // ISO-1625 (T1b review, then Oráculo review): Stripe already flipped `active` above — by
      // the time this CAS can fail, there is no path left where it didn't — so a lost race here
      // used to leave the Price disagreeing with what the DB still believed, with nothing to
      // notice or fix it. current_price_id must never end up pointing at a Price whose `active`
      // flag says otherwise — converged to the plan's actual, fresh state, never a blind revert
      // of this action's own write (see convergeToCurrentPlanState's own comment for why).
      await convergeToCurrentPlanState(stripe, pool, id, [plan.currentPriceId], idempotencyKey);
      return { ...result, stripeIds: { priceId: plan.currentPriceId } };
    }
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
    if (result.error) {
      // Same convergence as setPlanAvailability above, for the same reason — store.js's own
      // `code: 'stale-after-stripe'` on this exact path is what the review comment named. Two
      // publishes racing the same plan share this same `oldPriceId`; blindly reactivating it (the
      // original fix) would undo whichever of them actually won and correctly retired it —
      // converging both touched Prices to the plan's fresh state never does, since it reads what
      // actually won rather than assuming this action's own write was the only one in flight.
      await convergeToCurrentPlanState(stripe, pool, planId, [newPriceId, oldPriceId], idempotencyKey);
      return { ...result, stripeIds: { newPriceId, oldPriceId } };
    }
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

// Shared by reconcileCatalog's own sweep and the price.created/price.updated webhook case
// (ISO-1625 T2b item 3): adopts a Price this catalog has never heard of, tagged with this app's
// own `metadata.bf_plan`, as a `draft` — never auto-published, and never touches a Price already
// known (money/shape are immutable by DB trigger, and `active`/metadata are not reconciled onto an
// existing row either — plan §3's own "reconcile do Price: só active/metadata, nunca valor" is
// about not inventing a value for an UNKNOWN Price, not about mutating a known one from here).
async function reconcilePriceFromStripe(pool, price) {
  const planId = price.metadata?.bf_plan;
  if (!planId) return null; // not ours — a Price minted by hand in the Dashboard for something else
  if (await getPriceById(pool, price.id)) return null; // already known — immutable, nothing to do
  if (!(await getCatalogPlan(pool, planId))) return null; // its own plan doesn't exist here — nothing sane to attach it to
  return insertReconciledDraftPrice(pool, {
    id: price.id, planId, unitAmount: price.unit_amount, currency: price.currency,
    interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count,
    livemode: price.livemode, stripeProductId: productIdOf(price)
  });
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
  // ISO-1625 (T1b review): a catalog past 100 Prices (every draft/retired version ever created,
  // not just the ones currently current) used to have its tail silently unreconciled — `list`
  // never raises an error for a truncated page, it just stops handing back rows. Paged by id
  // (`starting_after`, Stripe's own cursor) rather than trusting a single `limit: 100` call to be
  // everything.
  const stripePrices = [];
  let startingAfter;
  do {
    const page = await stripe.prices.list({ product: productId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    stripePrices.push(...page.data);
    startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
  } while (startingAfter);
  const adopted = [];
  for (const price of stripePrices) {
    const row = await reconcilePriceFromStripe(pool, price);
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

/* ---------- admin subscription actions (ISO-1619/ISO-1624, T2a) ----------
 * Everything the user's billing ficha (`GET /api/admin/user/billing`) needs, plus the six actions
 * plan §5 lists (change plan, cancel at period end, resume, cancel immediately, generate link,
 * sync) and the mandatory preview. Every action is Stripe-first, never a locally-invented desired
 * state in `subscriptions` (the épico's own invariant) — the five that write to Stripe let the
 * existing webhook (applyStripeEvent, above) carry the result into the DB exactly as it always
 * has; only "sincronizar" (and the automatic post-timeout recovery below) ever call
 * subscriptionWriteFields/upsertSubscription directly, and only with what Stripe just said.
 */

// §5.2: a call Stripe rejected outright (bad request, a declined card) never touched anything —
// `rejected`, reported with Stripe's own message, nothing to reconcile. A call Stripe might have
// actually applied before the failure reached us (a timeout, Stripe's own infra erroring, a
// dropped connection) is `unknown` instead. Anything else is a bug in this code, not a Stripe
// outcome, and is left to throw and surface as a 500 the same way every other unhandled error here
// already does.
function classifyStripeError(e) {
  if (e instanceof Stripe.errors.StripeInvalidRequestError || e instanceof Stripe.errors.StripeCardError) return 'rejected';
  if (e instanceof Stripe.errors.StripeAPIError || e instanceof Stripe.errors.StripeConnectionError) return 'unknown';
  return null;
}

// The retrieve-and-map step "sincronizar" and the automatic post-timeout recovery both need —
// "mesmo mapeamento do webhook" (plan §5), applied on demand instead of waiting for Stripe's own
// event. `db` is a pool or an open transaction's client (both just `.query`); the automatic
// recovery runs after its own transaction has already closed, so it always passes the pool.
async function reconcileSubscriptionFromStripe(db, subscriptionId) {
  const before = await getSubscriptionById(db, subscriptionId);
  if (!before) return null;
  const obj = await getStripe().subscriptions.retrieve(subscriptionId);
  const after = await upsertSubscription(db, subscriptionId, before.userId, await subscriptionWriteFields(db, obj, 'sync'));
  return { before, after };
}

// The shared infra every action below runs through (plan §5.1): claims the Idempotency-Key first
// (a replay — the same dialog submitted twice, a client retry after a dropped response — is handed
// back the first attempt's own result instead of calling Stripe again), then holds
// `pg_advisory_xact_lock(hashtext(lockKey))` for the *whole* critical section — including the
// Stripe call itself, since `withTransaction` keeps the same connection open across the `await`s
// inside `fn` — so a second request racing the first on the same subscription (a different
// Idempotency-Key — the same-key case is already handled by the claim above) waits instead of
// racing it, and then finds `expectedUpdatedAt` stale against the row the first request just
// committed, rather than two requests both reading the pre-change row and both proceeding.
// `subscriptionId` is optional — "gerar link" has no subscription yet to lock or check, and locks
// on `lockKey` instead. `fn(sub, stripe, client)` returns `{ error, code, stripeIds? }` or
// `{ after, before?, stripeIds }`, same contract as runBillingAdminAction's `fn` above.
async function runSubscriptionAction(pool, { idempotencyKey, actor, targetUserId, subscriptionId, lockKey, expectedUpdatedAt, action, reason, request }, fn) {
  const claim = await claimBillingAdminAction(pool, { idempotencyKey, actorId: actor.id, targetUserId, action, reason, request });
  if (!claim.claimed) {
    const row = claim.row;
    // Same reasoning as runBillingAdminAction's own check above — a subscription action key
    // replayed against a different action is refused outright, never replayed as that action.
    if (row.action !== action) return { error: 'this Idempotency-Key was already used for a different action', code: 'idempotency-key-reused' };
    if (row.status === 'succeeded') return { ok: true, replay: true, after: row.after };
    if (row.status === 'unknown') return { error: 'the previous attempt is still being confirmed with Stripe — retry is safe', code: 'action-unknown', replay: true };
    if (row.status === 'failed') return { error: row.error || 'the previous attempt with this Idempotency-Key failed', code: 'action-failed', replay: true };
    return { error: 'a previous attempt with this Idempotency-Key is still in progress', code: 'action-in-progress' };
  }
  let outcome;
  try {
    outcome = await withTransaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey || subscriptionId]);
      let sub = null;
      if (subscriptionId) {
        sub = await getSubscriptionById(client, subscriptionId);
        if (!sub) return { error: 'no such subscription', code: 'not-found' };
        if (sub.userId !== targetUserId) return { error: 'subscription does not belong to this user', code: 'not-found' };
        if (expectedUpdatedAt && sub.updatedAt !== expectedUpdatedAt) return { error: 'changed since you loaded it — reload the ficha', code: 'stale', current: sub };
      }
      const result = await fn(sub, getStripe(), client);
      // A bare timestamp bump, never a business field (the épico's own invariant — "nenhuma rota
      // admin grava estado desejado em `subscriptions`" is about `plan`/`status`/etc, not this):
      // `expectedUpdatedAt` is a concurrency token, and most of these actions change nothing in
      // `subscriptions.data` themselves (the webhook does, later) — without this, a second action
      // right after a first one would still read the same `updated_at` and never go stale.
      if (!result.error && subscriptionId) await client.query('UPDATE subscriptions SET updated_at = now() WHERE id = $1', [subscriptionId]);
      return result;
    });
  } catch (e) {
    const kind = classifyStripeError(e);
    if (kind === 'rejected') {
      await finishBillingAdminAction(pool, claim.row.id, { status: 'failed', error: e.message });
      return { error: e.message, code: 'stripe-rejected' };
    }
    if (kind === 'unknown') {
      await finishBillingAdminAction(pool, claim.row.id, { status: 'unknown', error: e.message });
      if (subscriptionId) {
        await reconcileSubscriptionFromStripe(pool, subscriptionId)
          .catch(e2 => console.error('billing: post-timeout reconcile failed for', subscriptionId, e2.message));
      }
      return { error: 'Stripe did not confirm in time — reconciling now, retry with the same key is safe', code: 'action-unknown' };
    }
    throw e;
  }
  if (outcome.error) {
    await finishBillingAdminAction(pool, claim.row.id, { status: 'failed', error: outcome.error, stripeIds: outcome.stripeIds });
    return outcome;
  }
  await finishBillingAdminAction(pool, claim.row.id, {
    status: 'succeeded', before: outcome.before ?? null, after: outcome.after ?? null, stripeIds: outcome.stripeIds
  });
  return { ok: true, after: outcome.after };
}

// "Trocar plano" (plan §5): always the target plan's *current* catalog Price — the admin picks a
// plan, never a Price directly, same rule Checkout itself follows. Sem schedule: convertToSchedule
// (the same two-phase shape the first-ever Checkout already uses) turns the plain subscription
// into one, phase 1 the cycle already in progress, phase 2 the new plan, `release`. Com schedule
// (ainda no 1º mês): only the final phase's Price is swapped, `proration_behavior: none` — nothing
// is charged now, the next invoice is simply at the new plan's price.
export async function changePlan(pool, { userId, subscriptionId, newPlanId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.change-plan', reason, request: { subscriptionId, newPlanId }
  }, async (sub, stripe) => {
    const plan = await getCatalogPlan(pool, newPlanId);
    if (!plan?.currentPriceId) return { error: 'no such plan, or it has no current price', code: 'invalid-plan' };
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const scheduleId = scheduleIdOf(before);
    if (!scheduleId) {
      const newScheduleId = await convertToSchedule(stripe, subscriptionId, plan.currentPriceId, idempotencyKey);
      const after = await stripe.subscriptionSchedules.retrieve(newScheduleId);
      return { ok: true, before, after, stripeIds: { subscriptionId, scheduleId: newScheduleId } };
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    // Unlike cancelAtPeriodEnd/resumeCancellation below, `lastPhaseOf` (not `activePhaseIndex`)
    // is correct here regardless of which phase is actually in effect: this app's own schedules
    // never exceed two phases, so "the last phase" is either the still-pending plan phase (mid
    // first month — the literal "substitui o Price da fase 2" the plan asks for) or, once that
    // phase has started, the very same object is also the one currently active. Either way the
    // effect is the same: swap that phase's Price, no proration — the next invoice (today's if
    // already on the plan's own phase, the first one after the intro period otherwise) is simply
    // at the new plan's price.
    const finalPhase = lastPhaseOf(schedule);
    const phases = schedule.phases.slice(0, -1)
      .map(p => ({ items: p.items.map(i => ({ price: i.price })), start_date: p.start_date, end_date: p.end_date }));
    phases.push({ items: [{ price: plan.currentPriceId }], start_date: finalPhase.start_date });
    const after = await stripe.subscriptionSchedules.update(
      scheduleId, { end_behavior: 'release', phases, proration_behavior: 'none' }, { idempotencyKey }
    );
    return { ok: true, before, after, stripeIds: { subscriptionId, scheduleId } };
  });
}

// "Cancelar ao fim do período" (plan §5, the default): sem schedule, Stripe's own
// `cancel_at_period_end`. Com schedule, never release it mid-first-month — the active phase (phase
// 1 if still in the intro period, otherwise the plan's own open-ended phase) becomes the
// schedule's last, bounded to `current_period_end` if it had no end of its own, `end_behavior:
// cancel` — access runs out exactly where it was already paid for, never one quiet extra cycle.
export async function cancelAtPeriodEnd(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.cancel-at-period-end', reason, request: { subscriptionId }
  }, async (sub, stripe) => {
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const scheduleId = scheduleIdOf(before);
    if (!scheduleId) {
      const after = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, { idempotencyKey });
      return { ok: true, before, after, stripeIds: { subscriptionId } };
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const periodEnd = before.current_period_end ?? before.items?.data?.[0]?.current_period_end;
    // The phase actually in effect right now — never just "the last one": this schedule can
    // still be two phases long after the first month (see activePhaseIndex's own comment).
    // Everything before it is already-elapsed history and is kept untouched; the active phase
    // itself is bounded to current_period_end if it had no end date of its own (the plan's own
    // open-ended phase never does); anything after it (a future phase, mid-first-month) is
    // dropped — "não soltar o schedule no meio do 1º mês" means never losing the still-in-effect
    // phase's own price, not keeping a phase that was never going to be charged.
    const activeIdx = activePhaseIndex(schedule, Math.floor(Date.now() / 1000));
    const activePhase = schedule.phases[activeIdx];
    const phases = schedule.phases.slice(0, activeIdx)
      .map(p => ({ items: p.items.map(i => ({ price: i.price })), start_date: p.start_date, end_date: p.end_date }));
    phases.push({
      items: activePhase.items.map(i => ({ price: i.price })),
      start_date: activePhase.start_date,
      end_date: activePhase.end_date ?? periodEnd
    });
    const after = await stripe.subscriptionSchedules.update(
      scheduleId, { end_behavior: 'cancel', phases, proration_behavior: 'none' }, { idempotencyKey }
    );
    return { ok: true, before, after, stripeIds: { subscriptionId, scheduleId } };
  });
}

// "Retomar cancelamento" (plan §5): the exact reverse. Sem schedule, `cancel_at_period_end: false`.
// Com schedule, restores an open-ended final phase at whatever plan this account is actually
// slated for (`sub.plan` — set at Checkout, never invented here) at that plan's *current* Price,
// `end_behavior: release` — the same shape changePlan's own "sem schedule" branch builds, because
// cancelAtPeriodEnd above always leaves the schedule with exactly one phase behind.
export async function resumeCancellation(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.resume', reason, request: { subscriptionId }
  }, async (sub, stripe) => {
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const scheduleId = scheduleIdOf(before);
    if (!scheduleId) {
      const after = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false }, { idempotencyKey });
      return { ok: true, before, after, stripeIds: { subscriptionId } };
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const lastPhase = lastPhaseOf(schedule);
    const basePhases = schedule.phases.map(p => ({ items: p.items.map(i => ({ price: i.price })), start_date: p.start_date, end_date: p.end_date }));
    const plan = await getCatalogPlan(pool, sub.plan);
    const targetPriceId = plan?.currentPriceId || lastPhase.items[0].price;
    let phases;
    if (await isIntroPrice(pool, lastPhase.items[0].price)) {
      // cancelAtPeriodEnd was called mid-first-month: the intro phase was never modified (its own
      // end_date was already set), so it is kept exactly as is, and the plan's own phase — the
      // one cancelling had dropped — is appended back, open-ended, starting the moment the intro
      // phase ends.
      phases = [...basePhases, { items: [{ price: targetPriceId }], start_date: lastPhase.end_date }];
    } else {
      // cancelAtPeriodEnd was called once already on the plan's own (indefinite) phase: only the
      // end_date it added needs removing — same phase, same price, same start_date.
      phases = [...basePhases.slice(0, -1), { items: lastPhase.items.map(i => ({ price: i.price })), start_date: lastPhase.start_date }];
    }
    const after = await stripe.subscriptionSchedules.update(
      scheduleId, { end_behavior: 'release', phases, proration_behavior: 'none' }, { idempotencyKey }
    );
    return { ok: true, before, after, stripeIds: { subscriptionId, scheduleId } };
  });
}

// "Cancelar imediatamente" (plan §5): no refund through the app (D-A3, still open — the Dashboard
// is the only place one happens for now). Com schedule, `subscriptionSchedules.cancel` ends the
// schedule and the subscription it drives in one call — calling `subscriptions.cancel` next would
// hit a subscription Stripe already considers canceled, same reasoning as cleanupStripeCustomer's
// own comment above.
export async function cancelImmediately(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.cancel-immediately', reason, request: { subscriptionId }
  }, async (sub, stripe) => {
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const scheduleId = scheduleIdOf(before);
    const after = scheduleId
      ? await stripe.subscriptionSchedules.cancel(scheduleId, {}, { idempotencyKey })
      : await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false }, { idempotencyKey });
    return { ok: true, before, after, stripeIds: { subscriptionId, ...(scheduleId ? { scheduleId } : {}) } };
  });
}

// "Suspender cobrança" (plan §5, ISO-1625 T2b): `pause_collection: { behavior: 'void' }` — Stripe
// simply stops generating invoices; it never cancels anything and never touches a schedule, so
// unlike every action above there is no "sem schedule"/"com schedule" split here at all.
// `resumesAt` (optional, unix seconds) is Stripe's own auto-resume date; omitted, the pause is
// indefinite until "retomar cobrança" below. The webhook's own fetch-latest convergence (not this
// route) is what actually persists `pauseCollection` into the DB mirror the 402 gate reads —
// consistent with every other action here never writing desired state directly.
export async function suspendCollection(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey, resumesAt }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.suspend-collection', reason, request: { subscriptionId, resumesAt: resumesAt ?? null }
  }, async (sub, stripe) => {
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const after = await stripe.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: 'void', ...(resumesAt ? { resumes_at: resumesAt } : {}) }
    }, { idempotencyKey });
    return { ok: true, before, after, stripeIds: { subscriptionId } };
  });
}

// "Retomar cobrança" (plan §5): the exact reverse — `pause_collection: ''` clears it outright
// (never a partial/`resumes_at`-only update), billing resumes on whatever Stripe already has
// scheduled next. Distinct from "resumeCancellation" above: this undoes a suspension, not a
// cancel_at_period_end.
export async function resumeCollection(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.resume-collection', reason, request: { subscriptionId }
  }, async (sub, stripe) => {
    const before = await stripe.subscriptions.retrieve(subscriptionId);
    const after = await stripe.subscriptions.update(subscriptionId, { pause_collection: '' }, { idempotencyKey });
    return { ok: true, before, after, stripeIds: { subscriptionId } };
  });
}

// "Gerar link de assinatura" ("atribuir", plan §5): the exact Checkout createCheckoutSession
// already builds for a self-serve signup, `metadata.source=admin_link` folded in — the once-per-
// account first-month rule applies identically either way. No subscription exists yet to lock on,
// so this locks on the account instead (two admins generating a link for the same user at once
// still serialize, same as every other action).
export async function generateSubscriptionLink(pool, { userId, planId, actor, reason, idempotencyKey, successUrl, cancelUrl }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, lockKey: `billing-link:${userId}`,
    action: 'subscription.generate-link', reason, request: { userId, planId }
  }, async () => {
    const user = await getUserById(pool, userId);
    if (!user) return { error: 'no such user', code: 'not-found' };
    const result = await createCheckoutSession(pool, user, planId, {
      successUrl, cancelUrl, extraMetadata: { source: 'admin_link' }, idempotencyKey
    });
    if (result.error) return { error: result.error, code: result.code || 'invalid-plan' };
    return { ok: true, after: { url: result.url }, stripeIds: {} };
  });
}

// "Sincronizar com a Stripe" (plan §5): the same retrieve-and-map reconcileSubscriptionFromStripe
// shares with the automatic post-timeout recovery, just run through the common action infra too —
// for its own entry in the ficha's history and so two syncs (or a sync racing another action on
// the same subscription) serialize the same as everything else. Read-only against Stripe (never a
// write), so unlike every other action here it carries no live gate — same precedent as
// reconcileCatalog.
export async function syncSubscription(pool, { userId, subscriptionId, expectedUpdatedAt, actor, reason, idempotencyKey }) {
  return runSubscriptionAction(pool, {
    idempotencyKey, actor, targetUserId: userId, subscriptionId, expectedUpdatedAt,
    action: 'subscription.sync', reason, request: { subscriptionId }
  }, async (sub, stripe, client) => {
    const { before, after } = await reconcileSubscriptionFromStripe(client, subscriptionId);
    return { ok: true, before, after, stripeIds: { subscriptionId } };
  });
}

// "Prévia obrigatória" (plan §5): a plain pass-through of Stripe's own upcoming-invoice math,
// never a locally-computed guess — the UI shows this before the confirm dialog's own call to the
// real action. For a would-be plan change, the hypothetical new Price is included (no proration,
// the same `proration_behavior` the real action itself uses); every other action previews today's
// invoice as Stripe already sees it, since none of the others change what the *next* invoice is
// priced at (they change *whether* there is one, or *when* the price changes next).
export async function previewSubscriptionAction(pool, { subscriptionId, action, newPlanId }) {
  const sub = await getSubscriptionById(pool, subscriptionId);
  if (!sub) return { error: 'no such subscription', code: 'not-found' };
  const stripe = getStripe();
  const params = { subscription: subscriptionId };
  if (action === 'change-plan') {
    const plan = await getCatalogPlan(pool, newPlanId);
    if (!plan?.currentPriceId) return { error: 'no such plan, or it has no current price', code: 'invalid-plan' };
    const live = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = live.items?.data?.[0]?.id;
    params.subscription_details = { items: [{ id: itemId, price: plan.currentPriceId }], proration_behavior: 'none' };
  }
  const invoice = await stripe.invoices.createPreview(params);
  return { ok: true, amountDueCents: invoice.amount_due, currency: invoice.currency, nextPaymentAttempt: toIso(invoice.next_payment_attempt) };
}

// What each action needs to be offered at all, from the DB row alone plus the live schedule/
// pauseCollection the ficha route already fetched for the account's current subscription — the UI
// decides what to *show*, this only decides what is safe to *offer*, with a reason attached to
// anything it refuses. `schedule` is null for a plain (non-schedule) subscription or when there is
// none at all. Every check here is against `latest.status` (`WRITABLE_STATUSES`), never `canWrite`
// — suspending collection is its own, independent axis (ISO-1625 T2b), not a second status, so a
// paused account still offers changePlan/cancel the same as an unpaused one; only
// suspendCollection/resumeCollection themselves branch on `pauseCollection`.
function describeAvailableActions(latest, schedule, pauseCollection) {
  const no = (why) => ({ enabled: false, reason: why });
  const yes = { enabled: true };
  if (!latest) {
    const none = no('no subscription yet');
    return {
      changePlan: none, cancelAtPeriodEnd: none, resumeCancellation: none, cancelImmediately: none,
      generateLink: yes, sync: no('no subscription yet'), suspendCollection: none, resumeCollection: none
    };
  }
  const statusWritable = WRITABLE_STATUSES.has(latest.status);
  const cancelling = schedule ? schedule.end_behavior === 'cancel' : !!latest.cancelAtPeriodEnd;
  const paused = !!pauseCollection;
  return {
    changePlan: statusWritable ? yes : no('subscription is not active'),
    cancelAtPeriodEnd: statusWritable && !cancelling ? yes : no(!statusWritable ? 'subscription is not active' : 'already set to cancel'),
    resumeCancellation: statusWritable && cancelling ? yes : no('not currently set to cancel'),
    cancelImmediately: statusWritable ? yes : no('subscription is not active'),
    generateLink: yes,
    sync: yes,
    suspendCollection: statusWritable && !paused ? yes : no(!statusWritable ? 'subscription is not active' : 'already suspended'),
    resumeCollection: statusWritable && paused ? yes : no('not currently suspended')
  };
}

// GET /api/admin/user/billing?id= (plan §5): every row this account has ever had, each priced off
// `billing_prices` (so a legacy, now-retired Price still shows what it was sold at — plan
// principle #2), the live schedule for whichever row is still writable, and which of the six
// actions above make sense from here.
export async function getUserBillingFicha(pool, userId) {
  const rows = await getSubscriptionsForUser(pool, userId);
  const latest = rows[0] || null;
  const stripe = getStripe();
  let liveSchedule = null;
  let livePauseCollection = null;
  const subscriptions = await Promise.all(rows.map(async row => {
    const price = row.priceId ? await getPriceById(pool, row.priceId) : null;
    const plan = price?.planId ? await getCatalogPlan(pool, price.planId) : (row.plan ? await getCatalogPlan(pool, row.plan) : null);
    let schedule = null;
    // ISO-1626 (D): `pauseCollection` is exposed exactly as Stripe reports it — this account's
    // `status` stays `active` while paused (there is no synthetic `paused` status in this app,
    // on purpose), so the raw field is the only way the ficha can tell a suspended account apart
    // from one that is genuinely billing normally.
    let pauseCollection = null;
    // ISO-1625 (T2b): status alone (`WRITABLE_STATUSES`), never `canWrite` — canWrite now also
    // folds in `pauseCollection` itself (so the 402 gate refuses a suspended account), and that
    // field is exactly what this block exists to go live-check. Gating on canWrite here would mean
    // the one row actually paused stops being checked the moment its own pauseCollection is first
    // mirrored into the DB, freezing the ficha on a stale "paused" view forever instead of
    // reflecting a resume.
    if (row === latest && WRITABLE_STATUSES.has(row.status)) {
      try {
        const live = await stripe.subscriptions.retrieve(row.id);
        pauseCollection = live.pause_collection || null;
        const scheduleId = scheduleIdOf(live);
        if (scheduleId) schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      } catch (e) { console.error('billing: live retrieve failed for', row.id, e.message); }
      liveSchedule = schedule;
      livePauseCollection = pauseCollection;
    }
    const scheduledPriceId = schedule ? lastPhaseOf(schedule).items[0].price : null;
    const cancelling = schedule ? schedule.end_behavior === 'cancel' : !!row.cancelAtPeriodEnd;
    const nextChargeDate = cancelling ? null : (schedule ? toIso(lastPhaseOf(schedule).start_date) : row.currentPeriodEnd);
    const nextPrice = !cancelling && scheduledPriceId && scheduledPriceId !== row.priceId ? await getPriceById(pool, scheduledPriceId) : price;
    return {
      id: row.id, userId: row.userId, status: row.status, plan: plan?.id || row.plan || null,
      planDisplay: plan?.display || null, priceId: row.priceId, priceAmountCents: price?.unitAmount ?? row.priceAmount ?? null,
      priceState: price?.state || null, firstPeriod: !!row.firstPeriod, customerId: row.customerId || null,
      // `row.origin` is only set going forward (subscriptionWriteFields, added alongside this
      // ficha) — a row written before that change has never had a value for it, so it defaults to
      // 'self' rather than showing as unknown.
      origin: row.origin || 'self',
      cancelAtPeriodEnd: cancelling, currentPeriodEnd: row.currentPeriodEnd, createdAt: row.createdAt, updatedAt: row.updatedAt,
      firstFullCharge: row.firstFullCharge || null, lastInvoiceStatus: row.lastInvoiceStatus || null,
      schedule: schedule ? { id: schedule.id, endBehavior: schedule.end_behavior, phases: schedule.phases } : null,
      scheduledPriceId, pauseCollection,
      // ISO-1625 (T2b): the other live subscription's id, when the webhook has marked this one a
      // duplicate (plan §5.3) — surfaced so an admin can see it and decide manually; this app never
      // refunds on its own.
      duplicateOf: row.duplicateOf || null,
      nextCharge: cancelling ? null : { date: nextChargeDate, amountCents: nextPrice?.unitAmount ?? null }
    };
  }));
  const history = await listBillingAdminActionsForUser(pool, userId, 50);
  return {
    subscriptions, history, actions: describeAvailableActions(latest, liveSchedule, livePauseCollection),
    liveWritesDisabled: liveWritesDisabled()
  };
}
