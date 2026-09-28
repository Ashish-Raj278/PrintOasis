ALTER TABLE cart_items
  ALTER COLUMN unit_price TYPE NUMERIC(12,2) USING unit_price::numeric(12,2);

ALTER TABLE order_items
  ALTER COLUMN unit_price TYPE NUMERIC(12,2) USING unit_price::numeric(12,2);

ALTER TABLE orders
  ALTER COLUMN total TYPE NUMERIC(12,2) USING total::numeric(12,2),
  ALTER COLUMN shipping_fee TYPE NUMERIC(12,2) USING shipping_fee::numeric(12,2),
  ALTER COLUMN discount TYPE NUMERIC(12,2) USING discount::numeric(12,2);
