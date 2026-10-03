/* Stripe billing (ISO-1393, contract fixed by ISO-1392): webhook signature/idempotency, status
   transitions, and the 402 write gate. Real server.js in a child, real PostgreSQL. STRIPE_API_KEY
   only needs to look like a key; nothing in this file calls out to api.stripe.com — the one test
   that exercises convertToSchedule's own network call (below) points billing.js's Stripe client at
   a local mock instead (STRIPE_API_HOST/STRIPE_API_PORT, billing.js's getStripe()), rather than
   skipping that call entirely.

   Event fixtures below use the account's actual pinned API version shape (2026-08-26.dahlia,
   Stripe's "flexible billing" object layout) by default — `current_period_end` under
   `items.data[0]`, not at the subscription's root, and an invoice's subscription id under
   `parent.subscription_details.subscription`, not at the invoice's root. Sentinel's sandbox
   findings were exactly this: the old tests built events in the pre-dahlia flat shape by hand, so
   they could never have caught billing.js reading fields that moved. Dedicated fallback tests
   below cover the flat shape too, since applyStripeEvent still reads it as a secondary source. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Stripe from 'stripe';
import { tempData, spawnApi } from './helpers.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');
const WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(8).toString('hex');
const stripeTestClient = new Stripe('sk_test_unused', { apiVersion: '2026-08-26.dahlia' });

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });

const INTRO_PRICE = 'price_intro_test';
const MONTHLY_PRICE = 'price_monthly_test';

async function startServer(t, { users, env = {} } = {}) {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  return spawnApi(t, {
    dataDir,
    env: {
      STRIPE_API_KEY: 'sk_test_unused',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      STRIPE_PRICE_INTRO: INTRO_PRICE,
      ...env
    }
  });
}

// A local stand-in for api.stripe.com, for the one test that needs convertToSchedule's own
// subscriptionSchedules.create/update calls to actually go somewhere and be inspected — the real
// request is what proves the fix (`end_date`, not the rejected `iterations`), not just a reading
// of the source. billing.js's getStripe() points at this host via STRIPE_API_HOST/STRIPE_API_PORT
// (test-only seam), never set outside this file.
function mockStripeApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'sched_test_1',
        object: 'subscription_schedule',
        phases: [{ start_date: 1700000000, end_date: 1702678400, items: [{ price: INTRO_PRICE, quantity: 1 }] }]
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls })));
}

function stripeEvent(type, object) {
  return { id: 'evt_' + crypto.randomBytes(12).toString('hex'), type, data: { object } };
}

async function postWebhook(api, event) {
  const payload = JSON.stringify(event);
  const sig = stripeTestClient.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${api}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
    body: payload
  });
  return { status: r.status, body: await r.json() };
}

// `priceId` defaults to the full monthly price — a returning-subscriber or already-converted
// shape. Pass `priceId: INTRO_PRICE` to simulate still being in the first (R$1,99) period.
// `current_period_end` lives under the item (dahlia shape), not at the subscription's root — see
// the fallback test below for the pre-dahlia root-level shape applyStripeEvent also still reads.
const sub = (id, overrides) => ({
  id, object: 'subscription', status: 'active', customer: 'cus_1',
  items: {
    data: [{
      price: { id: MONTHLY_PRICE, unit_amount: 8900 },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400
    }]
  },
  cancel_at_period_end: false,
  metadata: { userId: 'u_bill_1', plan: 'monthly' },
  ...overrides
});

// Dahlia-shape invoice: the subscription id lives under parent.subscription_details, and a line's
// price is a bare id under pricing.price_details.price — neither lives where the invoice's root
// (`subscription`) or an old-shape line (`price.id`, an object) used to carry it. See the fallback
// tests below for both pre-dahlia root-level shapes.
const invoice = (id, subId, overrides) => ({
  id, object: 'invoice', customer: 'cus_1',
  parent: { subscription_details: { subscription: subId } },
  lines: { data: [{ pricing: { price_details: { price: MONTHLY_PRICE } } }] },
  amount_paid: 8900, currency: 'brl', created: Math.floor(Date.now() / 1000),
  ...overrides
});

test('POST /api/billing/webhook: wrong signature is refused, never applied', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.created', sub('sub_bad_sig'));
  const r = await fetch(`${h.api}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=deadbeef' },
    body: JSON.stringify(event)
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid signature');

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());
  assert.equal(status.status, 'none', 'a refused signature never reaches applyStripeEvent');
});

test('POST /api/billing/webhook: a repeated event id is acknowledged once and applied once', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.created', sub('sub_dupe'));

  const first = await postWebhook(h.api, event);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);

  const second = await postWebhook(h.api, event); // byte-identical redelivery, same event.id
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.plan, 'monthly');
});

test('POST /api/billing/webhook: a failed apply un-claims the event, so a Stripe retry gets a real second attempt', async t => {
  // Sentinel's finding on the first version of this fix: claimStripeEvent landing is not the same
  // as applyStripeEvent's effect actually having happened — the schedule conversion in particular
  // calls out to Stripe itself and can fail for reasons that have nothing to do with our data. This
  // reproduces that class of failure without needing a real network call: `id: null` makes
  // upsertSubscription's INSERT violate subscriptions.id's NOT NULL constraint, which is enough to
  // prove the general mechanism (server.js unclaims on ANY throw from applyStripeEvent, not only a
  // Stripe-specific one).
  const users = [{ id: 'u_bill_4', name: 'Four', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const event = stripeEvent('customer.subscription.updated', sub(null, { metadata: { userId: 'u_bill_4', plan: 'monthly' } }));

  const first = await postWebhook(h.api, event);
  assert.equal(first.status, 500, 'applying the event failed');

  // If the claim had survived that failure, this exact event.id would now read back as a no-op
  // duplicate instead of being retried — it isn't, which is the whole point of unclaiming.
  const second = await postWebhook(h.api, event);
  assert.equal(second.status, 500, 'retried, not silently skipped as already-handled');

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_4') }).then(r => r.json());
  assert.equal(status.status, 'none', 'nothing was ever actually committed');
});

test('POST /api/billing/webhook: subscription status transitions reach GET /api/billing/status', async t => {
  const users = [{ id: 'u_bill_1', name: 'One', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const status = async () => fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_1') }).then(r => r.json());

  // First period: active from the first invoice, not a Stripe trial — `firstPeriod` is what tells
  // the UI apart from the ongoing-subscriber case, and `nextChargeAmount` already shows the
  // upcoming FULL plan charge even though the subscription's current item is still the intro price.
  let r = await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_lifecycle', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] }
  })));
  assert.equal(r.status, 200);
  let s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, true);
  assert.equal(s.nextChargeAmount, 8900, 'the upcoming charge is the full monthly price, not R$1.99');

  // The schedule's phase change: the subscription's item is now the chosen plan's price.
  r = await postWebhook(h.api, stripeEvent('customer.subscription.updated', sub('sub_lifecycle')));
  assert.equal(r.status, 200);

  // The first full-price invoice: firstFullCharge is recorded once, keyed off the invoice's own
  // line price rather than billing_reason — robust regardless of event ordering. Subscription id
  // is read from the dahlia shape (parent.subscription_details.subscription) — see `invoice()`.
  r = await postWebhook(h.api, stripeEvent('invoice.paid', invoice('in_1', 'sub_lifecycle')));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'active');
  assert.equal(s.active, true);
  assert.equal(s.firstPeriod, false, 'no longer in the first period once the full invoice landed');
  assert.equal(s.firstFullCharge.amount, 8900);
  assert.equal(s.nextChargeAmount, 8900, 'now read straight off the subscription item, same amount');

  // A failed renewal moves the account to past_due — it still writes (issue rule: Stripe retries
  // before cancelling).
  r = await postWebhook(h.api, stripeEvent('invoice.payment_failed', invoice('in_2', 'sub_lifecycle')));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'past_due');
  assert.equal(s.active, true, 'past_due still writes');

  // The Portal's cancellation, once the period actually ends.
  r = await postWebhook(h.api, stripeEvent('customer.subscription.deleted', sub('sub_lifecycle', { status: 'canceled' })));
  assert.equal(r.status, 200);
  s = await status();
  assert.equal(s.status, 'canceled');
  assert.equal(s.active, false);
});

test('POST /api/billing/webhook: current_period_end falls back to the pre-dahlia root-level field', async t => {
  // Sentinel's bug #2 (ISO-1393 sandbox validation, 2026-10-03): on this account's pinned API
  // version, current_period_end moved off the subscription's root into items.data[0] — the shape
  // every other fixture in this file now uses by default. This test pins down the other half of
  // the fix: an event that still carries the old flat field (a replay from before this account's
  // API version pin, or any instance on an older `stripe` SDK/account default) must keep working.
  const users = [{ id: 'u_bill_6', name: 'Six', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const flatPeriodEnd = Math.floor(Date.now() / 1000) + 45 * 86400;
  const flatSub = {
    id: 'sub_flat', object: 'subscription', status: 'active', customer: 'cus_1',
    items: { data: [{ price: { id: MONTHLY_PRICE, unit_amount: 8900 } }] }, // no items[0].current_period_end
    current_period_end: flatPeriodEnd, // root-level, pre-dahlia
    cancel_at_period_end: false,
    metadata: { userId: 'u_bill_6', plan: 'monthly' }
  };
  const r = await postWebhook(h.api, stripeEvent('customer.subscription.created', flatSub));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_6') }).then(r => r.json());
  assert.equal(status.nextChargeDate, new Date(flatPeriodEnd * 1000).toISOString());
});

test('POST /api/billing/webhook: invoice.paid falls back to the pre-dahlia root-level subscription field', async t => {
  // Sentinel's bug #3: an invoice's subscription id moved to parent.subscription_details.subscription
  // on this account's API version — every other invoice fixture in this file now uses that shape by
  // default (see `invoice()`). This pins down the flat fallback the same way as current_period_end
  // above: without it, invoice.paid/invoice.payment_failed are a silent no-op (subId is undefined).
  const users = [{ id: 'u_bill_7', name: 'Seven', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_flat_inv', { metadata: { userId: 'u_bill_7', plan: 'monthly' } })));

  const flatInvoice = {
    id: 'in_flat', object: 'invoice', customer: 'cus_1', subscription: 'sub_flat_inv', // root-level, pre-dahlia
    lines: { data: [{ price: { id: MONTHLY_PRICE } }] },
    amount_paid: 8900, currency: 'brl', created: Math.floor(Date.now() / 1000)
  };
  const r = await postWebhook(h.api, stripeEvent('invoice.paid', flatInvoice));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_7') }).then(r => r.json());
  assert.equal(status.status, 'active');
  assert.equal(status.active, true, 'invoice.paid was not a silent no-op');
});

test('POST /api/billing/webhook: firstFullCharge is recorded from the dahlia invoice line shape, with a pre-dahlia fallback', async t => {
  // Sentinel's bug #4 (found only after bug #3 was fixed — a real paid full-price invoice in the
  // sandbox never got this far before): an invoice line's price moved from `price.id` (an object)
  // to `pricing.price_details.price` (already a string id). `invoice()`'s default fixture already
  // uses the dahlia shape, so the lifecycle test above covers the primary path — this pins down the
  // pre-dahlia fallback the same way as the other two fields.
  const users = [{ id: 'u_bill_9', name: 'Nine', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_flat_price', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_9', plan: 'monthly' }
  })));

  const flatPriceInvoice = invoice('in_flat_price', 'sub_flat_price', {
    lines: { data: [{ price: { id: MONTHLY_PRICE } }] } // root-level price.id, pre-dahlia
  });
  const r = await postWebhook(h.api, stripeEvent('invoice.paid', flatPriceInvoice));
  assert.equal(r.status, 200);
  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_9') }).then(r => r.json());
  assert.equal(status.firstFullCharge?.amount, 8900, 'firstFullCharge was recorded from the flat line price, not silently skipped');
});

test('customer.subscription.created with scheduleTo: the real schedule update sends end_date, never the rejected iterations param', async t => {
  // Sentinel's bug #1: subscriptionSchedules.update with phases[].iterations fails on this
  // account's API version (400 parameter_unknown). Points billing.js's Stripe client at a local
  // mock (STRIPE_API_HOST/STRIPE_API_PORT) so the exact outgoing request can be inspected, instead
  // of only re-reading the source that changed.
  const { server, port, calls } = await mockStripeApi();
  t.after(() => server.close());
  const users = [{ id: 'u_bill_8', name: 'Eight', created: new Date().toISOString() }];
  const h = await startServer(t, { users, env: { STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(port) } });

  const event = stripeEvent('customer.subscription.created', sub('sub_sched', {
    items: { data: [{ price: { id: INTRO_PRICE, unit_amount: 199 }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    metadata: { userId: 'u_bill_8', plan: 'monthly', scheduleTo: MONTHLY_PRICE }
  }));
  const r = await postWebhook(h.api, event);
  assert.equal(r.status, 200, 'convertToSchedule succeeded against the mock');

  const create = calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules');
  assert.ok(create, 'subscriptionSchedules.create was called');
  const update = calls.find(c => c.method === 'POST' && c.url === '/v1/subscription_schedules/sched_test_1');
  assert.ok(update, 'subscriptionSchedules.update was called');
  assert.match(update.body, /end_date/, 'uses end_date, the version-correct way to say "one more cycle"');
  assert.doesNotMatch(update.body, /iterations/, 'iterations is rejected by this account\'s API version');
});

test('PUT /api/data: 402 without a subscription, 200 once active, 200 while past_due, 402 once canceled', async t => {
  const users = [{ id: 'u_bill_2', name: 'Two', created: new Date().toISOString() }];
  const h = await startServer(t, { users });
  const put = () => fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_2'),
    body: JSON.stringify({ state: { workouts: [{ id: 'w1' }], routines: [] } })
  });

  let r = await put();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).code, 'billing');

  // reading and exporting stay open even with no subscription at all
  const get = await fetch(`${h.api}/api/data`, { headers: headers('u_bill_2') });
  assert.equal(get.status, 200);

  await postWebhook(h.api, stripeEvent('customer.subscription.created', sub('sub_gate', { metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'an active subscription (first period or not) lifts the 402');

  await postWebhook(h.api, stripeEvent('customer.subscription.updated', sub('sub_gate', { status: 'past_due', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 200, 'past_due still writes — Stripe is still retrying');

  await postWebhook(h.api, stripeEvent('customer.subscription.deleted', sub('sub_gate', { status: 'canceled', metadata: { userId: 'u_bill_2', plan: 'monthly' } })));
  r = await put();
  assert.equal(r.status, 402, 'canceled goes back to read-only');
});

test('PUT /api/data: no 402 at all when billing is not configured', async t => {
  const dataDir = tempData();
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const users = [{ id: 'u_bill_3', name: 'Three', created: new Date().toISOString() }];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const h = await spawnApi(t, { dataDir }); // no STRIPE_* env at all
  const r = await fetch(`${h.api}/api/data`, {
    method: 'PUT', headers: headers('u_bill_3'),
    body: JSON.stringify({ state: { workouts: [], routines: [] } })
  });
  assert.equal(r.status, 200);

  const status = await fetch(`${h.api}/api/billing/status`, { headers: headers('u_bill_3') });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false });

  const webhook = await fetch(`${h.api}/api/billing/webhook`, { method: 'POST', body: '{}' });
  assert.equal(webhook.status, 404);
});
