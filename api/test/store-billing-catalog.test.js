/* The billing-catalog half of store.js plus billing.js's seedCatalogFromEnv/planFromPrice/
 * nextChargeAmountCents (ISO-1623), tested directly against real PostgreSQL and a local Stripe
 * Price mock — no server.js spawned. server-billing-catalog.test.js covers the HTTP surface
 * (GET /api/billing/plans, the Checkout gates) this file can't see as directly: the seed's own
 * validation rules, the immutable-Price trigger, and the catalog-vs-env fallback.
 *
 * One mock Stripe server for the whole file: billing.js's getStripe() caches its client the first
 * time anything calls it (its own comment explains why), so every test here has to share the same
 * STRIPE_API_HOST/PORT — fixtures are told apart by a fresh random Price id per test, not by a
 * fresh port. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { provisionTestDatabase } from './helpers.mjs';
import { connectAndMigrate } from '../db.js';
import { getAvailablePlans, getPriceById, isBillingCatalogSeeded } from '../store.js';

const PRICES = new Map();
function registerPrice(fields) {
  const id = `price_${crypto.randomBytes(6).toString('hex')}`;
  PRICES.set(id, { id, object: 'price', ...fields });
  return id;
}

const mockServer = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.split('/').pop());
  const price = PRICES.get(id);
  res.writeHead(price ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(price || { error: { message: 'No such price' } }));
});
const port = await new Promise(resolve => mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port)));
test.after(() => mockServer.close());

process.env.STRIPE_API_KEY = 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_unused';
process.env.STRIPE_API_HOST = '127.0.0.1';
process.env.STRIPE_API_PORT = String(port);
const { seedCatalogFromEnv, planFromPrice, nextChargeAmountCents } = await import('../billing.js');

async function withPool(t) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const { pool } = await connectAndMigrate(databaseUrl);
  t.after(() => pool.end());
  t.after(cleanup);
  return pool;
}

function setPlanEnv({ monthly, quarterly, yearly, intro }) {
  process.env.STRIPE_PRICE_MONTHLY = monthly;
  process.env.STRIPE_PRICE_QUARTERLY = quarterly;
  process.env.STRIPE_PRICE_YEARLY = yearly;
  process.env.STRIPE_PRICE_INTRO = intro;
}

function validEnvIds() {
  return {
    monthly: registerPrice({ unit_amount: 8900, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1' }),
    quarterly: registerPrice({ unit_amount: 23700, currency: 'brl', recurring: { interval: 'month', interval_count: 3 }, livemode: false, product: 'prod_1' }),
    yearly: registerPrice({ unit_amount: 76800, currency: 'brl', recurring: { interval: 'year', interval_count: 1 }, livemode: false, product: 'prod_1' }),
    intro: registerPrice({ unit_amount: 199, currency: 'brl', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1' })
  };
}

test('seedCatalogFromEnv: seeds monthly/quarterly/yearly in order, each current, plus the shared intro', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  setPlanEnv(ids);
  await seedCatalogFromEnv(pool);
  const plans = await getAvailablePlans(pool);
  assert.deepEqual(plans.map(p => p.id), ['monthly', 'quarterly', 'yearly']);
  assert.equal(plans[0].amountCents, 8900);
  assert.equal(plans[0].introAmountCents, 199);
  assert.equal((await getPriceById(pool, ids.monthly)).state, 'current');
});

test('seedCatalogFromEnv: a second boot (catalog already seeded) is a no-op', async t => {
  const pool = await withPool(t);
  setPlanEnv(validEnvIds());
  await seedCatalogFromEnv(pool);
  const before = await getAvailablePlans(pool);
  await seedCatalogFromEnv(pool);
  assert.deepEqual(await getAvailablePlans(pool), before, '2 boots produced the exact same catalog');
});

test('seedCatalogFromEnv: a non-BRL Price aborts the whole seed, nothing is written', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  const usdMonthly = registerPrice({ unit_amount: 8900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, livemode: false, product: 'prod_1' });
  setPlanEnv({ ...ids, monthly: usdMonthly });
  await seedCatalogFromEnv(pool);
  assert.equal(await isBillingCatalogSeeded(pool), false);
});

test('seedCatalogFromEnv: an unexpected interval aborts the whole seed', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  const weeklyYearly = registerPrice({ unit_amount: 76800, currency: 'brl', recurring: { interval: 'week', interval_count: 1 }, livemode: false, product: 'prod_1' });
  setPlanEnv({ ...ids, yearly: weeklyYearly });
  await seedCatalogFromEnv(pool);
  assert.equal(await isBillingCatalogSeeded(pool), false);
});

test('seedCatalogFromEnv: a missing env var skips the seed instead of throwing', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  setPlanEnv({ ...ids, intro: '' });
  delete process.env.STRIPE_PRICE_INTRO;
  await seedCatalogFromEnv(pool);
  assert.equal(await isBillingCatalogSeeded(pool), false);
});

test('billing_prices: unit_amount cannot be UPDATEd — the immutability trigger rejects it', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  setPlanEnv(ids);
  await seedCatalogFromEnv(pool);
  await assert.rejects(
    () => pool.query('UPDATE billing_prices SET unit_amount = 1 WHERE id = $1', [ids.monthly]),
    /immutable/
  );
  // The lifecycle columns stay editable — that's the whole point of the trigger's own allow-list.
  await pool.query("UPDATE billing_prices SET state = 'retired', retired_at = now() WHERE id = $1", [ids.monthly]);
  assert.equal((await getPriceById(pool, ids.monthly)).state, 'retired');
});

test('planFromPrice: reads the catalog once seeded, falls back to the env before that — and after a Price retires', async t => {
  const pool = await withPool(t);
  const ids = validEnvIds();
  setPlanEnv(ids);
  assert.equal(await planFromPrice(pool, ids.monthly), 'monthly', 'not seeded yet — the env fallback already knows it');
  await seedCatalogFromEnv(pool);
  assert.equal(await planFromPrice(pool, ids.monthly), 'monthly', 'now read from the catalog');
  await pool.query("UPDATE billing_prices SET state = 'retired', retired_at = now() WHERE id = $1", [ids.monthly]);
  assert.equal(await planFromPrice(pool, ids.monthly), 'monthly', 'a retired Price still names its plan');
});

test('nextChargeAmountCents: during a first period it is the plan\'s current catalog price, not the intro Price already on the item', async t => {
  const pool = await withPool(t);
  setPlanEnv(validEnvIds());
  await seedCatalogFromEnv(pool);
  assert.equal(await nextChargeAmountCents(pool, { firstPeriod: true, plan: 'monthly' }), 8900);
  assert.equal(await nextChargeAmountCents(pool, { firstPeriod: false, plan: 'monthly', priceAmount: 199 }), 199, 'past the first period, the subscription\'s own item amount wins');
});
