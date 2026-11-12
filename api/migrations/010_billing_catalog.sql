-- ISO-1619/ISO-1623: the payment-plan catalog, mirrored from Stripe instead of hard-coded by env
-- (STRIPE_PRICE_MONTHLY/QUARTERLY/YEARLY/INTRO, api/billing.js). Purely additive — no existing
-- table is touched, and `subscriptions` keeps working unmigrated (plan §6.2). The seed that fills
-- these tables from the current env is a boot-time step in billing.js (seedCatalogFromEnv), not
-- SQL: a sandbox and a live account mint different Stripe ids, so this migration can only create
-- the shape, never the rows.

-- The commercial offer (what an admin edits: presentation, availability, order). `version` is
-- optimistic concurrency, same contract as programs.rev (migrations/007) and user_state.rev —
-- an edit against a stale version loses the compare-and-set instead of overwriting a concurrent
-- one. current_price_id/intro_price_id reference billing_prices, added as a second ALTER below
-- since that table doesn't exist yet at this point in the file.
CREATE TABLE billing_plans (
  id                text PRIMARY KEY,                 -- stable slug: 'monthly' | 'quarterly' | 'yearly' | a later addition
  display           jsonb NOT NULL,                   -- {"pt-BR": {name, description, badge?}, ...}; pt-BR is the app's only locale for now
  interval          text NOT NULL CHECK (interval IN ('month', 'year')),
  interval_count    integer NOT NULL CHECK (interval_count IN (1, 3, 6, 12)),
  sort_order        integer NOT NULL DEFAULT 0,
  available         boolean NOT NULL DEFAULT false,   -- sellable in Checkout and listed in GET /api/billing/plans
  current_price_id  text,
  intro_price_id    text,                             -- NULL = no first-period promo on this plan
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Append-only mirror of Stripe Prices — this *is* the plan's value history. A row is never
-- updated in place for its money fields; only `state`/`published_at`/`retired_at` ever change
-- (enforced by the trigger below), so a subscription billed off a since-retired Price keeps
-- showing the exact name and amount it was sold at, forever. `plan_id` is NULL only for the
-- once-per-account first-period Price, shared across every plan that offers one.
CREATE TABLE billing_prices (
  id                 text PRIMARY KEY,                -- price_... (Stripe's own id)
  plan_id            text REFERENCES billing_plans(id),
  kind               text NOT NULL CHECK (kind IN ('recurring', 'intro')),
  unit_amount        integer NOT NULL CHECK (unit_amount BETWEEN 100 AND 1000000), -- centavos: R$1.00 .. R$10,000.00
  currency           text NOT NULL CHECK (currency = 'brl'),
  interval           text NOT NULL,
  interval_count     integer NOT NULL,
  livemode           boolean NOT NULL,
  stripe_product_id  text NOT NULL,
  state              text NOT NULL CHECK (state IN ('draft', 'current', 'retired')),
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz,
  retired_at         timestamptz,
  decision_ref       text                             -- free-text pointer to whatever approved this value
);
ALTER TABLE billing_plans ADD FOREIGN KEY (current_price_id) REFERENCES billing_prices(id);
ALTER TABLE billing_plans ADD FOREIGN KEY (intro_price_id) REFERENCES billing_prices(id);

-- At most one 'current' recurring Price per plan — the index publishing a new version relies on:
-- the old row flips to 'retired' in the same transaction that gives the new one 'current', so
-- this can never see two at once, not even for an instant. Not constrained for kind='intro':
-- that Price is plan_id NULL and shared, so "one current per plan" doesn't apply to it the same way.
CREATE UNIQUE INDEX billing_prices_one_current_per_plan ON billing_prices (plan_id) WHERE state = 'current' AND kind = 'recurring';
CREATE INDEX billing_prices_plan_idx ON billing_prices (plan_id);

-- Price is immutable: once a row exists, its money/shape columns never change, by trigger rather
-- than by convention — a future bug fix cannot "just" UPDATE a row here without this firing.
-- `state`/`created_by`/`published_at`/`retired_at`/`decision_ref` are exactly the columns a
-- lifecycle transition is allowed to touch; everything else (including `plan_id`) is frozen.
CREATE FUNCTION billing_prices_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.unit_amount IS DISTINCT FROM OLD.unit_amount
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.interval IS DISTINCT FROM OLD.interval
     OR NEW.interval_count IS DISTINCT FROM OLD.interval_count OR NEW.livemode IS DISTINCT FROM OLD.livemode
     OR NEW.stripe_product_id IS DISTINCT FROM OLD.stripe_product_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'billing_prices rows are immutable except for state/published_at/retired_at/decision_ref';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER billing_prices_immutable_trg BEFORE UPDATE ON billing_prices
  FOR EACH ROW EXECUTE FUNCTION billing_prices_immutable();

-- The admin's financial actions (catalog edits from T1 on, subscription actions from T2a/T2b) —
-- idempotency (unique key, generated client-side per confirmation dialog) plus the audit trail
-- an ordinary `data/audit.log` line can't carry: before/after read live from Stripe, the Stripe
-- object ids touched, and a structured status a retry or a timeout can resolve later. No FK on
-- target_user_id would strand a row pointing nowhere once an account is deleted, so it's
-- ON DELETE SET NULL, same precedent as programs.created_by (migrations/007) — the financial
-- record outlives the account it was about.
CREATE TABLE billing_admin_actions (
  id              bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  actor_id        text NOT NULL,
  target_user_id  text REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  reason          text NOT NULL CHECK (length(reason) >= 10),
  request         jsonb NOT NULL,
  before          jsonb,
  after           jsonb,
  stripe_ids      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX billing_admin_actions_target_idx ON billing_admin_actions (target_user_id, created_at DESC);
