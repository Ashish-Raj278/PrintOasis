CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  google_sub TEXT UNIQUE,
  is_admin SMALLINT NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  csrf TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  min_qty INTEGER NOT NULL CHECK (min_qty > 0),
  rating REAL NOT NULL,
  badge TEXT,
  description TEXT NOT NULL,
  sizes TEXT NOT NULL,
  materials TEXT NOT NULL,
  print_options TEXT NOT NULL,
  color TEXT NOT NULL,
  image_original_name TEXT,
  image_stored_name TEXT,
  image_mime TEXT,
  image_size INTEGER,
  stock INTEGER NOT NULL DEFAULT 1000 CHECK (stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= stock),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  featured SMALLINT NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_products_category_visible ON products(category, active, status);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_original_name TEXT NOT NULL,
  image_stored_name TEXT NOT NULL,
  image_mime TEXT,
  image_size INTEGER,
  role TEXT NOT NULL DEFAULT 'gallery',
  placement TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, image_stored_name)
);
CREATE INDEX IF NOT EXISTS idx_product_images_product_sort ON product_images(product_id, placement, role, sort_order, id);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  size TEXT NOT NULL,
  material TEXT NOT NULL,
  print_option TEXT NOT NULL,
  artwork_note TEXT,
  artwork_original_name TEXT,
  artwork_stored_name TEXT,
  artwork_mime TEXT,
  artwork_size INTEGER,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_session_id ON cart_items(session_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Printing', 'Packed', 'Shipped', 'Delivered', 'Cancelled')),
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  shipping_fee INTEGER NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  coupon_code TEXT,
  gst_number TEXT,
  payment_method TEXT NOT NULL,
  payment_id TEXT,
  tracking_number TEXT,
  courier_name TEXT,
  tracking_url TEXT,
  estimated_delivery TEXT,
  shipped_at TIMESTAMPTZ,
  inventory_restocked SMALLINT NOT NULL DEFAULT 0 CHECK (inventory_restocked IN (0, 1)),
  status_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user_created_at ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  configuration TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id ON order_status_events(order_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_order_id ON notifications(order_id, id DESC);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_total INTEGER NOT NULL DEFAULT 0 CHECK (min_total >= 0),
  minimum_order INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order >= 0),
  maximum_discount INTEGER CHECK (maximum_discount > 0),
  expiry_date DATE,
  usage_limit INTEGER CHECK (usage_limit > 0),
  times_used INTEGER NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL,
  approved SMALLINT NOT NULL DEFAULT 1 CHECK (approved IN (0, 1)),
  verified_purchase SMALLINT NOT NULL DEFAULT 0 CHECK (verified_purchase IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_product ON reviews(user_id, product_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_product_approved ON reviews(product_id, approved, id DESC);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  saved_price INTEGER,
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Address',
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  is_default SMALLINT NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_addresses_user_default ON addresses(user_id, is_default DESC, id DESC);