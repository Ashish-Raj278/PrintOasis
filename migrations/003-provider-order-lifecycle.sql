ALTER TABLE provider_orders
  ALTER COLUMN provider_order_id DROP NOT NULL,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'created',
  ADD COLUMN provider_amount_minor BIGINT,
  ADD COLUMN provider_currency TEXT,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN claim_token TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN completed_at TIMESTAMPTZ;

UPDATE provider_orders
SET provider_amount_minor = expected_amount_minor,
    provider_currency = currency;

ALTER TABLE provider_orders
  ADD CONSTRAINT provider_orders_status_check
    CHECK (status IN ('creating', 'created', 'failed', 'unknown', 'rejected')),
  ADD CONSTRAINT provider_orders_attempt_count_check
    CHECK (attempt_count > 0),
  ADD CONSTRAINT provider_orders_lifecycle_check
    CHECK (
      (status = 'creating' AND provider_order_id IS NULL AND provider_amount_minor IS NULL
        AND provider_currency IS NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status = 'created' AND provider_order_id IS NOT NULL
        AND provider_amount_minor = expected_amount_minor AND provider_currency = currency
        AND claim_token IS NULL AND lease_expires_at IS NULL)
      OR (status IN ('failed', 'unknown') AND provider_order_id IS NULL
        AND claim_token IS NULL AND lease_expires_at IS NULL)
      OR (status = 'rejected' AND provider_order_id IS NOT NULL
        AND claim_token IS NULL AND lease_expires_at IS NULL)
    );

CREATE UNIQUE INDEX idx_provider_orders_intent_provider_unique
  ON provider_orders(checkout_intent_id, provider);
CREATE INDEX idx_provider_orders_status_lease
  ON provider_orders(status, lease_expires_at) WHERE status = 'creating';
