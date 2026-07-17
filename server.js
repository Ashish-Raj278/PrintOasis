const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("node:url");
const { categories, products: catalogProducts } = require("./catalog");
const PDFDocument = require("pdfkit");
const { createEmailService, orderEmailTemplate } = require("./services/email");
const routes = [
  require("./routes/static"),
  require("./routes/auth"),
  require("./routes/products"),
  require("./routes/cart"),
  require("./routes/checkout"),
  require("./routes/admin"),
  require("./routes/account")
];
if (fs.existsSync(path.join(__dirname, ".env"))) process.loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const EMAIL_WEBHOOK_URL = process.env.EMAIL_WEBHOOK_URL || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "orders@printoasis.example";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_SECURE = process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const EMAIL_DELIVERY_ENABLED = process.env.EMAIL_DELIVERY_ENABLED !== "false" && process.env.NODE_ENV !== "test";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || (process.env.NODE_ENV === "production" ? "" : "admin@printoasis.example")).trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "PrintOasisAdmin123!");
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PRODUCT_IMAGE_DIR = path.join(UPLOAD_DIR, "product-images");
const EMAIL_LOG_DIR = path.join(DATA_DIR, "email-outbox");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
fs.mkdirSync(EMAIL_LOG_DIR, { recursive: true });
const emailService = createEmailService({ enabled: EMAIL_DELIVERY_ENABLED, host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, user: SMTP_USER, pass: SMTP_PASS, from: EMAIL_FROM });
const db = new DatabaseSync(path.join(DATA_DIR, "store.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
const ORDER_STATUSES = ["Pending", "Printing", "Packed", "Shipped", "Delivered", "Cancelled"];
const ALLOWED_ARTWORK_EXTENSIONS = new Set([".pdf", ".png", ".ai", ".psd"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEEDED_STOCK = 1000;
let lastSessionCleanupAt = 0;

function requestOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      google_sub TEXT UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      csrf TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      min_qty INTEGER NOT NULL,
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
      stock INTEGER NOT NULL DEFAULT 1000,
      reserved INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      featured INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      size TEXT NOT NULL,
      material TEXT NOT NULL,
      print_option TEXT NOT NULL,
      artwork_note TEXT,
      artwork_original_name TEXT,
      artwork_stored_name TEXT,
      artwork_mime TEXT,
      artwork_size INTEGER,
      unit_price INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      shipping_fee INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT,
      gst_number TEXT,
      payment_method TEXT NOT NULL,
      payment_id TEXT,
      tracking_number TEXT,
      courier_name TEXT,
      tracking_url TEXT,
      estimated_delivery TEXT,
      shipped_at TEXT,
      inventory_restocked INTEGER NOT NULL DEFAULT 0,
      status_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      configuration TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS order_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      event TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value INTEGER NOT NULL,
      min_total INTEGER NOT NULL DEFAULT 0,
      minimum_order INTEGER NOT NULL DEFAULT 0,
      maximum_discount INTEGER,
      expiry_date TEXT,
      usage_limit INTEGER,
      times_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_id INTEGER,
      name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 1,
      verified_purchase INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      saved_price INTEGER,
      UNIQUE(user_id, product_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'Address',
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  const earlyOrderColumns = db.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
  for (const [name, ddl] of [
    ["courier_name", "ALTER TABLE orders ADD COLUMN courier_name TEXT"],
    ["tracking_url", "ALTER TABLE orders ADD COLUMN tracking_url TEXT"],
    ["estimated_delivery", "ALTER TABLE orders ADD COLUMN estimated_delivery TEXT"],
    ["shipped_at", "ALTER TABLE orders ADD COLUMN shipped_at TEXT"]
  ]) if (!earlyOrderColumns.includes(name)) db.exec(ddl);

  const reviewColumns = db.prepare("PRAGMA table_info(reviews)").all().map(column => column.name);
  if (!reviewColumns.includes("updated_at")) db.exec("ALTER TABLE reviews ADD COLUMN updated_at TEXT");
  if (!reviewColumns.includes("verified_purchase")) db.exec("ALTER TABLE reviews ADD COLUMN verified_purchase INTEGER NOT NULL DEFAULT 0");
  const columns = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
  if (!columns.includes("google_sub")) db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
  if (!columns.includes("is_admin")) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  const productColumns = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);

  if (!productColumns.includes("stock")) db.exec(`ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT ${DEFAULT_SEEDED_STOCK}`);
  if (!productColumns.includes("reserved")) db.exec("ALTER TABLE products ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0");
  if (!productColumns.includes("status")) db.exec("ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!productColumns.includes("featured")) db.exec("ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL");
  if (!productColumns.includes("active")) db.exec("ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  for (const [name, ddl] of [
    ["image_original_name", "ALTER TABLE products ADD COLUMN image_original_name TEXT"],
    ["image_stored_name", "ALTER TABLE products ADD COLUMN image_stored_name TEXT"],
    ["image_mime", "ALTER TABLE products ADD COLUMN image_mime TEXT"],
    ["image_size", "ALTER TABLE products ADD COLUMN image_size INTEGER"]
  ]) if (!productColumns.includes(name)) db.exec(ddl);
  db.exec("UPDATE products SET reserved = 0 WHERE reserved IS NULL OR reserved < 0");
  db.exec("UPDATE products SET status = CASE WHEN active = 0 THEN 'hidden' ELSE 'active' END WHERE status IS NULL OR status = ''");
  db.exec("UPDATE products SET status = 'hidden' WHERE active = 0 AND status != 'hidden'");
  db.exec("UPDATE products SET featured = 0 WHERE featured IS NULL");
  for (const product of catalogProducts) {
    db.prepare("UPDATE products SET stock = ? WHERE slug = ? AND stock <= 0 AND reserved = 0").run(DEFAULT_SEEDED_STOCK, product[0]);
  }
  const cartColumns = db.prepare("PRAGMA table_info(cart_items)").all().map(column => column.name);
  for (const [name, ddl] of [
    ["artwork_original_name", "ALTER TABLE cart_items ADD COLUMN artwork_original_name TEXT"],
    ["artwork_stored_name", "ALTER TABLE cart_items ADD COLUMN artwork_stored_name TEXT"],
    ["artwork_mime", "ALTER TABLE cart_items ADD COLUMN artwork_mime TEXT"],
    ["artwork_size", "ALTER TABLE cart_items ADD COLUMN artwork_size INTEGER"]
  ]) if (!cartColumns.includes(name)) db.exec(ddl);
  const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
  if (!orderColumns.includes("payment_id")) db.exec("ALTER TABLE orders ADD COLUMN payment_id TEXT");
  for (const [name, ddl] of [
    ["tracking_number", "ALTER TABLE orders ADD COLUMN tracking_number TEXT"],
    ["status_updated_at", "ALTER TABLE orders ADD COLUMN status_updated_at TEXT"],
    ["shipping_fee", "ALTER TABLE orders ADD COLUMN shipping_fee INTEGER NOT NULL DEFAULT 0"],
    ["discount", "ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0"],
    ["coupon_code", "ALTER TABLE orders ADD COLUMN coupon_code TEXT"],
    ["gst_number", "ALTER TABLE orders ADD COLUMN gst_number TEXT"],
    ["inventory_restocked", "ALTER TABLE orders ADD COLUMN inventory_restocked INTEGER NOT NULL DEFAULT 0"]
  ]) if (!orderColumns.includes(name)) db.exec(ddl);
  const orderItemColumns = db.prepare("PRAGMA table_info(order_items)").all().map(column => column.name);
  if (!orderItemColumns.includes("product_id")) db.exec("ALTER TABLE order_items ADD COLUMN product_id INTEGER");
  const couponColumns = db.prepare("PRAGMA table_info(coupons)").all().map(column => column.name);
  for (const [name, ddl] of [
    ["minimum_order", "ALTER TABLE coupons ADD COLUMN minimum_order INTEGER NOT NULL DEFAULT 0"],
    ["maximum_discount", "ALTER TABLE coupons ADD COLUMN maximum_discount INTEGER"],
    ["expiry_date", "ALTER TABLE coupons ADD COLUMN expiry_date TEXT"],
    ["usage_limit", "ALTER TABLE coupons ADD COLUMN usage_limit INTEGER"],
    ["times_used", "ALTER TABLE coupons ADD COLUMN times_used INTEGER NOT NULL DEFAULT 0"],
    ["created_at", "ALTER TABLE coupons ADD COLUMN created_at TEXT"]
  ]) if (!couponColumns.includes(name)) db.exec(ddl);
  db.exec("UPDATE coupons SET minimum_order = min_total WHERE minimum_order = 0 AND min_total > 0");
  db.exec("UPDATE coupons SET times_used = 0 WHERE times_used IS NULL OR times_used < 0");
  const wishlistColumns = db.prepare("PRAGMA table_info(wishlist_items)").all().map(column => column.name);
  if (!wishlistColumns.includes("saved_price")) db.exec("ALTER TABLE wishlist_items ADD COLUMN saved_price INTEGER");
  db.exec("UPDATE wishlist_items SET saved_price = (SELECT price FROM products WHERE products.id = wishlist_items.product_id) WHERE saved_price IS NULL");
  db.exec(`UPDATE reviews
    SET verified_purchase = 1
    WHERE user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = reviews.product_id AND o.user_id = reviews.user_id AND o.status = 'Delivered'
    )`);
  db.exec("UPDATE orders SET status_updated_at = COALESCE(status_updated_at, created_at, CURRENT_TIMESTAMP)");
  db.prepare("INSERT OR IGNORE INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,?,?,?,?,?)").run("WELCOME10", "percent", 10, 499, 499, 1);
  db.prepare("INSERT OR IGNORE INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,?,?,?,?,?)").run("PRINT100", "fixed", 100, 999, 999, 1);
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const existingAdmin = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
    if (existingAdmin) {
      db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(existingAdmin.id);
    } else {
      db.prepare("INSERT INTO users (name,email,password_hash,is_admin) VALUES (?,?,?,1)")
        .run("PrintOasis Admin", ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));
    }
  }
  const upsert = db.prepare(`
      INSERT INTO products
      (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name, category=excluded.category, price=excluded.price,
      min_qty=excluded.min_qty, rating=excluded.rating, badge=excluded.badge,
      description=excluded.description, sizes=excluded.sizes,
      materials=excluded.materials, print_options=excluded.print_options,
      color=excluded.color
  `);
  db.exec("BEGIN");
  try {
    for (const product of catalogProducts) upsert.run(...product);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
initDb();

const esc = (value = "") => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const parseCookies = req => Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
  const i = part.indexOf("=");
  return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
}));
const split = value => value.split("|");
const slugify = value => String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const safeFileName = value => path.basename(String(value || "artwork").replace(/[^a-zA-Z0-9._-]/g, "-"));
const statusClass = status => slugify(status || "pending");

function shippingFee(subtotal, postalCode = "") {
  if (subtotal >= 999) return 0;
  const pin = String(postalCode || "");
  return /^(11|40|41|56|57|60|70)/.test(pin) ? 99 : 149;
}

function couponValidation(code, subtotal) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { coupon: null, error: "" };
  const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(normalized);
  if (!coupon) return { coupon: null, error: "Coupon code is invalid." };
  if (!coupon.active) return { coupon: null, error: "This coupon is not active." };
  if (coupon.expiry_date && coupon.expiry_date < new Date().toISOString().slice(0, 10)) return { coupon: null, error: "This coupon has expired." };
  if (coupon.usage_limit !== null && Number(coupon.times_used) >= Number(coupon.usage_limit)) return { coupon: null, error: "This coupon has reached its usage limit." };
  const minimumOrder = Number(coupon.minimum_order || coupon.min_total || 0);
  if (subtotal < minimumOrder) return { coupon: null, error: `This coupon requires an order of at least ${money(minimumOrder)}.` };
  return { coupon, error: "" };
}

function couponFor(code, subtotal) {
  return couponValidation(code, subtotal).coupon;
}

function cartTotals(cart, postalCode = "", couponCode = "") {
  const couponResult = couponValidation(couponCode, cart.subtotal);
  const coupon = couponResult.coupon;
  const rawDiscount = coupon ? coupon.type === "percent" ? Math.round(cart.subtotal * coupon.value / 100) : coupon.value : 0;
  const discount = coupon ? Math.min(cart.subtotal, rawDiscount, Number(coupon.maximum_discount) || Infinity) : 0;
  const delivery = shippingFee(cart.subtotal - discount, postalCode);
  return { subtotal: cart.subtotal, discount, delivery, total: Math.max(0, cart.subtotal - discount + delivery), coupon, couponError: couponResult.error };
}

function visibleProductCondition(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}active = 1 AND COALESCE(${prefix}status, 'active') != 'hidden'`;
}

function productAvailable(product) {
  return Number(product?.stock || 0) - Number(product?.reserved || 0);
}

function sellableQuantity(product) {
  return Math.max(0, productAvailable(product));
}

function hasDeliveredPurchase(userId, productId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND oi.product_id = ? AND o.status = 'Delivered'
    LIMIT 1
  `).get(userId, productId));
}

function defaultAddress(userId) {
  return db.prepare("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1").get(userId);
}

function addCartItem(sessionId, product, quantity, configuration) {
  const requested = Math.max(1, Math.floor(Number(quantity) || product.min_qty));
  const available = productAvailable(product);
  if (available <= 0) throw new Error(`${product.name} is out of stock.`);
  if (requested > available) throw new Error(`Only ${sellableQuantity(product)} items available for ${product.name}.`);
  db.prepare(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,artwork_note,artwork_original_name,artwork_stored_name,artwork_mime,artwork_size,unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sessionId, product.id, requested, configuration.size, configuration.material, configuration.printOption, configuration.artworkNote || null, configuration.artworkOriginalName || null, configuration.artworkStoredName || null, configuration.artworkMime || null, configuration.artworkSize || null, product.price / product.min_qty);
  db.prepare("UPDATE products SET reserved = reserved + ? WHERE id = ?").run(requested, product.id);
  return requested;
}

function releaseReservedQuantity(productId, quantity) {
  const amount = Math.max(0, Number(quantity) || 0);
  if (!amount) return;
  db.prepare("UPDATE products SET reserved = CASE WHEN reserved - ? < 0 THEN 0 ELSE reserved - ? END WHERE id = ?")
    .run(amount, amount, productId);
}

function cleanupExpiredSessions(now = Date.now()) {
  if (now - lastSessionCleanupAt < 60000) return;
  lastSessionCleanupAt = now;
  const expired = db.prepare("SELECT id FROM sessions WHERE expires_at <= ?").all(now);
  for (const row of expired) releaseSessionReservations(row.id);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}

function releaseSessionReservations(sessionId) {
  const rows = db.prepare("SELECT product_id, SUM(quantity) quantity FROM cart_items WHERE session_id = ? GROUP BY product_id").all(sessionId);
  if (!rows.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) releaseReservedQuantity(row.product_id, row.quantity);
    db.prepare("DELETE FROM cart_items WHERE session_id = ?").run(sessionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

function getSession(req, res) {
  cleanupExpiredSessions();
  const cookies = parseCookies(req);
  let session = cookies.sid && db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(cookies.sid, Date.now());
  if (!session) {
    const id = crypto.randomBytes(24).toString("hex");
    const csrf = crypto.randomBytes(18).toString("hex");
    db.prepare("INSERT INTO sessions (id, csrf, expires_at) VALUES (?, ?, ?)").run(id, csrf, Date.now() + 30 * 86400000);
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = PUBLIC_BASE_URL.startsWith("https://") || forwardedProto === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    session = { id, user_id: null, csrf, expires_at: Date.now() + 30 * 86400000 };
  }
  const user = session.user_id ? db.prepare("SELECT id,name,email,is_admin FROM users WHERE id = ?").get(session.user_id) : null;
  return { ...session, user };
}

function isAdmin(session) {
  return Boolean(session.user && session.user.is_admin);
}
function generateInvoice(orderId) {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) return;

    const items = db.prepare(
        "SELECT * FROM order_items WHERE order_id = ?"
    ).all(orderId);

    const invoiceDir = path.join(__dirname, "invoices");
    if (!fs.existsSync(invoiceDir)) {
        fs.mkdirSync(invoiceDir, { recursive: true });
    }

    const filePath = path.join(invoiceDir, `invoice-${order.order_number}.pdf`);

    const doc = new PDFDocument({ margin: 50 });

    doc.pipe(fs.createWriteStream(filePath));

    doc.fontSize(24).text("PrintOasis", { align: "center" });
    doc.moveDown();

    doc.fontSize(18).text("INVOICE");
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Invoice No: ${order.order_number}`);
    doc.text(`Order ID: ${order.id}`);
    doc.text(`Customer: ${order.customer_name}`);
    doc.text(`Phone: ${order.phone}`);
    doc.text(`City: ${order.city}`);
    doc.text(`Status: ${order.status}`);
    doc.text(`Payment: ${order.payment_method}`);
    doc.moveDown();

    doc.text("Items");
    doc.moveDown(0.5);

    items.forEach(item => {
        doc.text(
            `${item.product_name}  | Qty: ${item.quantity} | ₹${item.unit_price}`
        );
    });

    doc.moveDown();

    doc.text(`Subtotal: ₹${order.total - order.shipping_fee + order.discount}`);
    doc.text(`Shipping: ₹${order.shipping_fee}`);
    doc.text(`Discount: ₹${order.discount}`);
    doc.font("Helvetica-Bold");
    doc.text(`Grand Total: ₹${order.total}`);

    doc.end();

}

function cartData(sessionId) {
  const items = db.prepare(`
    SELECT ci.*, p.slug, p.name, p.color, p.category, p.stock, p.reserved, p.status, p.active FROM cart_items ci
    JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? ORDER BY ci.id DESC
  `).all(sessionId);
  return {
    items,
    count: items.reduce((n, item) => n + item.quantity, 0),
    subtotal: items.reduce((n, item) => n + item.quantity * item.unit_price, 0)
  };
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function formBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request too large");
  }
  return Object.fromEntries(new URLSearchParams(body));
}

async function requestBuffer(req, limit = MAX_UPLOAD_BYTES + 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const marker = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(marker);
  while (start !== -1) {
    start += marker.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const next = buffer.indexOf(marker, start);
    if (next === -1) break;
    let part = buffer.subarray(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
      const name = disposition.match(/name="([^"]+)"/)?.[1];
      const filename = disposition.match(/filename="([^"]*)"/)?.[1];
      const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
      if (name && filename) files[name] = { filename, contentType, data: body };
      else if (name) fields[name] = body.toString("utf8");
    }
    start = next;
  }
  return { ...fields, files };
}

async function requestData(req) {
  const type = req.headers["content-type"] || "";
  if (type.includes("multipart/form-data")) {
    const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
    if (!boundary) throw new Error("Upload boundary missing");
    return parseMultipart(await requestBuffer(req), boundary);
  }
  return formBody(req);
}

function saveArtwork(file) {
  if (!file || !file.filename || !file.data?.length) return null;
  const original = safeFileName(file.filename);
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED_ARTWORK_EXTENSIONS.has(ext)) throw new Error("Unsupported artwork file type");
  if (file.data.length > MAX_UPLOAD_BYTES) throw new Error("Artwork file is too large");
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.data);
  return { original, stored, mime: file.contentType, size: file.data.length };
}

function saveProductImage(file) {
  if (!file || !file.filename || !file.data?.length) return null;
  const original = safeFileName(file.filename);
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) throw new Error("Unsupported product image type");
  if (file.data.length > MAX_PRODUCT_IMAGE_BYTES) throw new Error("Product image is too large");
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(PRODUCT_IMAGE_DIR, stored), file.data);
  return { original, stored, mime: file.contentType, size: file.data.length };
}

function notice(url) {
  const value = url.searchParams.get("notice");
  if (!value) return "";
  const type = /could not|failed|invalid|incorrect|unavailable|not found|must|no items|empty|only \d+ items/i.test(value) ? "error" : "success";
  return `<div class="notice ${type}" role="status" aria-live="polite"><span>${esc(value)}</span><button type="button" class="notice-dismiss" aria-label="Dismiss message">&times;</button></div>`;
}

function emptyState(kind, title, description, primaryHref, primaryLabel, secondaryHref = "", secondaryLabel = "") {
  return `<div class="empty empty-state empty-${kind}"><span class="empty-icon" aria-hidden="true"></span><h2>${esc(title)}</h2><p>${esc(description)}</p><div class="empty-actions"><a class="button primary" href="${primaryHref}">${esc(primaryLabel)}</a>${secondaryHref ? `<a class="button ghost" href="${secondaryHref}">${esc(secondaryLabel)}</a>` : ""}</div></div>`;
}

function nav(session, cart) {
  const navigationProducts = db.prepare(`SELECT name, slug, category, badge FROM products WHERE ${visibleProductCondition()} ORDER BY name`).all();
  const productsByCategory = new Map();
  for (const product of navigationProducts) {
    const products = productsByCategory.get(product.category) || [];
    products.push(product);
    productsByCategory.set(product.category, products);
  }
  const navigationGroups = categories.map(category => ({
    slug: category[0],
    name: category[1],
    description: category[2],
    products: productsByCategory.get(category[0]) || []
  }));
  const megaMenu = (group, allProducts = false) => {
    const menuId = allProducts ? "all-products-menu" : `category-menu-${group.slug}`;
    const featured = group.products.find(product => /best|popular|premium|new/i.test(product.badge || "")) || group.products[0];
    const content = allProducts
      ? `<div class="mega-menu-grid">${navigationGroups.map(item => `<section><h2><a href="/products?category=${encodeURIComponent(item.slug)}">${esc(item.name)}</a></h2>${item.products.length ? item.products.map(product => `<a href="/product/${encodeURIComponent(product.slug)}">${esc(product.name)}${product.badge ? `<small>${esc(product.badge)}</small>` : ""}</a>`).join("") : `<p class="mega-empty">New products coming soon.</p>`}</section>`).join("")}</div>`
      : `<div class="mega-category-content"><section class="mega-product-list"><p>${esc(group.description)}</p>${group.products.length ? group.products.map(product => `<a href="/product/${encodeURIComponent(product.slug)}">${esc(product.name)}${product.badge ? `<small>${esc(product.badge)}</small>` : ""}</a>`).join("") : `<p class="mega-empty">New products coming soon.</p>`}</section>${featured ? `<a class="mega-featured-product" href="/product/${encodeURIComponent(featured.slug)}"><span>FEATURED PRODUCT</span><b>${esc(featured.name)}</b><small>${featured.badge ? esc(featured.badge) : "Recommended"}</small><i>Explore &rarr;</i></a>` : ""}</div>`;
    return `<div class="mega-nav-wrap"><button class="mega-nav-trigger" type="button" data-category="${esc(group.slug)}" aria-expanded="false" aria-haspopup="true" aria-controls="${menuId}">${allProducts ? "All products" : esc(group.name)} <span aria-hidden="true">+</span></button><div class="mega-products-menu" id="${menuId}" role="region" aria-label="${allProducts ? "All products" : esc(group.name)} menu" aria-hidden="true"><div class="mega-menu-heading"><span>${allProducts ? "EXPLORE THE CATALOG" : esc(group.name.toUpperCase())}</span><a href="${allProducts ? "/products" : `/products?category=${encodeURIComponent(group.slug)}`}">${allProducts ? "View all products" : `View all ${esc(group.name)}`} &rarr;</a></div>${content}</div></div>`;
  };
  return `
    <div class="promise">Free delivery over ₹999 · Select products ready in 4 hours</div>
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="site-header" aria-label="Site header">
      <a class="brand" href="/" aria-label="PrintOasis home"><span>PRINT</span>OASIS<i>.</i></a>
      <form class="search" action="/products" data-search-form role="search"><input name="q" placeholder="Search business cards, flyers, labels..." aria-label="Search products" autocomplete="off" aria-expanded="false" aria-controls="search-suggestions"><button type="submit">Search</button><div class="search-suggestions" id="search-suggestions" role="region" aria-label="Search suggestions" hidden><div class="search-suggestions-section" data-search-recent hidden><span>Recent searches</span><div></div></div><div class="search-suggestions-section"><span>Popular searches</span><div>${["Business Cards", "Flyers", "Stickers", "Photo Mugs"].map(term => `<a href="/products?q=${encodeURIComponent(term)}">${esc(term)}</a>`).join("")}</div></div><div class="search-suggestions-section"><span>Browse a category</span><div>${categories.slice(0, 4).map(category => `<a href="/products?category=${encodeURIComponent(category[0])}">${esc(category[1])}</a>`).join("")}</div></div><div class="search-suggestions-section search-live-results" data-search-results hidden><span>Product suggestions</span><div></div></div></div></form>
      <nav class="header-actions" aria-label="Account and support">
        ${isAdmin(session) ? `<a href="/admin">Admin</a>` : ""}
        <a href="/help">Help</a>
        <a href="/track">Track</a>
        ${session.user ? `<a href="/wishlist">Wishlist</a>` : ""}
        ${session.user ? `<a href="/account">Hi, ${esc(session.user.name.split(" ")[0])}</a>` : `<a href="/login">Login</a>`}
        <a class="cart-link" href="/cart">Cart <b>${cart.count}</b></a>
        <button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false">Dark</button>
      </nav>
      <button class="menu-toggle" type="button" aria-label="Toggle product categories" aria-controls="category-navigation" aria-expanded="false">Menu</button>
    </header>
    <nav class="category-nav" id="category-navigation" aria-label="Product categories">
      ${megaMenu({ name: "All products", slug: "all-products", products: [] }, true)}
      ${navigationGroups.map(group => megaMenu(group)).join("")}
    </nav>`;
}

function layout(title, content, session, cart, description = "Custom printing for business, events and everyday moments.") {
  return `<!doctype html>
  <html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${esc(description)}">
    <title>${esc(title)} · PrintOasis</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/public/styles.css">
  </head><body>
    ${nav(session, cart)}
    <main id="main-content" tabindex="-1">${content}</main>
    <footer>
      <div><a class="brand light" href="/"><span>PRINT</span>OASIS<i>.</i></a><p>Ideas, made tangible.</p></div>
      <div><h4>Shop</h4><a href="/products">All products</a><a href="/products?category=same-day">Same-day prints</a><a href="/products?category=business-cards">Business cards</a></div>
      <div><h4>Support</h4><a href="/help">Help centre</a><a href="/faq">FAQ</a><a href="/account/orders">Track orders</a><a href="/contact">Contact us</a></div>
      <div><h4>For business</h4><a href="/business">Business solutions</a><a href="/contact">Bulk enquiries</a><a href="/products?category=packaging">Packaging</a></div>
      <p class="copyright">© ${new Date().getFullYear()} PrintOasis Print Services.</p>
    </footer>
    <script src="/public/app.js" defer></script>
  </body></html>`;
}

function productArt(product, large = false) {
  if (product.image_stored_name) {
    return `<div class="product-photo ${large ? "large" : ""}"><img src="/uploads/product-images/${encodeURIComponent(product.image_stored_name)}" alt="${esc(product.name)} mockup" ${large ? "fetchpriority=high" : 'loading="lazy" decoding="async"'}></div>`;
  }
  return `<div class="product-art ${esc(product.color)} ${large ? "large" : ""}" role="img" aria-label="${esc(product.name)} product illustration">
    <span class="art-sheet"></span><span class="art-mark">${esc(product.name.split(" ").map(w => w[0]).join("").slice(0, 2))}</span>
    <small>${esc(product.category.replace("-", " "))}</small>
  </div>`;
}

function highlightSearch(value, query = "") {
  const text = esc(value);
  const term = String(query).trim();
  if (!term) return text;
  const expression = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
  return text.replace(expression, "<mark>$1</mark>");
}

function productCard(product, searchQuery = "") {
  const available = sellableQuantity(product);
  return `<article class="product-card">
    <a href="/product/${product.slug}">${productArt(product)}</a>
    <div class="product-meta"><span class="badge">${esc(product.badge)}</span><span>★ ${product.rating}</span></div>
    <h3><a href="/product/${product.slug}">${highlightSearch(product.name, searchQuery)}</a></h3>
    <p>From <strong>${money(product.price)}</strong> / ${product.min_qty === 1 ? "piece" : `${product.min_qty} pcs`}${available <= 0 ? ` <span class="stock-note">Out of Stock</span>` : ""}</p>
    ${searchQuery ? `<small class="product-search-snippet">${highlightSearch(product.description, searchQuery)}</small>` : ""}
  </article>`;
}

function homePage(session, cart) {
  const featured = db.prepare(`SELECT * FROM products WHERE ${visibleProductCondition()} ORDER BY featured DESC, rating DESC LIMIT 8`).all();
  const categoryCounts = new Map(db.prepare(`SELECT category, COUNT(*) AS count FROM products WHERE ${visibleProductCondition()} GROUP BY category`).all().map(row => [row.category, row.count]));
  const testimonials = db.prepare(`
    SELECT r.name, r.rating, r.comment, r.verified_purchase, p.name AS product_name
    FROM reviews r
    JOIN products p ON p.id = r.product_id
    WHERE r.approved = 1 AND ${visibleProductCondition("p")}
    ORDER BY r.id DESC
    LIMIT 6
  `).all();
  const homeStats = {
    orders: Number(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status != 'Cancelled'").get().count),
    customers: Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count),
    products: Number(db.prepare(`SELECT COUNT(*) AS count FROM products WHERE ${visibleProductCondition()}`).get().count),
    categories: categories.length
  };
  const heroSlides = [
    ["PREMIUM BUSINESS CARDS", "Leave a lasting first impression.", "Exceptionally finished cards with the weight, texture and precision your brand deserves.", "/products?category=business-cards", "Explore business cards", "hero-business"],
    ["CUSTOM APPAREL", "Wear the work you are proud of.", "Turn team uniforms, event merchandise and everyday ideas into memorable custom apparel.", "/products?category=apparel", "Create custom apparel", "hero-apparel"],
    ["MARKETING MATERIALS", "Make every campaign impossible to miss.", "Posters, flyers, displays and more, produced with rich colour and a crisp finish.", "/products?category=marketing", "Shop marketing prints", "hero-marketing"],
    ["BULK PRINTING", "A print partner built to scale.", "Consistent quality, business controls and reliable fulfilment for every location and every order.", "/business", "Explore business printing", "hero-business-solutions"]
  ];
  return layout("Online printing made brilliantly simple", `
    <section class="home-hero carousel-shell" data-carousel data-carousel-interval="4000" aria-label="PrintOasis promotions">
      <div class="carousel-track">${heroSlides.map((slide, index) => `<article class="hero-slide ${slide[5]} ${index === 0 ? "is-active" : ""}" aria-hidden="${index === 0 ? "false" : "true"}"><img src="/public/hero-print-studio.png" alt="${index === 0 ? "Premium printed cards, packaging and colourful print samples" : ""}" ${index === 0 ? "fetchpriority=high" : "loading=lazy"}><div class="hero-slide-overlay"></div><div class="hero-copy"><span class="eyebrow">${slide[0]}</span><h1>${slide[1]}</h1><p>${slide[2]}</p><div class="hero-cta"><a class="button primary" href="${slide[3]}">${slide[4]}</a><a class="button ghost light-ghost" href="/products">All products</a></div></div></article>`).join("")}</div>
      <div class="carousel-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous promotion">&larr;</button><div class="carousel-dots" role="tablist" aria-label="Choose promotion">${heroSlides.map((_, index) => `<button type="button" role="tab" aria-label="Promotion ${index + 1}" aria-selected="${index === 0}" data-carousel-dot="${index}"></button>`).join("")}</div><button class="carousel-arrow next" type="button" aria-label="Next promotion">&rarr;</button></div>
      <a class="hero-scroll-indicator" href="#offers" aria-label="Scroll to current offers"><span></span>Scroll to discover</a>
    </section>
    <section class="home-offers section" id="offers" data-carousel data-carousel-interval="5500" aria-label="Current offers">
      <div class="section-heading"><div><span class="eyebrow">PRINT MORE, SAVE MORE</span><h2>Offers worth printing for</h2></div><a href="/products">Shop all offers &rarr;</a></div>
      <div class="offers-viewport"><div class="carousel-track offer-track">${[["20% OFF", "Business cards", "Use code FIRST20 on your first card order.", "business-cards"], ["FREE SHIPPING", "Orders above Rs. 999", "One less thing between your idea and your doorstep.", "products"], ["BULK SAVINGS", "Built for bigger runs", "Get tailored pricing for high-volume and recurring orders.", "business"], ["SAME-DAY SELECTS", "In a hurry?", "Choose eligible essentials for a faster production window.", "same-day"]].map((offer, index) => `<article class="offer-card offer-${index + 1}" aria-hidden="${index === 0 ? "false" : "true"}"><span>${offer[0]}</span><h3>${offer[1]}</h3><p>${offer[2]}</p><a href="/${offer[3] === "products" ? "products" : offer[3] === "business" ? "business" : `products?category=${offer[3]}`}">Explore &rarr;</a></article>`).join("")}</div></div>
      <div class="carousel-controls compact-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous offer">&larr;</button><div class="carousel-dots" role="tablist" aria-label="Choose offer">${[0, 1, 2, 3].map(index => `<button type="button" role="tab" aria-label="Offer ${index + 1}" aria-selected="${index === 0}" data-carousel-dot="${index}"></button>`).join("")}</div><button class="carousel-arrow next" type="button" aria-label="Next offer">&rarr;</button></div>
    </section>
    <section class="section popular-categories reveal-on-scroll">
      <div class="section-heading"><div><span class="eyebrow">FIND YOUR PRINT</span><h2>Shop by category</h2></div><a href="/products">See everything →</a></div>
      <div class="category-grid">${categories.map(c => `<a class="category-card" href="/products?category=${c[0]}"><span>${c[3]}</span><div><h3>${c[1]}</h3><p>${c[2]}</p><small>${categoryCounts.get(c[0]) || 0} product${categoryCounts.get(c[0]) === 1 ? "" : "s"}</small></div><b>→</b></a>`).join("")}</div>
    </section>
    <section class="section tint featured-products reveal-on-scroll" data-product-carousel data-carousel-interval="8000">
      <div class="section-heading"><div><span class="eyebrow">CUSTOMER FAVOURITES</span><h2>Most loved prints</h2></div><a href="/products">View all →</a></div>
      <div class="product-carousel-viewport"><div class="product-grid product-carousel-track">${featured.map(productCard).join("")}</div></div>
      <div class="product-carousel-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous featured products">&larr;</button><button class="carousel-arrow next" type="button" aria-label="Next featured products">&rarr;</button></div>
    </section>
    <section class="home-testimonials section reveal-on-scroll" data-carousel data-carousel-interval="8000" aria-label="Customer testimonials">
      <div class="section-heading"><div><span class="eyebrow">REAL ORDERS, REAL WORDS</span><h2>Trusted by people who make things happen</h2></div></div>
      <div class="testimonials-viewport"><div class="carousel-track testimonial-track">${testimonials.length ? testimonials.map((review, index) => `<article class="testimonial-card" aria-hidden="${index === 0 ? "false" : "true"}"><span class="testimonial-stars" aria-label="${review.rating} out of 5 stars">${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</span><blockquote>${esc(review.comment)}</blockquote><div class="testimonial-author"><b>${esc(review.name)}</b><span>${esc(review.product_name)}${review.verified_purchase ? " · Verified Purchase" : ""}</span></div></article>`).join("") : `<article class="testimonial-card empty-testimonial"><span class="testimonial-stars" aria-hidden="true">★★★★★</span><blockquote>Customer reviews from verified, delivered orders will appear here.</blockquote><div class="testimonial-author"><b>PrintOasis customers</b><span>Made-to-order print, carefully delivered</span></div></article>`}</div></div>
      <div class="carousel-controls compact-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous testimonial">&larr;</button><div class="carousel-dots" role="tablist" aria-label="Choose testimonial">${(testimonials.length ? testimonials : [null]).map((_, index) => `<button type="button" role="tab" aria-label="Testimonial ${index + 1}" aria-selected="${index === 0}" data-carousel-dot="${index}"></button>`).join("")}</div><button class="carousel-arrow next" type="button" aria-label="Next testimonial">&rarr;</button></div>
    </section>
    <section class="home-statistics reveal-on-scroll" aria-label="PrintOasis statistics">${[[homeStats.orders, "Orders completed"], [homeStats.customers, "Happy customers"], [homeStats.products, "Products available"], [homeStats.categories, "Print categories"]].map(stat => `<article><b data-count="${stat[0]}">0</b><span>${stat[1]}</span></article>`).join("")}</section>
    <section class="business-banner">
      <div><span class="eyebrow">PRINTOASIS FOR BUSINESS</span><h2>One print partner.<br>Every business need.</h2><p>Centralised ordering, brand controls, nationwide fulfilment and dedicated account support.</p><a class="button light-button" href="/business">Explore business printing</a></div>
      <div class="business-stats"><span><b>48h</b> standard dispatch</span><span><b>30+</b> product formats</span><span><b>Pan-India</b> delivery</span></div>
    </section>
    <section class="steps section"><span class="eyebrow">HOW IT WORKS</span><h2>From screen to doorstep</h2><div><article><b>01</b><h3>Pick a product</h3><p>Choose format, size, material and quantity.</p></article><article><b>02</b><h3>Add your artwork</h3><p>Share your design reference and production notes.</p></article><article><b>03</b><h3>We print & deliver</h3><p>Every order is checked before dispatch.</p></article></div></section>
  `, session, cart);
}

function productsPage(url, session, cart) {
  const category = url.searchParams.get("category") || "";
  const q = url.searchParams.get("q") || "";
  const sort = ["recommended", "price-asc", "price-desc", "newest"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "recommended";
  const productsUrl = (nextCategory = category) => {
    const params = new URLSearchParams();
    if (nextCategory) params.set("category", nextCategory);
    if (q) params.set("q", q);
    if (sort !== "recommended") params.set("sort", sort);
    const query = params.toString();
    return `/products${query ? `?${query}` : ""}`;
  };
  let sql = `SELECT * FROM products WHERE ${visibleProductCondition()}`;
  const args = [];
  if (category) { sql += " AND category = ?"; args.push(category); }
  if (q) { sql += " AND (name LIKE ? OR description LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += sort === "price-asc" ? " ORDER BY price ASC, rating DESC" : sort === "price-desc" ? " ORDER BY price DESC, rating DESC" : sort === "newest" ? " ORDER BY id DESC" : " ORDER BY rating DESC, name";
  const products = db.prepare(sql).all(...args);
  const categoryInfo = categories.find(c => c[0] === category);
  return layout(categoryInfo ? categoryInfo[1] : q ? `Search: ${q}` : "All products", `
    <section class="page-hero compact"><span class="eyebrow">PRINT SHOP</span><h1>${categoryInfo ? esc(categoryInfo[1]) : q ? `Results for “${esc(q)}”` : "All products"}</h1><p>${categoryInfo ? esc(categoryInfo[2]) : `${products.length} customizable products for work, events and gifting.`}</p></section>
    <section class="catalog section">
      <aside class="catalog-filters"><h3>Categories</h3><a class="${!category ? "active" : ""}" href="${productsUrl("")}"${!category ? ' aria-current="page"' : ""}>All products</a>${categories.map(c => `<a class="${category === c[0] ? "active" : ""}" href="${productsUrl(c[0])}"${category === c[0] ? ' aria-current="page"' : ""}>${c[1]}</a>`).join("")}</aside>
      <div><div class="catalog-bar"><div><span class="catalog-result-label">${q ? `Search results for “${esc(q)}”` : categoryInfo ? esc(categoryInfo[1]) : "All products"}</span><b>${products.length} product${products.length === 1 ? "" : "s"}</b></div><form class="catalog-sort" method="get" action="/products"><input type="hidden" name="q" value="${esc(q)}"><input type="hidden" name="category" value="${esc(category)}"><label>Sort by<select name="sort" onchange="this.form.submit()"><option value="recommended" ${sort === "recommended" ? "selected" : ""}>Recommended</option><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest</option><option value="price-asc" ${sort === "price-asc" ? "selected" : ""}>Price: low to high</option><option value="price-desc" ${sort === "price-desc" ? "selected" : ""}>Price: high to low</option></select></label><noscript><button class="button ghost" type="submit">Apply</button></noscript></form></div>
      ${products.length ? `<div class="product-grid">${products.map(product => productCard(product, q)).join("")}</div>` : `${emptyState("search", "No products matched your search", "Try a broader search or browse one of our popular print collections.", "/products", "Browse all products", "/help", "Get print help")}<div class="search-category-shortcuts">${categories.slice(0, 5).map(item => `<a href="/products?category=${encodeURIComponent(item[0])}">${esc(item[1])}</a>`).join("")}</div>`}</div>
    </section>
  `, session, cart);
}

function productPage(product, session, cart) {
  const sizes = split(product.sizes), materials = split(product.materials), options = split(product.print_options);
  const available = productAvailable(product);
  const sellable = sellableQuantity(product);
  const defaultQuantity = sellable > 0 ? Math.min(Math.max(1, product.min_qty), sellable) : 0;
  const reviews = db.prepare("SELECT * FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY id DESC LIMIT 6").all(product.id);
  const reviewSummary = db.prepare(`
    SELECT
      COUNT(*) AS count,
      AVG(rating) AS avg,
      SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS rating_5_count,
      SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS rating_4_count,
      SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS rating_3_count,
      SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS rating_2_count,
      SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS rating_1_count
    FROM reviews
    WHERE product_id = ? AND approved = 1
  `).get(product.id);
  const stockState = sellable <= 0
    ? { kind: "out", label: "Out of stock" }
    : sellable <= Math.max(product.min_qty, 5)
      ? { kind: "low", label: `Low stock: ${sellable} available` }
      : { kind: "in", label: `In stock: ${sellable} available` };
  const recommendations = db.prepare(`SELECT * FROM products WHERE category = ? AND id != ? AND ${visibleProductCondition()} ORDER BY rating DESC LIMIT 4`).all(product.category, product.id);
  const wished = session.user ? db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(session.user.id, product.id) : null;
  const canReview = session.user ? hasDeliveredPurchase(session.user.id, product.id) : false;
  return layout(product.name, `
    <section class="breadcrumbs"><a href="/">Home</a><span>/</span><a href="/products?category=${product.category}">${esc(categories.find(c => c[0] === product.category)?.[1] || "Products")}</a><span>/</span>${esc(product.name)}</section>
    <section class="product-detail">
      <div class="product-gallery">${productArt(product, true)}<div class="quality-note"><b>✓ Free artwork quality check</b><span>We review every file before printing.</span></div></div>
      <div class="product-config">
        <span class="badge">${esc(product.badge)}</span><h1>${esc(product.name)}</h1><div class="rating"><span class="rating-stars" aria-label="${product.rating} out of 5 stars">★★★★★</span><span>${product.rating} · ${reviewSummary.count ? `${reviewSummary.count} review${reviewSummary.count === 1 ? "" : "s"}` : "No reviews yet"}</span></div><p class="lead">${esc(product.description)}</p>
        <ul class="feature-list"><li>Low minimum order of ${product.min_qty}</li><li>Rich, calibrated color</li><li>Tracked delivery across India</li></ul>
        ${session.user ? `<form action="/wishlist/toggle" method="post" class="inline-action"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><button class="button ghost wishlist-button" type="submit" aria-label="${wished ? "Remove from wishlist" : "Add to wishlist"}">${wished ? "♥ Saved" : "♡ Wishlist"}</button></form>` : `<a class="button ghost wishlist-button" href="/login?next=${encodeURIComponent(`/product/${product.slug}`)}">♡ Wishlist</a>`}
        <form action="/cart/add" method="post" class="config-form" enctype="multipart/form-data">
          <input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}">
          <label>Size<select name="size">${sizes.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Material<select name="material">${materials.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Print / finish<select name="print_option">${options.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Quantity<input type="number" name="quantity" min="1" step="1" max="${sellable}" value="${defaultQuantity || 1}" ${sellable <= 0 ? "disabled" : "required"}></label>
          <label class="full">Artwork notes <textarea name="artwork_note" rows="3" placeholder="Design link, file name, colors or special instructions"></textarea></label>
          <label class="full">Upload artwork <input class="artwork-input" type="file" name="artwork_file" accept=".pdf,.png,.ai,.psd,application/pdf,image/png"><small class="input-help">Accepted: PDF, PNG, AI, PSD up to 25 MB.</small><span class="artwork-preview"></span></label>
          <div class="price-box"><span>Starting total</span><strong data-unit-price="${product.price / product.min_qty}">${money(defaultQuantity ? defaultQuantity * product.price / product.min_qty : product.price)}</strong><small>${available <= 0 ? "Out of Stock" : `${sellable} available now`} · Inclusive of taxes</small><span class="stock-state ${stockState.kind}">${stockState.label}</span></div>
          ${available > 0
  ? `<button class="button primary full" type="submit">Add to cart</button>`
  : `<button class="button full" type="button" disabled>Out of Stock</button>`}
        </form>
      </div>
    </section>
    <section class="info-tabs section"><article><span>01</span><h3>Production-ready</h3><p>High-resolution print with automated and human quality checks.</p></article><article><span>02</span><h3>Need design help?</h3><p>Add notes to your order and our prepress team will contact you.</p></article><article><span>03</span><h3>Reliable delivery</h3><p>Estimated dispatch in 2–4 working days for standard products.</p></article></section>
    <section class="section reviews-section" id="review">
      <div class="section-heading"><div><span class="eyebrow">CUSTOMER REVIEWS</span><h2>Print confidence from real orders</h2></div></div>
      <div class="review-layout">
        ${reviewSummary.count > 0
          ? `<div class="review-summary">
               <span class="review-stars">${"★".repeat(Math.round(reviewSummary.avg))}${"☆".repeat(5 - Math.round(reviewSummary.avg))}</span>
               <b>${reviewSummary.avg.toFixed(1)}</b>
               <span class="review-count">${reviewSummary.count} review${reviewSummary.count === 1 ? "" : "s"}</span>
               <div class="rating-breakdown" aria-label="Rating breakdown">
                 ${[5, 4, 3, 2, 1].map(rating => `<span>${rating}★ <b>${Number(reviewSummary[`rating_${rating}_count`]) || 0}</b></span>`).join("")}
               </div>
             </div>`
          : `<div class="review-summary"><span class="review-count">No reviews yet</span><div class="rating-breakdown" aria-label="Rating breakdown">${[5, 4, 3, 2, 1].map(rating => `<span>${rating}★ <b>0</b></span>`).join("")}</div></div>`}
        <div class="reviews">${reviews.length ? reviews.map(r => `<article><b>${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</b><p>${esc(r.comment)}</p><small>${esc(r.name)} · ${new Date(r.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "medium" })}${r.verified_purchase ? ` · <span class="verified-purchase">Verified Purchase</span>` : ""}</small></article>`).join("") : emptyState("review", "No reviews yet", "Verified customer feedback will appear here after delivery.", "/products", "Browse products", "/help", "Read FAQ")}</div>
        ${
!session.user
? `<div class="empty slim">
    <h3>Want to review?</h3>
    <p>Login after ordering to share feedback.</p>
    <a class="button primary" href="/login">Login</a>
   </div>`

: !canReview

? `<div class="empty slim">
    <h3>Verified purchase required</h3>
    <p>You can leave a review only after purchasing this product and once the order has been delivered.</p>
   </div>`

: `<div class="empty slim"><h3>Share your experience</h3><p>Manage your review from the delivered order that contains this product.</p><a class="button primary" href="/account/orders">Open order history</a></div>`
}
      </div>
    </section>
    ${recommendations.length ? `<section class="section tint related-products" data-product-carousel><div class="section-heading"><div><span class="eyebrow">SMART RECOMMENDATIONS</span><h2>Often ordered together</h2></div><a href="/products?category=${encodeURIComponent(product.category)}">View category &rarr;</a></div><div class="product-carousel-viewport"><div class="product-grid product-carousel-track">${recommendations.map(productCard).join("")}</div></div><div class="product-carousel-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous related products">&larr;</button><button class="carousel-arrow next" type="button" aria-label="Next related products">&rarr;</button></div></section>` : ""}
  `, session, cart, product.description);
}

function authPage(mode, url, session, cart, origin) {
  const login = mode === "login";
  return layout(login ? "Login" : "Create account", `
    <section class="auth-shell">
      <div class="auth-art"><span class="eyebrow">WELCOME TO PRINTOASIS</span><h1>${login ? "Your print desk is ready." : "Make ordering print effortless."}</h1><p>Save configurations, track production and reorder your favourites in seconds.</p><div class="paper-stack"><i></i><i></i><i></i></div></div>
      <div class="auth-card">${notice(url)}<span class="eyebrow">${login ? "ACCOUNT LOGIN" : "JOIN PRINTOASIS"}</span><h2>${login ? "Welcome back" : "Create your account"}</h2>
        ${GOOGLE_CLIENT_ID ? `
          <script src="https://accounts.google.com/gsi/client" async></script>
          <div id="g_id_onload" data-client_id="${esc(GOOGLE_CLIENT_ID)}" data-login_uri="${esc(`${origin}/auth/google`)}" data-auto_prompt="false" data-use_fedcm_for_prompt="true"></div>
          <div class="g_id_signin" data-type="standard" data-shape="rectangular" data-theme="outline" data-text="${login ? "signin_with" : "signup_with"}" data-size="large" data-logo_alignment="left" data-width="360"></div>
          <div class="auth-divider"><span>or continue with email</span></div>
        ` : `<div class="integration-note">Google sign-in becomes available after <code>GOOGLE_CLIENT_ID</code> is configured.</div>`}
        <form method="post" action="/${mode}">
          <input type="hidden" name="csrf" value="${session.csrf}">
          ${login ? "" : `<label>Full name<input name="name" autocomplete="name" required minlength="2"></label>`}
          <label>Email address<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<input type="password" name="password" autocomplete="${login ? "current-password" : "new-password"}" required minlength="8"></label>
          <input type="hidden" name="next" value="${esc(url.searchParams.get("next") || "/account")}">
          <button class="button primary" type="submit">${login ? "Login securely" : "Create account"}</button>
        </form>
        <p class="auth-switch">${login ? `New here? <a href="/register">Create an account</a>` : `Already have an account? <a href="/login">Login</a>`}</p>
      </div>
    </section>
  `, session, cart);
}

function cartPage(url, session, cart) {
  const totals = cartTotals(cart);
  return layout("Your cart", `
    <section class="page-hero compact"><span class="eyebrow">YOUR ORDER</span><h1>Shopping cart</h1><p>Review your print specifications before checkout.</p></section>
    ${notice(url)}
    <section class="cart-layout section">
      <div>${cart.items.length ? cart.items.map(item => `<article class="cart-item">${productArt(item)}<div class="cart-copy"><h3><a href="/product/${item.slug}">${esc(item.name)}</a></h3><p>${esc(item.size)} · ${esc(item.material)} · ${esc(item.print_option)}</p>${item.artwork_note ? `<small>Artwork note: ${esc(item.artwork_note)}</small>` : ""}${item.artwork_original_name ? `<small>Uploaded file: ${esc(item.artwork_original_name)}</small>` : ""}</div><form action="/cart/update" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="item_id" value="${item.id}"><label>Qty<input name="quantity" type="number" min="0" max="${item.quantity + sellableQuantity(item)}" value="${item.quantity}"></label><small>${item.quantity + sellableQuantity(item)} max available</small><button>Update</button></form><strong>${money(item.quantity * item.unit_price)}</strong></article>`).join("") : emptyState("cart", "Your cart is waiting.", "Choose a product and make it yours when the idea is ready.", "/products", "Browse products", "/help", "Need print help?")}</div>
      ${cart.items.length ? `<aside class="order-summary"><h2>Order summary</h2><p><span>Subtotal</span><b>${money(totals.subtotal)}</b></p><p><span>Delivery estimate</span><b>${totals.delivery === 0 ? "FREE" : money(totals.delivery)}</b></p><p class="total"><span>Total</span><b>${money(totals.total)}</b></p><small>Taxes included. Exact shipping updates by PIN code at checkout.</small><a class="button primary" href="/checkout">Proceed to checkout</a><a href="/products">Continue shopping</a></aside>` : ""}
    </section>
  `, session, cart);
}

function checkoutPage(session, cart, url = new URL("/checkout", "http://localhost")) {
  const razorpayReady = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
  const savedAddress = defaultAddress(session.user.id);
  const couponCode = String(url.searchParams.get("coupon_code") || "").trim().toUpperCase();
  const totals = cartTotals(cart, savedAddress?.postal_code || "", couponCode);
  return layout("Checkout", `
    <section class="page-hero compact"><span class="eyebrow">SECURE CHECKOUT</span><h1>Delivery & payment</h1><p>Your order and payment are verified securely before production.</p></section>
    ${notice(url)}
    <section class="checkout-layout section">
      <form class="checkout-form" id="checkout-form" action="/checkout" method="post" data-razorpay-ready="${razorpayReady}" data-key-id="${esc(RAZORPAY_KEY_ID)}"><input type="hidden" name="csrf" value="${session.csrf}">
        <h2>Contact & delivery</h2>
        ${savedAddress ? `<p class="saved-address-note">Using your default address: ${esc(savedAddress.label)}. <a href="/account/addresses">Manage addresses</a></p>` : `<p class="saved-address-note">Save delivery addresses from <a href="/account/addresses">your account</a> to prefill checkout.</p>`}
        <div class="form-grid"><label>Full name<input name="customer_name" value="${esc(savedAddress?.recipient_name || session.user.name)}" required></label><label>Phone number<input name="phone" value="${esc(savedAddress?.phone || "")}" inputmode="tel" pattern="[0-9 +()-]{8,18}" required></label><label class="full">Address<textarea name="address" required rows="3">${esc(savedAddress?.address || "")}</textarea></label><label>City<input name="city" value="${esc(savedAddress?.city || "")}" required></label><label>PIN code<input name="postal_code" value="${esc(savedAddress?.postal_code || "")}" inputmode="numeric" pattern="[0-9]{6}" required></label><label>GST number <small class="input-help">Optional, shown on invoice.</small><input name="gst_number" maxlength="20"></label><label>Coupon code <small class="input-help">Try WELCOME10 or PRINT100.</small><input name="coupon_code" value="${esc(couponCode)}" maxlength="24"></label></div>
        <button class="button ghost coupon-apply" type="submit" formmethod="get" formaction="/checkout" formnovalidate>Apply coupon</button>
        ${totals.couponError ? `<p class="form-error">${esc(totals.couponError)}</p>` : totals.coupon ? `<p class="form-success">${esc(totals.coupon.code)} applied. You save ${money(totals.discount)}.</p>` : ""}
        <div class="shipping-estimate" data-subtotal="${cart.subtotal}">Enter PIN code for exact shipping.</div>
        <h2>Payment</h2>
        ${razorpayReady ? `<label class="payment-option"><input type="radio" name="payment_method" value="razorpay" checked><span><b>Pay securely online</b><small>UPI, cards, netbanking and supported wallets via Razorpay.</small></span></label>` : `<div class="integration-note">Online payment activates after Razorpay keys are added. Cash on delivery remains available.</div>`}
        <label class="payment-option"><input type="radio" name="payment_method" value="cod" ${razorpayReady ? "" : "checked"}><span><b>Cash on delivery</b><small>Available for eligible orders.</small></span></label>
        <button class="button primary" type="submit">Place order · ${money(totals.total)}</button>
      </form>
      <aside class="order-summary"><h2>Your prints</h2>${cart.items.map(i => `<p><span>${esc(i.name)} × ${i.quantity}</span><b>${money(i.quantity * i.unit_price)}</b></p>`).join("")}${totals.discount ? `<p><span>Coupon discount</span><b>−${money(totals.discount)}</b></p>` : ""}<p><span>Delivery estimate</span><b>${totals.delivery === 0 ? "FREE" : money(totals.delivery)}</b></p><p class="total"><span>Total</span><b>${money(totals.total)}</b></p></aside>
    </section>
    ${razorpayReady ? `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>` : ""}
  `, session, cart);
}

function accountPage(url, session, cart) {
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").all(session.user.id);
  return layout("My account", `
    <section class="account-head"><div><span class="eyebrow">MY PRINTOASIS</span><h1>Hello, ${esc(session.user.name)}.</h1><p>${esc(session.user.email)}</p></div><form action="/logout" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><button class="button ghost">Log out</button></form></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a class="active" href="/account">Overview</a><a href="/account/orders">Orders</a><a href="/account/addresses">Addresses</a><a href="/account/password">Security</a><a href="/products">Start a new order</a></aside><div><div class="account-cards"><article><span>Orders</span><b>${orders.length}</b><a href="/account/orders">View history →</a></article><article><span>Saved email</span><b class="small">${esc(session.user.email)}</b><a href="/account/addresses">Manage addresses →</a></article></div><h2>Recent orders</h2>${orderList(orders.slice(0, 3), session)}</div></section>
  `, session, cart);
}

function addressesPage(url, session, cart) {
  const editId = Number(url.searchParams.get("edit") || 0);
  const addresses = db.prepare("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC").all(session.user.id);
  const editing = editId ? addresses.find(address => address.id === editId) : null;
  const address = editing || { id: "", label: "Home", recipient_name: session.user.name, phone: "", address: "", city: "", postal_code: "", is_default: !addresses.length };
  return layout("Saved addresses", `
    <section class="page-hero compact"><span class="eyebrow">MY ACCOUNT</span><h1>Saved addresses</h1><p>Keep delivery details ready for a faster checkout.</p></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a href="/account">Overview</a><a href="/account/orders">Orders</a><a class="active" href="/account/addresses">Addresses</a><a href="/account/password">Security</a><a href="/products">Start a new order</a></aside><div><form class="account-form" method="post" action="/account/addresses/save"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${address.id}"><h2>${editing ? "Edit address" : "Add address"}</h2><div class="form-grid"><label>Label<input name="label" value="${esc(address.label)}" maxlength="40" required></label><label>Recipient name<input name="recipient_name" value="${esc(address.recipient_name)}" required></label><label>Phone<input name="phone" value="${esc(address.phone)}" inputmode="tel" pattern="[0-9 +()-]{8,18}" required></label><label>PIN code<input name="postal_code" value="${esc(address.postal_code)}" inputmode="numeric" pattern="[0-9]{6}" required></label><label class="full">Address<textarea name="address" rows="3" required>${esc(address.address)}</textarea></label><label>City<input name="city" value="${esc(address.city)}" required></label><label class="check-row"><input type="checkbox" name="is_default" value="1" ${address.is_default ? "checked" : ""}>Use as default delivery address</label></div><button class="button primary" type="submit">${editing ? "Save address" : "Add address"}</button></form><div class="address-list">${addresses.length ? addresses.map(item => `<article><div><b>${esc(item.label)}${item.is_default ? " · Default" : ""}</b><p>${esc(item.recipient_name)} · ${esc(item.phone)}<br>${esc(item.address)}, ${esc(item.city)} ${esc(item.postal_code)}</p></div><nav><a class="button ghost" href="/account/addresses?edit=${item.id}">Edit</a>${item.is_default ? "" : `<form method="post" action="/account/addresses/default"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${item.id}"><button class="button ghost">Set default</button></form>`}<form method="post" action="/account/addresses/delete" onsubmit="return confirm('Delete this saved address?');"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${item.id}"><button class="button ghost">Delete</button></form></nav></article>`).join("") : `<div class="empty slim"><h3>No saved addresses yet</h3><p>Add one to prefill checkout.</p></div>`}</div></div></section>
  `, session, cart);
}

function passwordPage(url, session, cart) {
  return layout("Account security", `
    <section class="page-hero compact"><span class="eyebrow">MY ACCOUNT</span><h1>Account security</h1><p>Keep your PrintOasis account protected.</p></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a href="/account">Overview</a><a href="/account/orders">Orders</a><a href="/account/addresses">Addresses</a><a class="active" href="/account/password">Security</a><a href="/products">Start a new order</a></aside><div><form class="account-form narrow-form" method="post" action="/account/password"><input type="hidden" name="csrf" value="${session.csrf}"><h2>Change password</h2><label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><label>New password<input name="new_password" type="password" autocomplete="new-password" minlength="8" required></label><label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required></label><button class="button primary" type="submit">Update password</button></form></div></section>
  `, session, cart);
}

function orderList(orders, session) {
  if (!orders.length)
    return emptyState("orders", "You have not placed an order yet", "Your print history, tracking and invoices will appear here.", "/products", "Start shopping", "/help", "How ordering works");

  return `<div class="orders">
    ${orders.map(order => `
      <article class="order-card">
        <div class="order-card-summary"><span>${esc(order.order_number)}</span><small>Placed ${new Date(order.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "medium" })}</small></div>
        <b class="status ${statusClass(order.status)}">${esc(order.status)}</b>
        <small class="order-card-total">${money(order.total)} · ${order.status === "Delivered" ? "Completed" : "In progress"}</small>
        <a class="button ghost" href="/account/orders/${order.id}">View Details →</a>
        ${session ? `<form method="post" action="/account/orders/reorder"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="order_id" value="${order.id}"><button class="button ghost" type="submit">Reorder</button></form>` : ""}
      </article>
    `).join("")}
  </div>`;
}

function ordersPage(session, cart, url) {
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ORDER_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const where = ["o.user_id = ?"];
  const params = [session.user.id];
  if (status) { where.push("o.status = ?"); params.push(status); }
  if (query) {
    where.push("(o.order_number LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name LIKE ?))");
    params.push(`%${query}%`, `%${query}%`);
  }
  const orders = db.prepare(`SELECT o.* FROM orders o WHERE ${where.join(" AND ")} ORDER BY o.id DESC`).all(...params);

  return layout(
    "Order history",
    `<section class="page-hero compact">
        <span class="eyebrow">MY ACCOUNT</span>
        <h1>Order history</h1>
        <p>Track every order from production to delivery.</p>
     </section>

     <section class="section narrow">
        <form class="order-filters" method="get" action="/account/orders"><input name="q" value="${esc(query)}" placeholder="Order ID or product name"><select name="status"><option value="">All statuses</option>${ORDER_STATUSES.map(item => `<option ${status === item ? "selected" : ""}>${item}</option>`).join("")}</select><button class="button ghost" type="submit">Filter orders</button></form>
        ${notice(url)}
        ${orderList(orders, session)}
     </section>`,
    session,
    cart
  );
}

function orderDetailsPage(order, session, cart) {
  const items = db.prepare(`
    SELECT oi.*, p.slug
    FROM order_items oi
    JOIN products p
      ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  const reviewByProductId = new Map();
  if (items.length) {
    const reviewRows = db.prepare(`
      SELECT id, product_id, rating, comment
      FROM reviews
      WHERE user_id = ? AND product_id IN (${items.map(() => "?").join(",")})
    `).all(session.user.id, ...items.map(item => item.product_id));
    for (const review of reviewRows) reviewByProductId.set(review.product_id, review);
  }
  for (const item of items) item.review = reviewByProductId.get(item.product_id) || null;

  return layout(
    `Order ${order.order_number}`,
    `<section class="page-hero compact">
      <span class="eyebrow">MY ACCOUNT</span>
      <h1>${esc(order.order_number)}</h1>
      <p>${new Date(order.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "long" })}</p>
    </section>

    <section class="section narrow order-details">
      <header class="order-detail-header"><div><span class="eyebrow">ORDER STATUS</span><h2>${esc(order.status)}</h2><p>Order total <strong>${money(order.total)}</strong></p></div><b class="status ${statusClass(order.status)}">${esc(order.status)}</b></header>

      <section class="shipment-panel"><div><span class="panel-label">Shipment timeline</span><h3>${order.status === "Delivered" ? "Delivered to your address" : "Your order is moving through production"}</h3></div>${statusTimeline(order)}</section>

      <div class="order-information-grid">
        <article><span class="panel-label">Delivery address</span><p>${esc(order.customer_name)}<br>${esc(order.address)}<br>${esc(order.city)} - ${esc(order.postal_code)}<br>${esc(order.phone)}</p></article>
        <article><span class="panel-label">Payment summary</span><p><strong>${money(order.total)}</strong><br>${esc(order.payment_id ? "Payment confirmed" : "Payment details recorded")}<br>Placed ${new Date(order.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "medium" })}</p></article>
        <article class="tracking-information"><span class="panel-label">Tracking</span>${order.courier_name || order.tracking_number || order.estimated_delivery ? `<p>${order.courier_name ? `<strong>${esc(order.courier_name)}</strong><br>` : ""}${order.tracking_number ? `<code>${esc(order.tracking_number)}</code><br>` : ""}${order.estimated_delivery ? `Estimated delivery: ${new Date(order.estimated_delivery).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}</p>` : `<p>Tracking details will appear when your order is dispatched.</p>`}${order.tracking_url ? `<a class="button primary" href="${esc(order.tracking_url)}" target="_blank" rel="noopener">Track package</a>` : ""}</article>
      </div>

      <section class="order-invoice-card"><div><span class="panel-label">GST invoice</span><h3>Print-ready invoice for this order</h3><p>View the full billing breakdown, then print or save it as a PDF.</p></div><a class="button ghost" href="/invoice/${encodeURIComponent(order.order_number)}">View invoice</a></section>

      <h2>Items in this order</h2>

      <div class="order-review-actions">
        ${items.map(item => `
          <div class="review-item" id="review-${item.product_id}">
            <span>${esc(item.product_name)} <small>Qty: ${item.quantity}</small></span>
            ${order.status === "Delivered" ? `<form class="review-form order-review-form" method="post" action="/account/reviews/save"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="order_id" value="${order.id}"><input type="hidden" name="product_id" value="${item.product_id}"><label>Rating<select name="rating">${[5, 4, 3, 2, 1].map(rating => `<option value="${rating}" ${item.review?.rating === rating ? "selected" : ""}>${rating}</option>`).join("")}</select></label><label>Comment<textarea name="comment" rows="3" minlength="8" required>${esc(item.review?.comment || "")}</textarea></label><button class="button primary" type="submit">${item.review ? "Update review" : "Submit review"}</button></form>${item.review ? `<form method="post" action="/account/reviews/delete" onsubmit="return confirm('Delete this review?');"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="order_id" value="${order.id}"><input type="hidden" name="review_id" value="${item.review.id}"><button class="button ghost" type="submit">Delete review</button></form>` : ""}` : `<small>Reviews unlock after this order is delivered.</small>`}
          </div>
        `).join("")}
      </div>

    </section>`,
    session,
    cart
  );
}

function infoPage(kind, session, cart) {
  const pages = {
    help: ["Help centre", "Everything you need for a smooth print run.", [["How should I prepare artwork?", "Use a print-ready PDF at 300 DPI with 3 mm bleed. Add any special instructions on the product page."], ["Can I order a small quantity?", "Yes. Many products start at one piece; business print minimums are shown on each product page."], ["How quickly will my order arrive?", "Standard products dispatch in 2–4 working days. Select products offer same-day production in supported cities."], ["Can you help with my design?", "Yes. Add a design reference or note to your cart and our prepress team can assist before production."]]],
    contact: ["Talk to our print team", "Questions, bulk requirements or a delightfully unusual idea?", [["Customer support", "support@printoasis.example · +91 80 4567 8900"], ["Working hours", "Monday–Saturday · 9:00 AM–7:00 PM IST"], ["Bulk enquiries", "business@printoasis.example"]]],
    business: ["Print, managed for business", "One dependable partner for teams, locations and campaigns.", [["Brand consistency", "Central templates and controlled print specifications across every order."], ["Volume pricing", "Custom commercial rates for recurring and high-volume requirements."], ["Nationwide fulfilment", "Coordinate kits, stationery, signage and packaging across India."], ["Dedicated support", "A single account contact from quotation through delivery."]]],
    faq: ["Frequently asked questions", "Straight answers for every stage of your print order.", [["Ordering", "Choose a product, configure size and finish, upload artwork, then review your cart before checkout."], ["Shipping", "Orders move through Pending, Printing, Packed, Shipped and Delivered. Tracking details appear as soon as dispatch is confirmed."], ["Artwork", "Upload PDF, PNG, AI or PSD artwork up to 25 MB. Our prepress team checks files before production."], ["Returns", "Contact support promptly if an item arrives damaged or differs from the approved specification so our team can review it."], ["Payments", "Secure online payments are processed through Razorpay when configured. Eligible orders can use cash on delivery."], ["Bulk orders", "For recurring, multi-location or large-format work, contact the business team for a tailored quote and production plan."]]]
  };
  const [title, subtitle, items] = pages[kind];
  return layout(title, `<section class="page-hero"><span class="eyebrow">${kind === "business" ? "BUSINESS SOLUTIONS" : "SUPPORT"}</span><h1>${title}</h1><p>${subtitle}</p>${kind === "business" ? `<a class="button primary" href="/contact">Request a business quote</a>` : ""}</section><section class="info-grid section">${items.map(i => `<article><h2>${i[0]}</h2><p>${i[1]}</p></article>`).join("")}</section>`, session, cart);
}

function adminTabs(active) {
  const tabs = [["/admin", "Dashboard"], ["/admin/products", "Products"], ["/admin/coupons", "Coupons"], ["/admin/orders", "Orders"], ["/admin/notifications", "Notifications"]];
  return `<aside aria-label="Admin navigation">${tabs.map(([href, label]) => `<a class="${active === label ? "active" : ""}" href="${href}"${active === label ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</aside>`;
}

function adminPage(title, active, body, session, cart) {
  return layout(title, `
    <section class="page-hero compact"><span class="eyebrow">ADMIN</span><h1>${esc(title)}</h1><p>Manage PrintOasis products, orders, statuses and customer operations.</p></section>
    <section class="account-layout admin-layout section">${adminTabs(active)}<div>${body}</div></section>
  `, session, cart);
}

function adminDashboardPage(session, cart) {
  const stats = {
    products: db.prepare(`SELECT COUNT(*) count FROM products WHERE ${visibleProductCondition()}`).get().count,
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    pending: db.prepare("SELECT COUNT(*) count FROM orders WHERE status NOT IN ('Delivered','Cancelled')").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total),0) total FROM orders").get().total
  };
  const statusCounts = db.prepare("SELECT status, COUNT(*) count FROM orders GROUP BY status ORDER BY count DESC").all();
  const recent = db.prepare("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 6").all();
  return adminPage("Operations dashboard", "Dashboard", `
    <div class="account-cards admin-stats">
      <article class="admin-stat-card"><span>Active products</span><b>${stats.products}</b><a href="/admin/products">Manage catalog</a></article>
      <article class="admin-stat-card"><span>Total orders</span><b>${stats.orders}</b><a href="/admin/orders">View orders</a></article>
      <article class="admin-stat-card"><span>Open jobs</span><b>${stats.pending}</b><a href="/admin/orders">Update status</a></article>
      <article class="admin-stat-card"><span>Revenue</span><b class="small">${money(stats.revenue)}</b><a href="/admin/orders">See sales</a></article>
    </div>
    <div class="admin-grid"><article><h2>Status pipeline</h2>${statusCounts.length ? statusCounts.map(s => `<p><span class="status ${statusClass(s.status)}">${esc(s.status)}</span><b>${s.count}</b></p>`).join("") : "<p>No orders yet.</p>"}</article><article><h2>Recent orders</h2>${adminOrderRows(recent, session, false)}</article></div>
  `, session, cart);
}

function productForm(product, session) {
  const p = product || { id: "", slug: "", name: "", category: categories[0][0], price: 399, min_qty: 1, rating: 4.8, badge: "New", description: "", sizes: "", materials: "", print_options: "", color: "cobalt", stock: 100, reserved: 0, status: "active", featured: 0, active: 1 };
  const available = productAvailable(p);
  return `<form class="admin-form" method="post" action="/admin/products/save" enctype="multipart/form-data">
    <input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${esc(p.id)}">
    <label>Product name<input name="name" value="${esc(p.name)}" required></label>
    <label>Slug<input name="slug" value="${esc(p.slug)}" placeholder="auto-created-if-empty"></label>
    <label>Category<select name="category">${categories.map(c => `<option value="${c[0]}" ${p.category === c[0] ? "selected" : ""}>${c[1]}</option>`).join("")}</select></label>
    <label>Price INR<input name="price" type="number" min="1" value="${esc(p.price)}" required></label>
    <label>Minimum quantity<input name="min_qty" type="number" min="1" value="${esc(p.min_qty)}" required></label>
    <label>Rating<input name="rating" type="number" min="1" max="5" step="0.1" value="${esc(p.rating)}" required></label>
    <label>Badge<input name="badge" value="${esc(p.badge || "")}"></label>
    <label>Mockup color<select name="color">${["cobalt", "coral", "yellow", "mint", "ink"].map(c => `<option ${p.color === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Product image <small class="input-help">JPG, PNG or WebP up to 8 MB.</small><input type="file" name="product_image" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"></label>
    <label class="full">Description<textarea name="description" rows="3" required>${esc(p.description)}</textarea></label>
    <label>Sizes <small class="input-help">Separate with |</small><input name="sizes" value="${esc(p.sizes)}" required></label>
    <label>Materials <small class="input-help">Separate with |</small><input name="materials" value="${esc(p.materials)}" required></label>
    <label>Print options <small class="input-help">Separate with |</small><input name="print_options" value="${esc(p.print_options)}" required></label>
    <label>Physical stock<input type="number" name="stock" min="0" value="${p.stock ?? 0}" required></label>
    <label>Reserved <input type="number" value="${p.reserved ?? 0}" readonly><small class="input-help">System-managed from carts and pending orders.</small></label>
    <label>Available <input type="number" value="${available}" readonly><small class="input-help">Calculated as stock - reserved.</small></label>
    <label>Status<select name="status"><option value="active" ${p.status !== "hidden" ? "selected" : ""}>Active</option><option value="hidden" ${p.status === "hidden" ? "selected" : ""}>Hidden</option></select></label>
    <label class="check-row">
    <input type="checkbox" name="featured" value="1" ${p.featured ? "checked" : ""}>
    Featured product
    </label>
    <button class="button primary full" type="submit">${product ? "Save product" : "Create product"}</button>
    </form>`;
}

function adminProductsPage(url, session, cart) {
  const editId = Number(url.searchParams.get("edit") || 0);
  const editing = editId ? db.prepare("SELECT * FROM products WHERE id = ?").get(editId) : null;
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ["", "active", "hidden"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const inventory = ["", "in", "low", "out"].includes(url.searchParams.get("inventory")) ? url.searchParams.get("inventory") : "";
  const where = [];
  const params = [];
  if (query) { where.push("(name LIKE ? OR slug LIKE ? OR category LIKE ?)"); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (status) { where.push("status = ?"); params.push(status); }
  const productSql = `SELECT * FROM products${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY status = 'hidden', category, name`;
  const products = db.prepare(productSql).all(...params).filter(product => {
    const available = productAvailable(product);
    if (inventory === "out") return available <= 0;
    if (inventory === "low") return available > 0 && available <= Math.max(5, product.min_qty);
    if (inventory === "in") return available > Math.max(5, product.min_qty);
    return true;
  });
  return adminPage("Product manager", "Products", `
    <div class="section-heading compact-heading"><div><span class="eyebrow">CATALOG CRUD</span><h2>${editing ? `Edit ${esc(editing.name)}` : "Add product"}</h2></div></div>
    ${productForm(editing, session)}
    <div class="admin-table"><div class="admin-table-heading"><div><span class="eyebrow">CATALOG OVERVIEW</span><h2>All products</h2></div><form class="admin-list-filters" method="get" action="/admin/products"><input name="q" value="${esc(query)}" placeholder="Search name, slug or category"><select name="status"><option value="">All statuses</option><option value="active" ${status === "active" ? "selected" : ""}>Active</option><option value="hidden" ${status === "hidden" ? "selected" : ""}>Hidden</option></select><select name="inventory"><option value="">All inventory</option><option value="in" ${inventory === "in" ? "selected" : ""}>In stock</option><option value="low" ${inventory === "low" ? "selected" : ""}>Low stock</option><option value="out" ${inventory === "out" ? "selected" : ""}>Out of stock</option></select><button class="button ghost" type="submit">Filter</button></form></div>${products.map(p => { const available = productAvailable(p); const stockKind = available <= 0 ? "out" : available <= Math.max(5, p.min_qty) ? "low" : "in"; return `<article><div>${productArt(p)}<span><b>${esc(p.name)}</b><small>${esc(p.category)} · ${money(p.price)} · min ${p.min_qty} · ${p.status === "hidden" ? "hidden" : "active"}</small><span class="admin-inventory"><span class="stock-state ${stockKind}">${available <= 0 ? "Out of stock" : available <= Math.max(5, p.min_qty) ? `Low: ${available} available` : `${available} available`}</span><small>Physical ${p.stock ?? 0} · Reserved ${p.reserved ?? 0}</small></span></span></div><nav><a class="button ghost" href="/admin/products?edit=${p.id}">Edit</a><form method="post" action="/admin/products/delete"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${p.id}"><button class="button ghost" type="submit">Delete</button></form></nav></article>`; }).join("") || emptyState("admin-products", "No products matched these filters", "Try clearing a filter or create a new product.", "/admin/products", "Clear filters")}</div>
  `, session, cart);
}

function couponForm(coupon, session) {
  const item = coupon || { code: "", type: "percent", value: 10, minimum_order: 0, maximum_discount: "", expiry_date: "", usage_limit: "", times_used: 0, active: 1 };
  return `<form class="admin-form" method="post" action="/admin/coupons/save"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="original_code" value="${esc(coupon?.code || "")}"><label>Code<input name="code" value="${esc(item.code)}" maxlength="24" pattern="[A-Za-z0-9_-]+" required></label><label>Type<select name="type"><option value="percent" ${item.type === "percent" ? "selected" : ""}>Percentage</option><option value="fixed" ${item.type === "fixed" ? "selected" : ""}>Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" value="${item.value}" required></label><label>Minimum order<input name="minimum_order" type="number" min="0" value="${item.minimum_order || 0}" required></label><label>Maximum discount <small class="input-help">Optional cap for percentage coupons.</small><input name="maximum_discount" type="number" min="1" value="${esc(item.maximum_discount || "")}"></label><label>Expiry date <small class="input-help">Optional; valid through this date.</small><input name="expiry_date" type="date" value="${esc(item.expiry_date || "")}"></label><label>Usage limit <small class="input-help">Optional total limit.</small><input name="usage_limit" type="number" min="1" value="${esc(item.usage_limit || "")}"></label><label>Times used<input type="number" value="${item.times_used || 0}" readonly></label><label class="check-row"><input type="checkbox" name="active" value="1" ${item.active ? "checked" : ""}>Coupon is active</label><button class="button primary full" type="submit">${coupon ? "Save coupon" : "Create coupon"}</button></form>`;
}

function adminCouponsPage(url, session, cart) {
  const editCode = String(url.searchParams.get("edit") || "").trim().toUpperCase();
  const editing = editCode ? db.prepare("SELECT * FROM coupons WHERE code = ?").get(editCode) : null;
  const coupons = db.prepare("SELECT * FROM coupons ORDER BY active DESC, created_at DESC, code").all();
  return adminPage("Coupon manager", "Coupons", `
    <div class="section-heading compact-heading"><div><span class="eyebrow">CHECKOUT PROMOTIONS</span><h2>${editing ? `Edit ${esc(editing.code)}` : "Create coupon"}</h2></div></div>
    ${couponForm(editing, session)}
    <div class="admin-table"><h2>All coupons</h2>${coupons.length ? coupons.map(coupon => `<article><div><span><b>${esc(coupon.code)}</b><small>${coupon.type === "percent" ? `${coupon.value}%` : money(coupon.value)} · Minimum ${money(coupon.minimum_order || coupon.min_total || 0)}${coupon.maximum_discount ? ` · Cap ${money(coupon.maximum_discount)}` : ""}</small><small>${coupon.active ? "Active" : "Disabled"} · Used ${coupon.times_used || 0}${coupon.usage_limit ? ` / ${coupon.usage_limit}` : ""}${coupon.expiry_date ? ` · Expires ${esc(coupon.expiry_date)}` : ""}</small></span></div><nav><a class="button ghost" href="/admin/coupons?edit=${encodeURIComponent(coupon.code)}">Edit</a><form method="post" action="/admin/coupons/toggle"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="code" value="${esc(coupon.code)}"><button class="button ghost">${coupon.active ? "Disable" : "Enable"}</button></form><form method="post" action="/admin/coupons/delete" onsubmit="return confirm('Delete this coupon?');"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="code" value="${esc(coupon.code)}"><button class="button ghost">Delete</button></form></nav></article>`).join("") : emptyState("coupon", "No coupons yet", "Create a promotion to offer a checkout incentive.", "/admin/coupons", "Create coupon")}</div>
  `, session, cart);
}

function adminOrderRows(orders, session, editable = true) {
  if (!orders.length)
    return emptyState("admin-orders", "No orders yet", "New customer orders will appear here after checkout.", "/admin/products", "Manage products");

  return `<div class="admin-orders">
    ${orders.map(o => `
      <article>
        <div>
          <b>${esc(o.order_number)}</b>

          <small>
            ${esc(o.customer_name)} · ${esc(o.email || "")} · ${money(o.total)}
          </small>

          <small>
            ${esc(o.city)} ${esc(o.postal_code)} ·
            ${new Date(o.created_at + "Z").toLocaleString("en-IN")}
          </small>
        </div>

        <span class="status ${statusClass(o.status)}">
          ${esc(o.status)}
        </span>

        ${
          editable
            ? `
          <form method="post" action="/admin/orders/status">

            <input type="hidden" name="csrf" value="${session.csrf}">
            <input type="hidden" name="order_id" value="${o.id}">

            <select name="status">
              ${ORDER_STATUSES.map(s =>
                `<option ${o.status === s ? "selected" : ""}>${s}</option>`
              ).join("")}
            </select>

            <input
              name="tracking_number"
              placeholder="Tracking #"
              value="${esc(o.tracking_number || "")}"
            >

            <input
              name="courier_name"
              placeholder="Courier Name"
              value="${esc(o.courier_name || "")}"
            >

            <input
              name="tracking_url"
              placeholder="Tracking URL"
              value="${esc(o.tracking_url || "")}"
            >

            <input
              type="date"
              name="estimated_delivery"
              value="${esc(o.estimated_delivery || "")}"
            >

            <input
              name="note"
              placeholder="Internal/customer note"
            >

            <button class="button primary" type="submit">
              Update
            </button>

          </form>

          <a class="button ghost"
             href="/invoice/${encodeURIComponent(o.order_number)}">
             Invoice
          </a>
        `
            : ""
        }

      </article>
    `).join("")}
  </div>`;
}

function adminOrdersPage(url, session, cart) {
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ORDER_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const where = [];
  const params = [];
  if (query) { where.push("(o.order_number LIKE ? OR o.customer_name LIKE ? OR u.email LIKE ?)"); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (status) { where.push("o.status = ?"); params.push(status); }
  const orders = db.prepare(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY o.id DESC`).all(...params);
  return adminPage("Order manager", "Orders", `<div class="admin-table-heading"><div><span class="eyebrow">FULFILMENT</span><h2>Order operations</h2></div><form class="admin-list-filters" method="get" action="/admin/orders"><input name="q" value="${esc(query)}" placeholder="Order number, customer or email"><select name="status"><option value="">All statuses</option>${ORDER_STATUSES.map(item => `<option ${status === item ? "selected" : ""}>${item}</option>`).join("")}</select><button class="button ghost" type="submit">Filter</button></form></div><p class="lead">Update statuses through Pending, Printing, Packed, Shipped, Delivered and Cancelled. Cancelled orders automatically restore deducted stock once.</p>${adminOrderRows(orders, session, true)}`, session, cart);
}

function adminNotificationsPage(session, cart) {
  const notifications = db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 60").all();
  return adminPage("Notification outbox", "Notifications", `<div class="admin-table">${notifications.length ? notifications.map(n => `<article><div><b>${esc(n.subject)}</b><small>${esc(n.event)} · ${esc(n.recipient)} · ${esc(n.status)}</small><small>${new Date(n.created_at + "Z").toLocaleString("en-IN")}</small></div></article>`).join("") : `<div class="empty slim"><h3>No notifications yet</h3><p>Order confirmations and status updates will appear here.</p></div>`}</div>`, session, cart);
}

function wishlistPage(session, cart) {
  const products = db.prepare(`SELECT p.*, w.saved_price FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND ${visibleProductCondition("p")} ORDER BY w.id DESC`).all(session.user.id);
  return layout("Wishlist", `<section class="page-hero compact"><span class="eyebrow">SAVED PRINTS</span><h1>Your wishlist</h1><p>Keep client favourites and repeat-order ideas close.</p></section><section class="section wishlist-section">${products.length ? `<div class="product-grid wishlist-grid">${products.map(product => { const available = sellableQuantity(product); const priceChanged = Number(product.price) !== Number(product.saved_price); const priceNote = Number(product.price) < Number(product.saved_price) ? "Price dropped" : Number(product.price) > Number(product.saved_price) ? "Price increased" : "Price unchanged"; const stockKind = available <= 0 ? "out" : available <= Math.max(5, product.min_qty) ? "low" : "in"; const stockNote = stockKind === "out" ? "Out of Stock" : stockKind === "low" ? "Low Stock" : "In Stock"; return `<article class="wishlist-card">${productArt(product)}<div class="wishlist-card-content"><div class="wishlist-card-meta"><span class="wishlist-price-note ${priceChanged ? "changed" : ""}">${esc(priceNote)}</span><span class="stock-state ${stockKind}">${esc(stockNote)}</span></div><h3><a href="/product/${esc(product.slug)}">${esc(product.name)}</a></h3><div class="wishlist-pricing"><strong>${money(product.price)}</strong>${priceChanged ? `<s>${money(product.saved_price)}</s>` : ""}${Number(product.price) < Number(product.saved_price) ? `<small>Save ${money(Number(product.saved_price) - Number(product.price))}</small>` : ""}</div><div class="wishlist-actions"><a class="button ghost" href="/product/${esc(product.slug)}">View product</a><form method="post" action="/wishlist/move-to-cart"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><button class="button primary" type="submit" ${available <= 0 ? "disabled" : ""}>Add to cart</button></form><form method="post" action="/wishlist/toggle"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><input type="hidden" name="next" value="/wishlist"><button class="button ghost" type="submit" aria-label="Remove ${esc(product.name)} from wishlist">Remove</button></form></div></div></article>`; }).join("")}</div>` : emptyState("wishlist", "Save products for later", "Keep client favourites and repeat-order ideas ready to revisit.", "/products", "Browse products", "/account", "View account")}</section>`, session, cart);
}

function statusTimeline(order) {
  if (order.status === "Cancelled") return `<div class="status-timeline" aria-label="Order status timeline"><span class="done">Pending</span><span class="done current" aria-current="step">Cancelled</span></div>`;
  const index = Math.max(0, ORDER_STATUSES.indexOf(order.status));
  return `<div class="status-timeline" aria-label="Order status timeline">${ORDER_STATUSES.filter(s => s !== "Cancelled").map((s, i) => `<span class="${i <= index ? "done" : ""}${i === index ? " current" : ""}"${i === index ? ' aria-current="step"' : ""}>${esc(s)}</span>`).join("")}</div>`;
}

function trackPage(url, session, cart, result = null) {
  return layout(
    "Track order",
    `<section class="page-hero compact">
      <span class="eyebrow">ORDER TRACKING</span>
      <h1>Track your print order</h1>
      <p>Enter your order number and phone number to see the current production stage.</p>
    </section>

    ${notice(url)}

    <section class="section narrow">

      <form class="track-form" method="post" action="/track">
        <input type="hidden" name="csrf" value="${session.csrf}">

        <label>
          Order number
          <input name="order_number" placeholder="PO-2026-123456" required>
        </label>

        <label>
          Phone number
          <input name="phone" required>
        </label>

        <button class="button primary" type="submit">
          Track order
        </button>
      </form>

      ${
        result
          ? `
        <div class="track-result">
          <div class="track-result-head"><div><span class="panel-label">Order number</span><h2>${esc(result.order_number)}</h2></div><b class="status ${statusClass(result.status)}">
            ${esc(result.status)}
          </b></div>

          ${statusTimeline(result)}

          ${["Shipped", "Delivered"].includes(result.status) ? `

${result.courier_name
  ? `<p><strong>Courier:</strong> ${esc(result.courier_name)}</p>`
  : ""}

${result.tracking_number
  ? `<p><strong>Tracking Number:</strong> <code>${esc(result.tracking_number)}</code></p>`
  : ""}

${result.estimated_delivery
  ? `<p><strong>Estimated Delivery:</strong> ${new Date(result.estimated_delivery).toLocaleDateString("en-IN", {
      dateStyle: "medium"
    })}</p>`
  : ""}

${result.tracking_url
  ? `<p>
      <a class="button primary"
         href="${esc(result.tracking_url)}"
         target="_blank"
         rel="noopener">
         Track Package
      </a>
     </p>`
  : ""}

` : ""}

        </div>
      `
          : ""
      }

    </section>`,
    session,
    cart
  );
}

function invoicePage(order, items, session, cart) {
  const taxable = Math.round(order.total / 1.18);
  const gst = order.total - taxable;
  return layout(`Invoice ${order.order_number}`, `<section class="invoice section narrow"><div class="invoice-head"><div><span class="eyebrow">GST INVOICE</span><h1>${esc(order.order_number)}</h1><p>${new Date(order.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "long" })}</p></div><div class="invoice-actions"><a class="button ghost" href="/account/orders/${order.id}">Back to order</a><button class="button primary" onclick="window.print()">Print / Save PDF</button></div></div><div class="invoice-box"><h2>Bill to</h2><p>${esc(order.customer_name)}<br>${esc(order.address)}<br>${esc(order.city)} - ${esc(order.postal_code)}<br>Phone: ${esc(order.phone)}${order.gst_number ? `<br>GST: ${esc(order.gst_number)}` : ""}</p></div><table class="invoice-table"><caption class="sr-only">Invoice items for ${esc(order.order_number)}</caption><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Rate</th><th scope="col">Total</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.product_name)}<small>${esc(i.configuration)}</small></td><td>${i.quantity}</td><td>${money(i.unit_price)}</td><td>${money(i.quantity * i.unit_price)}</td></tr>`).join("")}</tbody></table><div class="invoice-totals"><p><span>Shipping</span><b>${money(order.shipping_fee || 0)}</b></p><p><span>Discount</span><b>${money(order.discount || 0)}</b></p><p><span>Taxable value</span><b>${money(taxable)}</b></p><p><span>GST included</span><b>${money(gst)}</b></p><p class="total"><span>Grand total</span><b>${money(order.total)}</b></p></div></section>`, session, cart);
}

function requireAuth(session, res, next = "/account") {
  if (!session.user) { redirect(res, `/login?next=${encodeURIComponent(next)}&notice=${encodeURIComponent("Please login to continue.")}`); return false; }
  return true;
}
function requireAdmin(session, res) {
  if (!requireAuth(session, res, "/admin")) return false;
  if (!isAdmin(session)) { redirect(res, "/account?notice=Admin+access+required."); return false; }
  return true;
}
function validCsrf(data, session) {
  if (!data.csrf) return false;
  const sent = Buffer.from(String(data.csrf));
  const expected = Buffer.from(session.csrf);
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
}

function orderWithUser(orderId) {
  return db.prepare("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?").get(orderId);
}

async function queueNotification(orderId, event, recipient, subject, body, html) {
  const canSendSmtp = emailService.configured;
  const result = db.prepare("INSERT INTO notifications (order_id,event,recipient,subject,body,status) VALUES (?,?,?,?,?,?)")
    .run(orderId, event, recipient, subject, body, canSendSmtp || EMAIL_WEBHOOK_URL ? "queued" : "logged");
  const notificationId = Number(result.lastInsertRowid);
  fs.writeFileSync(path.join(EMAIL_LOG_DIR, `${Date.now()}-${notificationId}.txt`), `To: ${recipient}\nFrom: ${EMAIL_FROM}\nSubject: ${subject}\n\n${body}`);
  if (canSendSmtp) {
    const delivery = await emailService.send({ to: recipient, subject, text: body, html });
    if (delivery.delivered) {
      db.prepare("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(notificationId);
    } else {
      db.prepare("UPDATE notifications SET status = ? WHERE id = ?").run(`failed:${String(delivery.error || "SMTP delivery failed").slice(0, 80)}`, notificationId);
    }
    return;
  }
  console.info(`Email logged for ${recipient}: SMTP is not configured.`);
  if (!EMAIL_WEBHOOK_URL) return;
  try {
    const response = await fetch(EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: recipient, subject, text: body, html, event, orderId })
    });
    db.prepare("UPDATE notifications SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(response.ok ? "sent" : `failed:${response.status}`, notificationId);
  } catch (error) {
    db.prepare("UPDATE notifications SET status = ? WHERE id = ?").run(`failed:${error.message.slice(0, 80)}`, notificationId);
  }
}

async function notifyOrder(orderId, event, note = "") {
  const order = orderWithUser(orderId);
  if (!order) return;
  const items = db.prepare("SELECT product_id, product_name, quantity FROM order_items WHERE order_id = ?").all(order.id);
  const message = orderEmailTemplate({ event, order, items, note, baseUrl: PUBLIC_BASE_URL, money });
  await queueNotification(order.id, event, order.email, message.subject, message.text, message.html);
}

function createLocalOrder(session, cart, data, paymentMethod, paymentId = null) {
  if (!cart.items.length) throw new Error("Your cart is empty.");
  const totals = cartTotals(cart, data.postal_code, data.coupon_code);
  if (data.coupon_code && totals.couponError) throw new Error(totals.couponError);
  const orderNumber = `PO-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`;
  let orderId = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const requestedByProduct = new Map();
    for (const item of cart.items) requestedByProduct.set(item.product_id, (requestedByProduct.get(item.product_id) || 0) + item.quantity);
    for (const [productId, quantity] of requestedByProduct.entries()) {
      const product = db.prepare(`SELECT * FROM products WHERE id = ? AND ${visibleProductCondition()}`).get(productId);
      if (!product) throw new Error("One of the products in your cart is no longer available.");
      if (Number(product.stock || 0) < quantity) throw new Error(`Only ${Math.max(0, Number(product.stock || 0))} items available for ${product.name}.`);
      if (Number(product.reserved || 0) < quantity) throw new Error(`Reservation expired for ${product.name}. Please add it to cart again.`);
    }
    const result = db.prepare(`INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,shipping_fee,discount,coupon_code,gst_number,payment_method,payment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNumber, session.user.id, totals.total, "Pending", data.customer_name, data.phone, data.address, data.city, data.postal_code, totals.delivery, totals.discount, totals.coupon?.code || null, data.gst_number || null, paymentMethod, paymentId);
    orderId = Number(result.lastInsertRowid);
    const insertItem = db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)");
    const deductInventory = db.prepare("UPDATE products SET stock = stock - ?, reserved = reserved - ? WHERE id = ?");
    for (const item of cart.items) {
      insertItem.run(orderId, item.product_id, item.name, item.quantity, item.unit_price, `${item.size} · ${item.material} · ${item.print_option}${item.artwork_original_name ? ` · Artwork: ${item.artwork_original_name}` : ""}`);
      deductInventory.run(item.quantity, item.quantity, item.product_id);
    }
    if (totals.coupon) {
      const usage = db.prepare(`UPDATE coupons SET times_used = times_used + 1 WHERE code = ? AND active = 1 AND (usage_limit IS NULL OR times_used < usage_limit) AND (expiry_date IS NULL OR expiry_date >= ?)`).run(totals.coupon.code, new Date().toISOString().slice(0, 10));
      if (!usage.changes) throw new Error("This coupon is no longer available.");
    }
    db.prepare("INSERT INTO order_status_events (order_id,status,note) VALUES (?,?,?)").run(orderId, "Pending", "Order confirmed and queued for artwork review.");
    db.prepare("DELETE FROM cart_items WHERE session_id = ?").run(session.id);
    db.exec("COMMIT");
    notifyOrder(orderId, "order_confirmation").catch(console.error);
    return orderNumber;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
}
}

function restoreOrderInventory(orderId) {
  const order = db.prepare("SELECT id, inventory_restocked FROM orders WHERE id = ?").get(orderId);
  if (!order || order.inventory_restocked) return false;
  const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL").all(orderId);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(item.quantity, item.product_id);
    db.prepare("UPDATE orders SET inventory_restocked = 1 WHERE id = ?").run(orderId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function createRazorpayOrder(amount, receipt) {
  const authorization = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: "INR", receipt })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.description || "Razorpay order creation failed");
  return value;
}

function servePublic(req, res, url) {
  const file = path.join(ROOT, url.pathname);
  if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain"), true;
  const ext = path.extname(file);
  const types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
  send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
  return true;
}

function serveProductImage(req, res, url) {
  const name = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
  const file = path.join(PRODUCT_IMAGE_DIR, name);
  if (!file.startsWith(PRODUCT_IMAGE_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain"), true;
  const ext = path.extname(file).toLowerCase();
  const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
  return true;
}

const app = {
  ADMIN_EMAIL,
  GOOGLE_CLIENT_ID,
  ORDER_STATUSES,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  addCartItem,
  accountPage,
  addressesPage,
  adminDashboardPage,
  adminCouponsPage,
  adminNotificationsPage,
  adminOrdersPage,
  adminProductsPage,
  authPage,
  cartData,
  cartPage,
  cartTotals,
  checkoutPage,
  couponFor,
  couponValidation,
  createLocalOrder,
  createRazorpayOrder,
  crypto,
  db,
  defaultAddress,
  hashPassword,
  hasDeliveredPurchase,
  homePage,
  infoPage,
  invoicePage,
  isAdmin,
  layout,
  notifyOrder,
  orderDetailsPage,
  orderWithUser,
  ordersPage,
  passwordPage,
  parseCookies,
  productAvailable,
  productPage,
  productsPage,
  redirect,
  releaseReservedQuantity,
  releaseSessionReservations,
  requestOrigin,
  requireAdmin,
  requireAuth,
  restoreOrderInventory,
  saveArtwork,
  saveProductImage,
  send,
  sendJson,
  sellableQuantity,
  serveProductImage,
  servePublic,
  slugify,
  trackPage,
  validCsrf,
  visibleProductCondition,
  verifyPassword,
  wishlistPage
};

const server = http.createServer(async (req, res) => {
  try {
    const routedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (await routes[0]({ req, res, url: routedUrl, app })) return;
    const routedSession = getSession(req, res);
    const routedCart = cartData(routedSession.id);
    const routedData = req.method === "POST" ? await requestData(req) : {};
    const routedContext = { req, res, url: routedUrl, data: routedData, session: routedSession, cart: routedCart, app };
    for (const route of routes.slice(1)) {
      if (await route(routedContext)) return;
    }
    return send(res, 404, layout("Page not found", `<div class="empty section"><h1>That page missed the press.</h1><p>Let’s get you back to the print shop.</p><a class="button primary" href="/">Go home</a></div>`, routedSession, routedCart));

  } catch (error) {
    console.error(error);
    send(res, 500, process.env.NODE_ENV === "test" ? error.stack : "Something went wrong. Please try again.", "text/plain");
  }
});

server.listen(PORT, () => console.log(`PrintOasis running at http://localhost:${PORT}`)
);
