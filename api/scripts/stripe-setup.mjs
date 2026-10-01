#!/usr/bin/env node
/* Reproducible Product + Price setup for Stripe billing (ISO-1393) — run once against the
 * sandbox, and again against live when it's time to launch, with the same command.
 *
 * Usage: STRIPE_API_KEY=rk_... node scripts/stripe-setup.mjs [--dry-run]
 *
 * Creates one Product ("Brilhart Fitness — Individual") and four Prices on it: the three plans
 * (STRIPE_PRICE_MONTHLY/QUARTERLY/YEARLY) and the once-per-account R$1,99 first month
 * (STRIPE_PRICE_INTRO), all in BRL, all in whole centavos (never a float — see the issue's own
 * rule on this). Idempotent: reruns reuse the Product by its own metadata marker and skip a Price
 * that already exists for the same (product, unit_amount, interval) combination rather than
 * minting a duplicate, so this is safe to run again after an interrupted first attempt, or against
 * the same sandbox twice.
 *
 * Prints the four STRIPE_PRICE_* lines to copy into .env at the end. `--dry-run` prints what it
 * would create without calling Stripe at all.
 */
import Stripe from 'stripe';

const DRY_RUN = process.argv.includes('--dry-run');
const PRODUCT_NAME = 'Brilhart Fitness — Individual';
const PRODUCT_MARKER = 'brilhart-fitness-individual'; // metadata.slug, this script's own idempotency key

const PLANS = [
  { env: 'STRIPE_PRICE_MONTHLY', nickname: 'Mensal', unit_amount: 8900, recurring: { interval: 'month', interval_count: 1 } },
  { env: 'STRIPE_PRICE_QUARTERLY', nickname: 'Trimestral', unit_amount: 23700, recurring: { interval: 'month', interval_count: 3 } },
  { env: 'STRIPE_PRICE_YEARLY', nickname: 'Anual', unit_amount: 76800, recurring: { interval: 'year', interval_count: 1 } },
  // One-time, not recurring: added as a second Checkout line item only on an account's first-ever
  // subscription (api/billing.js's createCheckoutSession) — see the issue for why a one-time Price
  // rather than a second recurring one at a different amount.
  { env: 'STRIPE_PRICE_INTRO', nickname: 'Primeiro mês', unit_amount: 199, recurring: null }
];

if (DRY_RUN) {
  console.log(`[dry-run] would ensure product "${PRODUCT_NAME}" (metadata.slug=${PRODUCT_MARKER})`);
  for (const p of PLANS) {
    const cadence = p.recurring ? `${p.recurring.interval} ×${p.recurring.interval_count}` : 'one-time';
    console.log(`[dry-run] would ensure price ${p.nickname}: ${p.unit_amount} BRL centavos, ${cadence} → ${p.env}`);
  }
  process.exit(0);
}

if (!process.env.STRIPE_API_KEY) {
  console.error('STRIPE_API_KEY is required (a restricted key, rk_... — see docs/SELF_HOSTING.md)');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_API_KEY, { apiVersion: '2026-08-26.dahlia' });

async function ensureProduct() {
  const existing = await stripe.products.search({ query: `metadata['slug']:'${PRODUCT_MARKER}' AND active:'true'` });
  if (existing.data.length) {
    console.log(`→ reusing product ${existing.data[0].id} ("${existing.data[0].name}")`);
    return existing.data[0];
  }
  const product = await stripe.products.create({ name: PRODUCT_NAME, metadata: { slug: PRODUCT_MARKER } });
  console.log(`→ created product ${product.id}`);
  return product;
}

async function ensurePrice(product, plan) {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = prices.data.find(p =>
    p.unit_amount === plan.unit_amount &&
    p.currency === 'brl' &&
    (plan.recurring ? p.recurring?.interval === plan.recurring.interval && p.recurring?.interval_count === plan.recurring.interval_count : !p.recurring)
  );
  if (match) {
    console.log(`→ reusing price ${match.id} for ${plan.nickname}`);
    return match;
  }
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'brl',
    unit_amount: plan.unit_amount,
    nickname: plan.nickname,
    ...(plan.recurring ? { recurring: plan.recurring } : {})
  });
  console.log(`→ created price ${price.id} for ${plan.nickname}`);
  return price;
}

const product = await ensureProduct();
const envLines = [];
for (const plan of PLANS) {
  const price = await ensurePrice(product, plan);
  envLines.push(`${plan.env}=${price.id}`);
}

console.log('\nAdd to .env:\n');
console.log(envLines.join('\n'));
