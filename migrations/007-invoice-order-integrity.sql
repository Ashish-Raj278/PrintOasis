ALTER TABLE orders
  ADD COLUMN invoice_snapshot JSONB;

UPDATE orders
SET invoice_snapshot = jsonb_build_object(
  'version', 1,
  'currency', 'INR',
  'tax_rate_bps', 1800,
  'tax_inclusive', true,
  'shipping_tax_treatment', 'included_in_aggregate_taxable_value',
  'subtotal_minor', (total - shipping_fee + discount) * 100,
  'discount_minor', discount * 100,
  'shipping_minor', shipping_fee * 100,
  'taxable_minor', ROUND(total::numeric / 1.18, 0) * 100,
  'tax_minor', total * 100 - ROUND(total::numeric / 1.18, 0) * 100,
  'total_minor', total * 100,
  'seller', jsonb_build_object(
    'legal_name', '',
    'registered_address', '',
    'gstin', '',
    'support_email', '',
    'support_phone', ''
  )
)
WHERE invoice_snapshot IS NULL;

UPDATE checkout_intents
SET shipping_input = shipping_input || jsonb_build_object(
  'invoice_tax_rate_bps', 1800,
  'invoice_seller', jsonb_build_object(
    'legal_name', '',
    'registered_address', '',
    'gstin', '',
    'support_email', '',
    'support_phone', ''
  )
)
WHERE NOT jsonb_exists(shipping_input, 'invoice_tax_rate_bps');

ALTER TABLE orders
  ADD CONSTRAINT orders_invoice_snapshot_shape_check
  CHECK (
    invoice_snapshot IS NULL OR (
      jsonb_typeof(invoice_snapshot) = 'object'
      AND jsonb_exists_any(invoice_snapshot, ARRAY[
        'currency', 'tax_rate_bps', 'tax_inclusive', 'subtotal_minor',
        'discount_minor', 'shipping_minor', 'taxable_minor', 'tax_minor',
        'total_minor', 'seller'
      ])
      AND invoice_snapshot->>'currency' ~ '^[A-Z]{3}$'
      AND jsonb_typeof(invoice_snapshot->'seller') = 'object'
      AND jsonb_typeof(invoice_snapshot->'tax_inclusive') = 'boolean'
      AND invoice_snapshot->>'tax_inclusive' = 'true'
      AND jsonb_exists_any(invoice_snapshot->'seller', ARRAY['legal_name', 'registered_address', 'gstin', 'support_email', 'support_phone'])
      AND (invoice_snapshot->'seller'->>'legal_name') IS NOT NULL
      AND (invoice_snapshot->'seller'->>'registered_address') IS NOT NULL
      AND (invoice_snapshot->>'subtotal_minor')::numeric >= 0
      AND (invoice_snapshot->>'discount_minor')::numeric >= 0
      AND (invoice_snapshot->>'shipping_minor')::numeric >= 0
      AND (invoice_snapshot->>'taxable_minor')::numeric >= 0
      AND (invoice_snapshot->>'tax_minor')::numeric >= 0
      AND (invoice_snapshot->>'total_minor')::numeric >= 0
      AND (invoice_snapshot->>'tax_rate_bps')::integer BETWEEN 0 AND 100000
      AND (invoice_snapshot->>'subtotal_minor')::numeric
        - (invoice_snapshot->>'discount_minor')::numeric
        + (invoice_snapshot->>'shipping_minor')::numeric
        = (invoice_snapshot->>'total_minor')::numeric
      AND (invoice_snapshot->>'taxable_minor')::numeric
        + (invoice_snapshot->>'tax_minor')::numeric
        = (invoice_snapshot->>'total_minor')::numeric
      AND (invoice_snapshot->>'total_minor')::numeric = total::numeric * 100
      AND (invoice_snapshot->>'shipping_minor')::numeric = shipping_fee::numeric * 100
      AND (invoice_snapshot->>'discount_minor')::numeric = discount::numeric * 100
      -- Legacy invoices rounded the extracted tax base to whole rupees.
      -- New snapshots use paise-level rounding; preserve both historical and
      -- current calculations while enforcing internal financial consistency.
    )
  );

ALTER TABLE order_status_events
  ADD COLUMN previous_status TEXT,
  ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT order_status_events_status_check
    CHECK (status IN ('Pending', 'Printing', 'Packed', 'Shipped', 'Delivered', 'Cancelled')),
  ADD CONSTRAINT order_status_events_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN ('Pending', 'Printing', 'Packed', 'Shipped', 'Delivered', 'Cancelled')),
  ADD CONSTRAINT order_status_events_actor_type_check
    CHECK (actor_type IN ('system', 'customer', 'admin', 'payment', 'refund'));

CREATE INDEX idx_order_status_events_actor
  ON order_status_events(actor_type, actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_order_status_event_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order status events are append-only';
END;
$$;

CREATE TRIGGER order_status_events_append_only
  BEFORE UPDATE ON order_status_events
  FOR EACH ROW EXECUTE FUNCTION reject_order_status_event_update();
