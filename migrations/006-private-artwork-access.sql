ALTER TABLE order_items ADD COLUMN IF NOT EXISTS artwork_original_name TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS artwork_stored_name TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS artwork_mime TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS artwork_size BIGINT;

CREATE INDEX IF NOT EXISTS idx_order_items_artwork_stored_name
  ON order_items(artwork_stored_name) WHERE artwork_stored_name IS NOT NULL;
