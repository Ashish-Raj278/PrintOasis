ALTER TABLE refunds
  ADD COLUMN checkout_intent_id BIGINT REFERENCES checkout_intents(id) ON DELETE RESTRICT,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN provider_status TEXT,
  ADD COLUMN last_error TEXT;

UPDATE refunds r
SET checkout_intent_id = p.checkout_intent_id
FROM payments p
WHERE p.id = r.payment_record_id;

CREATE UNIQUE INDEX idx_orders_id_payment_record_unique
  ON orders(id, payment_record_id);

ALTER TABLE refunds
  ALTER COLUMN checkout_intent_id SET NOT NULL,
  ALTER COLUMN order_id DROP NOT NULL,
  DROP CONSTRAINT refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('requested', 'pending', 'succeeded', 'failed', 'unknown')),
  ADD CONSTRAINT refunds_attempt_count_check CHECK (attempt_count > 0),
  ADD CONSTRAINT refunds_payment_intent_fk
    FOREIGN KEY (payment_record_id, checkout_intent_id)
    REFERENCES payments(id, checkout_intent_id) ON DELETE RESTRICT,
  ADD CONSTRAINT refunds_order_payment_fk
    FOREIGN KEY (order_id, payment_record_id)
    REFERENCES orders(id, payment_record_id) ON DELETE RESTRICT,
  ADD CONSTRAINT refunds_order_or_intent_check
    CHECK (order_id IS NOT NULL OR checkout_intent_id IS NOT NULL);

CREATE INDEX idx_refunds_reconciliation
  ON refunds(status, updated_at) WHERE status IN ('requested', 'pending', 'unknown');

ALTER TABLE orders
  ADD COLUMN cancellation_status TEXT NOT NULL DEFAULT 'none'
    CHECK (cancellation_status IN ('none', 'refund_pending', 'refunded', 'completed', 'failed'));

ALTER TABLE checkout_intents
  ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'none'
    CHECK (recovery_status IN ('none', 'order_retry', 'refund_pending', 'refunded', 'blocked')),
  ADD COLUMN recovery_error TEXT;
