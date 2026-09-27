CREATE TABLE checkout_intents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  -- Session rows are intentionally not referenced: normal session expiry removes them,
  -- while checkout intent history must remain available for reconciliation.
  session_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cart_snapshot JSONB NOT NULL CHECK (jsonb_typeof(cart_snapshot) = 'array'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  coupon_code TEXT,
  shipping_input JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(shipping_input) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'payment_pending', 'completed', 'failed', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_checkout_intents_session_created ON checkout_intents(session_id, created_at DESC);
CREATE INDEX idx_checkout_intents_user_created ON checkout_intents(user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE TABLE provider_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checkout_intent_id BIGINT NOT NULL REFERENCES checkout_intents(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  provider_order_id TEXT NOT NULL,
  provider_receipt TEXT,
  expected_amount_minor BIGINT NOT NULL CHECK (expected_amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_order_id),
  UNIQUE (id, checkout_intent_id, provider)
);
CREATE INDEX idx_provider_orders_intent_created ON provider_orders(checkout_intent_id, created_at DESC);

CREATE TABLE payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checkout_intent_id BIGINT NOT NULL REFERENCES checkout_intents(id) ON DELETE RESTRICT,
  provider_order_record_id BIGINT NOT NULL,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  provider_payment_id TEXT NOT NULL,
  expected_amount_minor BIGINT NOT NULL CHECK (expected_amount_minor >= 0),
  verified_amount_minor BIGINT CHECK (verified_amount_minor IS NULL OR verified_amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded')),
  provider_reference TEXT,
  verified_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_payment_id),
  UNIQUE (id, checkout_intent_id),
  FOREIGN KEY (provider_order_record_id, checkout_intent_id, provider)
    REFERENCES provider_orders(id, checkout_intent_id, provider) ON DELETE RESTRICT
);
CREATE INDEX idx_payments_intent_created ON payments(checkout_intent_id, created_at DESC);

CREATE TABLE payment_webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_metadata) = 'object'),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX idx_payment_webhooks_processing ON payment_webhook_events(processing_status, received_at);
CREATE INDEX idx_payment_webhooks_provider_order ON payment_webhook_events(provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE INDEX idx_payment_webhooks_provider_payment ON payment_webhook_events(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

CREATE TABLE refunds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_record_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  provider_refund_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason TEXT,
  provider_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_refund_id)
);
CREATE INDEX idx_refunds_order_created ON refunds(order_id, created_at DESC);
CREATE INDEX idx_refunds_payment_created ON refunds(payment_record_id, created_at DESC);

ALTER TABLE orders
  ADD COLUMN checkout_intent_id BIGINT REFERENCES checkout_intents(id) ON DELETE RESTRICT,
  ADD COLUMN payment_record_id BIGINT REFERENCES payments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT orders_payment_requires_intent CHECK (payment_record_id IS NULL OR checkout_intent_id IS NOT NULL),
  ADD CONSTRAINT orders_payment_matches_intent FOREIGN KEY (payment_record_id, checkout_intent_id)
    REFERENCES payments(id, checkout_intent_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX idx_orders_checkout_intent_unique ON orders(checkout_intent_id) WHERE checkout_intent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_orders_payment_record_unique ON orders(payment_record_id) WHERE payment_record_id IS NOT NULL;
