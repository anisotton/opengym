-- Phase 3 (ISO-1393): links a user to its Stripe customer. `subscriptions` and `stripe_events`
-- already exist, empty, from migrations/001_init.sql — this is the one column Phase 3 actually
-- needs added to an existing table. One customer per account (created lazily, on that account's
-- first POST /api/billing/checkout) and one account per customer, hence UNIQUE both ways: a
-- second checkout for the same account reuses the row instead of asking Stripe for a new customer,
-- and billing.js's webhook handlers can always find the owning account from `event.data.object.customer`
-- alone, without relying on `metadata.userId` surviving every event type Stripe sends.
ALTER TABLE users ADD COLUMN stripe_customer_id text UNIQUE;
