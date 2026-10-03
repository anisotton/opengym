-- ISO-1447 (Phase 4, LGPD): account deletion must never leave Stripe half-cleaned. deleteAccount
-- (server.js) inserts one row here in the SAME transaction that deletes the user row, so the two
-- commit or roll back together — a Stripe outage can never leave the local delete half-done. No
-- personal data: only Stripe-side ids (a customer, and whichever of its subscriptions were still
-- live), never the account id, name or e-mail — the row has to make sense on its own long after
-- the user row it came from is gone. Processed and removed once billing.js's cleanup confirms both
-- the subscriptions and the customer are gone on Stripe's side; `next_attempt_at` is a plain
-- exponential backoff (billing.js) so a prolonged Stripe outage doesn't hammer their API every tick.
CREATE TABLE stripe_cleanup (
  id               bigserial PRIMARY KEY,
  customer_id      text NOT NULL,
  subscription_ids text[] NOT NULL DEFAULT '{}',
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_cleanup_next_attempt_idx ON stripe_cleanup(next_attempt_at);
