const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("node:url");
const { categories, products: catalogProducts } = require("./catalog");
const routes = [
  require("./routes/static"),
  require("./routes/auth"),
  require("./routes/products"),
  require("./routes/cart"),
  require("./routes/checkout"),
  require("./routes/admin"),
  require("./routes/account")
];
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }

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
const db = new DatabaseSync(path.join(DATA_DIR, "store.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
const ORDER_STATUSES = ["Pending", "Printing", "Packed", "Shipped", "Delivered"];
const ALLOWED_ARTWORK_EXTENSIONS = new Set([".pdf", ".png", ".ai", ".psd"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;

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
      status_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      configuration TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, product_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
  `);
  const columns = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
  if (!columns.includes("google_sub")) db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
  if (!columns.includes("is_admin")) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL");
  const productColumns = db.prepare("PRAGMA table_info(products)").all().map(column => column.name);
  if (!productColumns.includes("active")) db.exec("ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  for (const [name, ddl] of [
    ["image_original_name", "ALTER TABLE products ADD COLUMN image_original_name TEXT"],
    ["image_stored_name", "ALTER TABLE products ADD COLUMN image_stored_name TEXT"],
    ["image_mime", "ALTER TABLE products ADD COLUMN image_mime TEXT"],
    ["image_size", "ALTER TABLE products ADD COLUMN image_size INTEGER"]
  ]) if (!productColumns.includes(name)) db.exec(ddl);
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
    ["gst_number", "ALTER TABLE orders ADD COLUMN gst_number TEXT"]
  ]) if (!orderColumns.includes(name)) db.exec(ddl);
  db.exec("UPDATE orders SET status_updated_at = COALESCE(status_updated_at, created_at, CURRENT_TIMESTAMP)");
  db.prepare("INSERT OR IGNORE INTO coupons (code,type,value,min_total,active) VALUES (?,?,?,?,?)").run("WELCOME10", "percent", 10, 499, 1);
  db.prepare("INSERT OR IGNORE INTO coupons (code,type,value,min_total,active) VALUES (?,?,?,?,?)").run("PRINT100", "fixed", 100, 999, 1);
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

function couponFor(code, subtotal) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  const coupon = db.prepare("SELECT * FROM coupons WHERE code = ? AND active = 1").get(normalized);
  return coupon && subtotal >= coupon.min_total ? coupon : null;
}

function cartTotals(cart, postalCode = "", couponCode = "") {
  const coupon = couponFor(couponCode, cart.subtotal);
  const discount = coupon ? Math.min(cart.subtotal, coupon.type === "percent" ? Math.round(cart.subtotal * coupon.value / 100) : coupon.value) : 0;
  const delivery = shippingFee(cart.subtotal - discount, postalCode);
  return { subtotal: cart.subtotal, discount, delivery, total: Math.max(0, cart.subtotal - discount + delivery), coupon };
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

function cartData(sessionId) {
  const items = db.prepare(`
    SELECT ci.*, p.slug, p.name, p.color, p.category FROM cart_items ci
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
  return value ? `<div class="notice">${esc(value)}</div>` : "";
}

function nav(session, cart) {
  return `
    <div class="promise">Free delivery over ₹999 · Select products ready in 4 hours</div>
    <header class="site-header">
      <a class="brand" href="/" aria-label="PrintOasis home"><span>PRINT</span>OASIS<i>.</i></a>
      <form class="search" action="/products"><input name="q" placeholder="Search cards, stickers, signs…" aria-label="Search products"><button>Search</button></form>
      <nav class="header-actions">
        ${isAdmin(session) ? `<a href="/admin">Admin</a>` : ""}
        <a href="/help">Help</a>
        <a href="/track">Track</a>
        ${session.user ? `<a href="/wishlist">Wishlist</a>` : ""}
        ${session.user ? `<a href="/account">Hi, ${esc(session.user.name.split(" ")[0])}</a>` : `<a href="/login">Login</a>`}
        <a class="cart-link" href="/cart">Cart <b>${cart.count}</b></a>
        <button class="theme-toggle" type="button" aria-label="Toggle dark mode">Dark</button>
      </nav>
      <button class="menu-toggle" type="button" aria-label="Toggle menu">Menu</button>
    </header>
    <nav class="category-nav">
      <a href="/products">All products</a>
      ${categories.slice(0, 7).map(c => `<a href="/products?category=${c[0]}">${c[1]}</a>`).join("")}
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
    <main>${content}</main>
    <footer>
      <div><a class="brand light" href="/"><span>PRINT</span>OASIS<i>.</i></a><p>Ideas, made tangible.</p></div>
      <div><h4>Shop</h4><a href="/products">All products</a><a href="/products?category=same-day">Same-day prints</a><a href="/products?category=business-cards">Business cards</a></div>
      <div><h4>Support</h4><a href="/help">Help centre</a><a href="/account/orders">Track orders</a><a href="/contact">Contact us</a></div>
      <div><h4>For business</h4><a href="/business">Business solutions</a><a href="/contact">Bulk enquiries</a><a href="/products?category=packaging">Packaging</a></div>
      <p class="copyright">© ${new Date().getFullYear()} PrintOasis Print Services.</p>
    </footer>
    <script src="/public/app.js" defer></script>
  </body></html>`;
}

function productArt(product, large = false) {
  if (product.image_stored_name) {
    return `<div class="product-photo ${large ? "large" : ""}"><img src="/uploads/product-images/${encodeURIComponent(product.image_stored_name)}" alt="${esc(product.name)} mockup"></div>`;
  }
  return `<div class="product-art ${esc(product.color)} ${large ? "large" : ""}">
    <span class="art-sheet"></span><span class="art-mark">${esc(product.name.split(" ").map(w => w[0]).join("").slice(0, 2))}</span>
    <small>${esc(product.category.replace("-", " "))}</small>
  </div>`;
}

function productCard(product) {
  return `<article class="product-card">
    <a href="/product/${product.slug}">${productArt(product)}</a>
    <div class="product-meta"><span class="badge">${esc(product.badge)}</span><span>★ ${product.rating}</span></div>
    <h3><a href="/product/${product.slug}">${esc(product.name)}</a></h3>
    <p>From <strong>${money(product.price)}</strong> / ${product.min_qty === 1 ? "piece" : `${product.min_qty} pcs`}</p>
  </article>`;
}

function homePage(session, cart) {
  const featured = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY rating DESC LIMIT 8").all();
  return layout("Online printing made brilliantly simple", `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">PRINT THAT MEANS BUSINESS</span>
        <h1>Your big ideas deserve a <em>great finish.</em></h1>
        <p>From one custom tee to a complete brand rollout. Premium printing, transparent pricing and doorstep delivery across India.</p>
        <div class="hero-cta"><a class="button primary" href="/products">Start creating</a><a class="button ghost" href="/business">Business solutions</a></div>
        <div class="hero-proof"><span><b>4.8/5</b> customer rating</span><span><b>25k+</b> orders delivered</span><span><b>100%</b> quality checked</span></div>
      </div>
      <div class="hero-visual">
        <img src="/public/hero-print-studio.png" alt="Colorful printed cards, packaging, stickers and posters">
        <span class="delivery-stamp">4 HR<br><small>SELECT PRINTS</small></span>
      </div>
    </section>
    <section class="section">
      <div class="section-heading"><div><span class="eyebrow">FIND YOUR PRINT</span><h2>Shop by category</h2></div><a href="/products">See everything →</a></div>
      <div class="category-grid">${categories.map(c => `<a class="category-card" href="/products?category=${c[0]}"><span>${c[3]}</span><div><h3>${c[1]}</h3><p>${c[2]}</p></div><b>→</b></a>`).join("")}</div>
    </section>
    <section class="section tint">
      <div class="section-heading"><div><span class="eyebrow">CUSTOMER FAVOURITES</span><h2>Most loved prints</h2></div><a href="/products">View all →</a></div>
      <div class="product-grid">${featured.map(productCard).join("")}</div>
    </section>
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
  let sql = "SELECT * FROM products WHERE active = 1";
  const args = [];
  if (category) { sql += " AND category = ?"; args.push(category); }
  if (q) { sql += " AND (name LIKE ? OR description LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY rating DESC, name";
  const products = db.prepare(sql).all(...args);
  const categoryInfo = categories.find(c => c[0] === category);
  return layout(categoryInfo ? categoryInfo[1] : q ? `Search: ${q}` : "All products", `
    <section class="page-hero compact"><span class="eyebrow">PRINT SHOP</span><h1>${categoryInfo ? esc(categoryInfo[1]) : q ? `Results for “${esc(q)}”` : "All products"}</h1><p>${categoryInfo ? esc(categoryInfo[2]) : `${products.length} customizable products for work, events and gifting.`}</p></section>
    <section class="catalog section">
      <aside><h3>Categories</h3><a class="${!category ? "active" : ""}" href="/products">All products</a>${categories.map(c => `<a class="${category === c[0] ? "active" : ""}" href="/products?category=${c[0]}">${c[1]}</a>`).join("")}</aside>
      <div><div class="catalog-bar"><b>${products.length} products</b><span>Sorted by recommended</span></div>
      ${products.length ? `<div class="product-grid">${products.map(productCard).join("")}</div>` : `<div class="empty"><h2>No products found</h2><p>Try a broader search or explore all products.</p><a class="button primary" href="/products">Browse products</a></div>`}</div>
    </section>
  `, session, cart);
}

function productPage(product, session, cart) {
  const sizes = split(product.sizes), materials = split(product.materials), options = split(product.print_options);
  const reviews = db.prepare("SELECT * FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY id DESC LIMIT 6").all(product.id);
  const recommendations = db.prepare("SELECT * FROM products WHERE category = ? AND id != ? AND active = 1 ORDER BY rating DESC LIMIT 4").all(product.category, product.id);
  const wished = session.user ? db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(session.user.id, product.id) : null;
  return layout(product.name, `
    <section class="breadcrumbs"><a href="/">Home</a><span>/</span><a href="/products?category=${product.category}">${esc(categories.find(c => c[0] === product.category)?.[1] || "Products")}</a><span>/</span>${esc(product.name)}</section>
    <section class="product-detail">
      <div class="product-gallery">${productArt(product, true)}<div class="quality-note"><b>✓ Free artwork quality check</b><span>We review every file before printing.</span></div></div>
      <div class="product-config">
        <span class="badge">${esc(product.badge)}</span><h1>${esc(product.name)}</h1><div class="rating">★★★★★ <span>${product.rating} · Quality assured</span></div><p class="lead">${esc(product.description)}</p>
        <ul class="feature-list"><li>Low minimum order of ${product.min_qty}</li><li>Rich, calibrated color</li><li>Tracked delivery across India</li></ul>
        ${session.user ? `<form action="/wishlist/toggle" method="post" class="inline-action"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><button class="button ghost" type="submit">${wished ? "Remove from wishlist" : "Add to wishlist"}</button></form>` : `<a class="button ghost" href="/login?next=${encodeURIComponent(`/product/${product.slug}`)}">Login to save to wishlist</a>`}
        <form action="/cart/add" method="post" class="config-form" enctype="multipart/form-data">
          <input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}">
          <label>Size<select name="size">${sizes.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Material<select name="material">${materials.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Print / finish<select name="print_option">${options.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Quantity<input type="number" name="quantity" min="${product.min_qty}" step="${product.min_qty === 1 ? 1 : product.min_qty}" value="${product.min_qty}" required></label>
          <label class="full">Artwork notes <textarea name="artwork_note" rows="3" placeholder="Design link, file name, colors or special instructions"></textarea></label>
          <label class="full">Upload artwork <input class="artwork-input" type="file" name="artwork_file" accept=".pdf,.png,.ai,.psd,application/pdf,image/png"><small class="input-help">Accepted: PDF, PNG, AI, PSD up to 25 MB.</small><span class="artwork-preview"></span></label>
          <div class="price-box"><span>Starting total</span><strong data-unit-price="${product.price}">${money(product.price)}</strong><small>Inclusive of taxes · final price updates with quantity</small></div>
          <button class="button primary full" type="submit">Add to cart</button>
        </form>
      </div>
    </section>
    <section class="info-tabs section"><article><span>01</span><h3>Production-ready</h3><p>High-resolution print with automated and human quality checks.</p></article><article><span>02</span><h3>Need design help?</h3><p>Add notes to your order and our prepress team will contact you.</p></article><article><span>03</span><h3>Reliable delivery</h3><p>Estimated dispatch in 2–4 working days for standard products.</p></article></section>
    <section class="section reviews-section">
      <div class="section-heading"><div><span class="eyebrow">CUSTOMER REVIEWS</span><h2>Print confidence from real orders</h2></div></div>
      <div class="review-layout">
        <div class="reviews">${reviews.length ? reviews.map(r => `<article><b>${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</b><p>${esc(r.comment)}</p><small>${esc(r.name)} · ${new Date(r.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "medium" })}</small></article>`).join("") : `<div class="empty slim"><h3>No reviews yet</h3><p>Be the first to review this product.</p></div>`}</div>
        ${session.user ? `<form class="review-form" method="post" action="/reviews/add"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><h3>Leave a review</h3><label>Rating<select name="rating"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select></label><label>Comment<textarea name="comment" rows="4" required minlength="8"></textarea></label><button class="button primary" type="submit">Submit review</button></form>` : `<div class="empty slim"><h3>Want to review?</h3><p>Login after ordering to share feedback.</p><a class="button primary" href="/login">Login</a></div>`}
      </div>
    </section>
    ${recommendations.length ? `<section class="section tint"><div class="section-heading"><div><span class="eyebrow">SMART RECOMMENDATIONS</span><h2>Often ordered together</h2></div></div><div class="product-grid">${recommendations.map(productCard).join("")}</div></section>` : ""}
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
      <div>${cart.items.length ? cart.items.map(item => `<article class="cart-item">${productArt(item)}<div class="cart-copy"><h3><a href="/product/${item.slug}">${esc(item.name)}</a></h3><p>${esc(item.size)} · ${esc(item.material)} · ${esc(item.print_option)}</p>${item.artwork_note ? `<small>Artwork note: ${esc(item.artwork_note)}</small>` : ""}${item.artwork_original_name ? `<small>Uploaded file: ${esc(item.artwork_original_name)}</small>` : ""}</div><form action="/cart/update" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="item_id" value="${item.id}"><label>Qty<input name="quantity" type="number" min="0" value="${item.quantity}"></label><button>Update</button></form><strong>${money(item.quantity * item.unit_price)}</strong></article>`).join("") : `<div class="empty"><h2>Your cart is waiting for a great idea.</h2><p>Choose a product and customize it to get started.</p><a class="button primary" href="/products">Explore products</a></div>`}</div>
      ${cart.items.length ? `<aside class="order-summary"><h2>Order summary</h2><p><span>Subtotal</span><b>${money(totals.subtotal)}</b></p><p><span>Delivery estimate</span><b>${totals.delivery === 0 ? "FREE" : money(totals.delivery)}</b></p><p class="total"><span>Total</span><b>${money(totals.total)}</b></p><small>Taxes included. Exact shipping updates by PIN code at checkout.</small><a class="button primary" href="/checkout">Proceed to checkout</a><a href="/products">Continue shopping</a></aside>` : ""}
    </section>
  `, session, cart);
}

function checkoutPage(session, cart) {
  const razorpayReady = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
  const totals = cartTotals(cart);
  return layout("Checkout", `
    <section class="page-hero compact"><span class="eyebrow">SECURE CHECKOUT</span><h1>Delivery & payment</h1><p>Your order and payment are verified securely before production.</p></section>
    <section class="checkout-layout section">
      <form class="checkout-form" id="checkout-form" action="/checkout" method="post" data-razorpay-ready="${razorpayReady}" data-key-id="${esc(RAZORPAY_KEY_ID)}"><input type="hidden" name="csrf" value="${session.csrf}">
        <h2>Contact & delivery</h2>
        <div class="form-grid"><label>Full name<input name="customer_name" value="${esc(session.user.name)}" required></label><label>Phone number<input name="phone" inputmode="tel" pattern="[0-9 +()-]{8,18}" required></label><label class="full">Address<textarea name="address" required rows="3"></textarea></label><label>City<input name="city" required></label><label>PIN code<input name="postal_code" inputmode="numeric" pattern="[0-9]{6}" required></label><label>GST number <small class="input-help">Optional, shown on invoice.</small><input name="gst_number" maxlength="20"></label><label>Coupon code <small class="input-help">Try WELCOME10 or PRINT100.</small><input name="coupon_code" maxlength="24"></label></div>
        <div class="shipping-estimate" data-subtotal="${cart.subtotal}">Enter PIN code for exact shipping.</div>
        <h2>Payment</h2>
        ${razorpayReady ? `<label class="payment-option"><input type="radio" name="payment_method" value="razorpay" checked><span><b>Pay securely online</b><small>UPI, cards, netbanking and supported wallets via Razorpay.</small></span></label>` : `<div class="integration-note">Online payment activates after Razorpay keys are added. Cash on delivery remains available.</div>`}
        <label class="payment-option"><input type="radio" name="payment_method" value="cod" ${razorpayReady ? "" : "checked"}><span><b>Cash on delivery</b><small>Available for eligible orders.</small></span></label>
        <button class="button primary" type="submit">Place order · ${money(totals.total)}</button>
      </form>
      <aside class="order-summary"><h2>Your prints</h2>${cart.items.map(i => `<p><span>${esc(i.name)} × ${i.quantity}</span><b>${money(i.quantity * i.unit_price)}</b></p>`).join("")}<p><span>Delivery estimate</span><b>${totals.delivery === 0 ? "FREE" : money(totals.delivery)}</b></p><p class="total"><span>Total</span><b>${money(totals.total)}</b></p></aside>
    </section>
    ${razorpayReady ? `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>` : ""}
  `, session, cart);
}

function accountPage(url, session, cart) {
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").all(session.user.id);
  return layout("My account", `
    <section class="account-head"><div><span class="eyebrow">MY PRINTOASIS</span><h1>Hello, ${esc(session.user.name)}.</h1><p>${esc(session.user.email)}</p></div><form action="/logout" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><button class="button ghost">Log out</button></form></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a class="active" href="/account">Overview</a><a href="/account/orders">Orders</a><a href="/products">Start a new order</a></aside><div><div class="account-cards"><article><span>Orders</span><b>${orders.length}</b><a href="/account/orders">View history →</a></article><article><span>Saved email</span><b class="small">${esc(session.user.email)}</b><a href="/contact">Need help? →</a></article></div><h2>Recent orders</h2>${orderList(orders.slice(0, 3))}</div></section>
  `, session, cart);
}

function orderList(orders) {
  if (!orders.length) return `<div class="empty slim"><h3>No orders yet</h3><p>Your completed purchases will appear here.</p><a class="button primary" href="/products">Shop products</a></div>`;
  return `<div class="orders">${orders.map(o => `<article><div><span>${esc(o.order_number)}</span><small>${new Date(o.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "medium" })}</small></div><b class="status ${statusClass(o.status)}">${esc(o.status)}</b><strong>${money(o.total)}</strong><a class="button ghost" href="/invoice/${encodeURIComponent(o.order_number)}">GST invoice</a></article>`).join("")}</div>`;
}

function ordersPage(session, cart) {
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").all(session.user.id);
  return layout("Order history", `<section class="page-hero compact"><span class="eyebrow">MY ACCOUNT</span><h1>Order history</h1><p>Track every order from production to delivery.</p></section><section class="section narrow">${orderList(orders)}</section>`, session, cart);
}

function infoPage(kind, session, cart) {
  const pages = {
    help: ["Help centre", "Everything you need for a smooth print run.", [["How should I prepare artwork?", "Use a print-ready PDF at 300 DPI with 3 mm bleed. Add any special instructions on the product page."], ["Can I order a small quantity?", "Yes. Many products start at one piece; business print minimums are shown on each product page."], ["How quickly will my order arrive?", "Standard products dispatch in 2–4 working days. Select products offer same-day production in supported cities."], ["Can you help with my design?", "Yes. Add a design reference or note to your cart and our prepress team can assist before production."]]],
    contact: ["Talk to our print team", "Questions, bulk requirements or a delightfully unusual idea?", [["Customer support", "support@printoasis.example · +91 80 4567 8900"], ["Working hours", "Monday–Saturday · 9:00 AM–7:00 PM IST"], ["Bulk enquiries", "business@printoasis.example"]]],
    business: ["Print, managed for business", "One dependable partner for teams, locations and campaigns.", [["Brand consistency", "Central templates and controlled print specifications across every order."], ["Volume pricing", "Custom commercial rates for recurring and high-volume requirements."], ["Nationwide fulfilment", "Coordinate kits, stationery, signage and packaging across India."], ["Dedicated support", "A single account contact from quotation through delivery."]]]
  };
  const [title, subtitle, items] = pages[kind];
  return layout(title, `<section class="page-hero"><span class="eyebrow">${kind === "business" ? "BUSINESS SOLUTIONS" : "SUPPORT"}</span><h1>${title}</h1><p>${subtitle}</p>${kind === "business" ? `<a class="button primary" href="/contact">Request a business quote</a>` : ""}</section><section class="info-grid section">${items.map(i => `<article><h2>${i[0]}</h2><p>${i[1]}</p></article>`).join("")}</section>`, session, cart);
}

function adminTabs(active) {
  const tabs = [["/admin", "Dashboard"], ["/admin/products", "Products"], ["/admin/orders", "Orders"], ["/admin/notifications", "Notifications"]];
  return `<aside>${tabs.map(([href, label]) => `<a class="${active === label ? "active" : ""}" href="${href}">${label}</a>`).join("")}</aside>`;
}

function adminPage(title, active, body, session, cart) {
  return layout(title, `
    <section class="page-hero compact"><span class="eyebrow">ADMIN</span><h1>${esc(title)}</h1><p>Manage PrintOasis products, orders, statuses and customer operations.</p></section>
    <section class="account-layout admin-layout section">${adminTabs(active)}<div>${body}</div></section>
  `, session, cart);
}

function adminDashboardPage(session, cart) {
  const stats = {
    products: db.prepare("SELECT COUNT(*) count FROM products WHERE active = 1").get().count,
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    pending: db.prepare("SELECT COUNT(*) count FROM orders WHERE status != 'Delivered'").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total),0) total FROM orders").get().total
  };
  const statusCounts = db.prepare("SELECT status, COUNT(*) count FROM orders GROUP BY status ORDER BY count DESC").all();
  const recent = db.prepare("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 6").all();
  return adminPage("Operations dashboard", "Dashboard", `
    <div class="account-cards admin-stats">
      <article><span>Active products</span><b>${stats.products}</b><a href="/admin/products">Manage catalog</a></article>
      <article><span>Total orders</span><b>${stats.orders}</b><a href="/admin/orders">View orders</a></article>
      <article><span>Open jobs</span><b>${stats.pending}</b><a href="/admin/orders">Update status</a></article>
      <article><span>Revenue</span><b class="small">${money(stats.revenue)}</b><a href="/admin/orders">See sales</a></article>
    </div>
    <div class="admin-grid"><article><h2>Status pipeline</h2>${statusCounts.length ? statusCounts.map(s => `<p><span>${esc(s.status)}</span><b>${s.count}</b></p>`).join("") : "<p>No orders yet.</p>"}</article><article><h2>Recent orders</h2>${adminOrderRows(recent, session, false)}</article></div>
  `, session, cart);
}

function productForm(product, session) {
  const p = product || { id: "", slug: "", name: "", category: categories[0][0], price: 399, min_qty: 1, rating: 4.8, badge: "New", description: "", sizes: "", materials: "", print_options: "", color: "cobalt", active: 1 };
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
    <label class="check-row"><input type="checkbox" name="active" value="1" ${p.active ? "checked" : ""}> Active in storefront</label>
    <button class="button primary full" type="submit">${product ? "Save product" : "Create product"}</button>
  </form>`;
}

function adminProductsPage(url, session, cart) {
  const editId = Number(url.searchParams.get("edit") || 0);
  const editing = editId ? db.prepare("SELECT * FROM products WHERE id = ?").get(editId) : null;
  const products = db.prepare("SELECT * FROM products ORDER BY active DESC, category, name").all();
  return adminPage("Product manager", "Products", `
    <div class="section-heading compact-heading"><div><span class="eyebrow">CATALOG CRUD</span><h2>${editing ? `Edit ${esc(editing.name)}` : "Add product"}</h2></div></div>
    ${productForm(editing, session)}
    <div class="admin-table"><h2>All products</h2>${products.map(p => `<article><div>${productArt(p)}<span><b>${esc(p.name)}</b><small>${esc(p.category)} · ${money(p.price)} · min ${p.min_qty} · ${p.active ? "active" : "hidden"}</small></span></div><nav><a class="button ghost" href="/admin/products?edit=${p.id}">Edit</a><form method="post" action="/admin/products/delete"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${p.id}"><button class="button ghost" type="submit">Delete</button></form></nav></article>`).join("")}</div>
  `, session, cart);
}

function adminOrderRows(orders, session, editable = true) {
  if (!orders.length) return `<div class="empty slim"><h3>No orders yet</h3><p>Orders will appear here after checkout.</p></div>`;
  return `<div class="admin-orders">${orders.map(o => `<article><div><b>${esc(o.order_number)}</b><small>${esc(o.customer_name)} · ${esc(o.email || "")} · ${money(o.total)}</small><small>${esc(o.city)} ${esc(o.postal_code)} · ${new Date(o.created_at + "Z").toLocaleString("en-IN")}</small></div><span class="status ${statusClass(o.status)}">${esc(o.status)}</span>${editable ? `<form method="post" action="/admin/orders/status"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="order_id" value="${o.id}"><select name="status">${ORDER_STATUSES.map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select><input name="tracking_number" placeholder="Tracking #" value="${esc(o.tracking_number || "")}"><input name="note" placeholder="Internal/customer note"><button class="button primary" type="submit">Update</button></form><a class="button ghost" href="/invoice/${encodeURIComponent(o.order_number)}">Invoice</a>` : ""}</article>`).join("")}</div>`;
}

function adminOrdersPage(session, cart) {
  const orders = db.prepare("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC").all();
  return adminPage("Order manager", "Orders", `<p class="lead">Update statuses through Pending, Printing, Packed, Shipped and Delivered. Each change writes a timeline event and queues a customer notification.</p>${adminOrderRows(orders, session, true)}`, session, cart);
}

function adminNotificationsPage(session, cart) {
  const notifications = db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 60").all();
  return adminPage("Notification outbox", "Notifications", `<div class="admin-table">${notifications.length ? notifications.map(n => `<article><div><b>${esc(n.subject)}</b><small>${esc(n.event)} · ${esc(n.recipient)} · ${esc(n.status)}</small><small>${new Date(n.created_at + "Z").toLocaleString("en-IN")}</small></div></article>`).join("") : `<div class="empty slim"><h3>No notifications yet</h3><p>Order confirmations and status updates will appear here.</p></div>`}</div>`, session, cart);
}

function wishlistPage(session, cart) {
  const products = db.prepare(`SELECT p.* FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND p.active = 1 ORDER BY w.id DESC`).all(session.user.id);
  return layout("Wishlist", `<section class="page-hero compact"><span class="eyebrow">SAVED PRINTS</span><h1>Your wishlist</h1><p>Keep client favourites and repeat-order ideas close.</p></section><section class="section">${products.length ? `<div class="product-grid">${products.map(productCard).join("")}</div>` : `<div class="empty"><h2>No saved products yet</h2><p>Open a product and add it to your wishlist.</p><a class="button primary" href="/products">Browse products</a></div>`}</section>`, session, cart);
}

function statusTimeline(order) {
  const index = Math.max(0, ORDER_STATUSES.indexOf(order.status));
  return `<div class="status-timeline">${ORDER_STATUSES.map((s, i) => `<span class="${i <= index ? "done" : ""}">${esc(s)}</span>`).join("")}</div>`;
}

function trackPage(url, session, cart, result = null) {
  return layout("Track order", `<section class="page-hero compact"><span class="eyebrow">ORDER TRACKING</span><h1>Track your print order</h1><p>Enter your order number and phone number to see the current production stage.</p></section>${notice(url)}<section class="section narrow"><form class="track-form" method="post" action="/track"><input type="hidden" name="csrf" value="${session.csrf}"><label>Order number<input name="order_number" placeholder="PO-2026-123456" required></label><label>Phone number<input name="phone" required></label><button class="button primary" type="submit">Track order</button></form>${result ? `<div class="track-result"><h2>${esc(result.order_number)}</h2><b class="status ${statusClass(result.status)}">${esc(result.status)}</b>${statusTimeline(result)}<p>${result.tracking_number ? `Courier tracking: <b>${esc(result.tracking_number)}</b>` : "Tracking number will appear after dispatch."}</p></div>` : ""}</section>`, session, cart);
}

function invoicePage(order, items, session, cart) {
  const taxable = Math.round(order.total / 1.18);
  const gst = order.total - taxable;
  return layout(`Invoice ${order.order_number}`, `<section class="invoice section narrow"><div class="invoice-head"><div><span class="eyebrow">GST INVOICE</span><h1>${esc(order.order_number)}</h1><p>${new Date(order.created_at + "Z").toLocaleDateString("en-IN", { dateStyle: "long" })}</p></div><button class="button primary" onclick="window.print()">Print / Save PDF</button></div><div class="invoice-box"><h2>Bill to</h2><p>${esc(order.customer_name)}<br>${esc(order.address)}<br>${esc(order.city)} - ${esc(order.postal_code)}<br>Phone: ${esc(order.phone)}${order.gst_number ? `<br>GST: ${esc(order.gst_number)}` : ""}</p></div><table class="invoice-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.product_name)}<small>${esc(i.configuration)}</small></td><td>${i.quantity}</td><td>${money(i.unit_price)}</td><td>${money(i.quantity * i.unit_price)}</td></tr>`).join("")}</tbody></table><div class="invoice-totals"><p><span>Shipping</span><b>${money(order.shipping_fee || 0)}</b></p><p><span>Discount</span><b>${money(order.discount || 0)}</b></p><p><span>Taxable value</span><b>${money(taxable)}</b></p><p><span>GST included</span><b>${money(gst)}</b></p><p class="total"><span>Grand total</span><b>${money(order.total)}</b></p></div></section>`, session, cart);
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

async function queueNotification(orderId, event, recipient, subject, body) {
  const canSendSmtp = Boolean(nodemailer && SMTP_HOST);
  const result = db.prepare("INSERT INTO notifications (order_id,event,recipient,subject,body,status) VALUES (?,?,?,?,?,?)")
    .run(orderId, event, recipient, subject, body, canSendSmtp || EMAIL_WEBHOOK_URL ? "queued" : "logged");
  const notificationId = Number(result.lastInsertRowid);
  fs.writeFileSync(path.join(EMAIL_LOG_DIR, `${Date.now()}-${notificationId}.txt`), `To: ${recipient}\nFrom: ${EMAIL_FROM}\nSubject: ${subject}\n\n${body}`);
  if (canSendSmtp) {
    try {
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
      });
      await transporter.sendMail({ from: EMAIL_FROM, to: recipient, subject, text: body });
      db.prepare("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(notificationId);
    } catch (error) {
      db.prepare("UPDATE notifications SET status = ? WHERE id = ?").run(`failed:${error.message.slice(0, 80)}`, notificationId);
    }
    return;
  }
  if (!EMAIL_WEBHOOK_URL) return;
  try {
    const response = await fetch(EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: recipient, subject, text: body, event, orderId })
    });
    db.prepare("UPDATE notifications SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(response.ok ? "sent" : `failed:${response.status}`, notificationId);
  } catch (error) {
    db.prepare("UPDATE notifications SET status = ? WHERE id = ?").run(`failed:${error.message.slice(0, 80)}`, notificationId);
  }
}

async function notifyOrder(orderId, event, note = "") {
  const order = orderWithUser(orderId);
  if (!order) return;
  const subject = event === "order_confirmation" ? `PrintOasis order ${order.order_number} confirmed` : `PrintOasis order ${order.order_number}: ${order.status}`;
  const body = [
    `Hi ${order.customer_name},`,
    "",
    event === "order_confirmation" ? "Thanks for your order. We have received it and the print team will review your artwork before production." : `Your order status is now: ${order.status}.`,
    note ? `Note: ${note}` : "",
    order.tracking_number ? `Tracking number: ${order.tracking_number}` : "",
    "",
    `Order: ${order.order_number}`,
    `Total: ${money(order.total)}`,
    "Stages: Pending > Printing > Packed > Shipped > Delivered",
    "",
    "PrintOasis Print Services"
  ].filter(Boolean).join("\n");
  await queueNotification(order.id, event, order.email, subject, body);
}

function createLocalOrder(session, cart, data, paymentMethod, paymentId = null) {
  const totals = cartTotals(cart, data.postal_code, data.coupon_code);
  const orderNumber = `PO-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`;
  let orderId = null;
  db.exec("BEGIN");
  try {
    const result = db.prepare(`INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,shipping_fee,discount,coupon_code,gst_number,payment_method,payment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNumber, session.user.id, totals.total, "Pending", data.customer_name, data.phone, data.address, data.city, data.postal_code, totals.delivery, totals.discount, totals.coupon?.code || null, data.gst_number || null, paymentMethod, paymentId);
    orderId = Number(result.lastInsertRowid);
    const insertItem = db.prepare("INSERT INTO order_items (order_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?)");
    for (const item of cart.items) insertItem.run(orderId, item.name, item.quantity, item.unit_price, `${item.size} · ${item.material} · ${item.print_option}${item.artwork_original_name ? ` · Artwork: ${item.artwork_original_name}` : ""}`);
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
  accountPage,
  adminDashboardPage,
  adminNotificationsPage,
  adminOrdersPage,
  adminProductsPage,
  authPage,
  cartData,
  cartPage,
  cartTotals,
  checkoutPage,
  createLocalOrder,
  createRazorpayOrder,
  crypto,
  db,
  hashPassword,
  homePage,
  infoPage,
  invoicePage,
  isAdmin,
  layout,
  notifyOrder,
  ordersPage,
  parseCookies,
  productPage,
  productsPage,
  redirect,
  requestOrigin,
  requireAdmin,
  requireAuth,
  saveArtwork,
  saveProductImage,
  send,
  sendJson,
  serveProductImage,
  servePublic,
  slugify,
  trackPage,
  validCsrf,
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

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/public/")) {
      const file = path.join(ROOT, url.pathname);
      if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain");
      const ext = path.extname(file);
      const types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
      return send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
    }
    if (url.pathname.startsWith("/uploads/product-images/")) {
      const name = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
      const file = path.join(PRODUCT_IMAGE_DIR, name);
      if (!file.startsWith(PRODUCT_IMAGE_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain");
      const ext = path.extname(file).toLowerCase();
      const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
      return send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
    }
    const session = getSession(req, res);
    const cart = cartData(session.id);

    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok", "text/plain; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/search-suggestions") {
      const q = (url.searchParams.get("q") || "").trim();
      const suggestions = q
        ? db.prepare("SELECT name FROM products WHERE active = 1 AND (name LIKE ? OR description LIKE ?) ORDER BY rating DESC LIMIT 8").all(`%${q}%`, `%${q}%`).map(row => row.name)
        : ["Business Cards", "Flyers", "Stickers", "Posters", "T-shirts", "Photo Mugs"];
      return sendJson(res, 200, { suggestions });
    }
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, homePage(session, cart));
    if (req.method === "GET" && url.pathname === "/products") return send(res, 200, productsPage(url, session, cart));
    if (req.method === "GET" && url.pathname.startsWith("/product/")) {
      const product = db.prepare("SELECT * FROM products WHERE slug = ? AND active = 1").get(url.pathname.split("/").pop());
      return product ? send(res, 200, productPage(product, session, cart)) : send(res, 404, layout("Not found", `<div class="empty section"><h1>Product not found</h1><a href="/products">Browse products</a></div>`, session, cart));
    }
    if (req.method === "GET" && url.pathname === "/login") return session.user ? redirect(res, "/account") : send(res, 200, authPage("login", url, session, cart, requestOrigin(req)));
    if (req.method === "GET" && url.pathname === "/register") return session.user ? redirect(res, "/account") : send(res, 200, authPage("register", url, session, cart, requestOrigin(req)));
    if (req.method === "GET" && url.pathname === "/cart") return send(res, 200, cartPage(url, session, cart));
    if (req.method === "GET" && url.pathname === "/track") return send(res, 200, trackPage(url, session, cart));
    if (req.method === "GET" && url.pathname === "/wishlist") {
      if (!requireAuth(session, res, "/wishlist")) return;
      return send(res, 200, wishlistPage(session, cart));
    }
    if (req.method === "GET" && url.pathname.startsWith("/invoice/")) {
      if (!requireAuth(session, res, url.pathname)) return;
      const orderNumber = decodeURIComponent(url.pathname.split("/").pop() || "");
      const order = isAdmin(session)
        ? db.prepare("SELECT * FROM orders WHERE order_number = ?").get(orderNumber)
        : db.prepare("SELECT * FROM orders WHERE order_number = ? AND user_id = ?").get(orderNumber, session.user.id);
      if (!order) return send(res, 404, layout("Invoice not found", `<div class="empty section"><h1>Invoice not found</h1><a href="/account/orders">Back to orders</a></div>`, session, cart));
      const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
      return send(res, 200, invoicePage(order, items, session, cart));
    }
    if (req.method === "GET" && url.pathname === "/checkout") {
      if (!cart.items.length) return redirect(res, "/cart?notice=Your+cart+is+empty.");
      if (!requireAuth(session, res, "/checkout")) return;
      return send(res, 200, checkoutPage(session, cart));
    }
    if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/orders")) {
      if (!requireAuth(session, res, url.pathname)) return;
      return send(res, 200, url.pathname.endsWith("orders") ? ordersPage(session, cart) : accountPage(url, session, cart));
    }
    if (req.method === "GET" && url.pathname === "/admin/login") return session.user && isAdmin(session) ? redirect(res, "/admin") : send(res, 200, authPage("login", new URL("/login?next=/admin", requestOrigin(req)), session, cart, requestOrigin(req)));
    if (req.method === "GET" && url.pathname === "/admin") {
      if (!requireAdmin(session, res)) return;
      return send(res, 200, adminDashboardPage(session, cart));
    }
    if (req.method === "GET" && url.pathname === "/admin/products") {
      if (!requireAdmin(session, res)) return;
      return send(res, 200, adminProductsPage(url, session, cart));
    }
    if (req.method === "GET" && url.pathname === "/admin/orders") {
      if (!requireAdmin(session, res)) return;
      return send(res, 200, adminOrdersPage(session, cart));
    }
    if (req.method === "GET" && url.pathname === "/admin/notifications") {
      if (!requireAdmin(session, res)) return;
      return send(res, 200, adminNotificationsPage(session, cart));
    }
    if (req.method === "GET" && ["/help", "/contact", "/business"].includes(url.pathname)) return send(res, 200, infoPage(url.pathname.slice(1), session, cart));

    if (req.method === "POST") {
      const data = await requestData(req);
      if (url.pathname === "/auth/google") {
        const cookies = parseCookies(req);
        if (!data.g_csrf_token || !cookies.g_csrf_token || data.g_csrf_token !== cookies.g_csrf_token || !GOOGLE_CLIENT_ID) {
          return redirect(res, `/login?notice=${encodeURIComponent("Google sign-in could not be verified.")}`);
        }
        const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(data.credential || "")}`);
        const profile = await verification.json();
        if (!verification.ok || profile.aud !== GOOGLE_CLIENT_ID || profile.email_verified !== "true") {
          return redirect(res, `/login?notice=${encodeURIComponent("Google account verification failed.")}`);
        }
        let user = db.prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?").get(profile.sub, profile.email.toLowerCase());
        if (user) {
          db.prepare("UPDATE users SET google_sub = COALESCE(google_sub, ?) WHERE id = ?").run(profile.sub, user.id);
        } else {
          const result = db.prepare("INSERT INTO users (name,email,password_hash,google_sub) VALUES (?,?,?,?)")
            .run(profile.name || profile.email.split("@")[0], profile.email.toLowerCase(), hashPassword(crypto.randomBytes(32).toString("hex")), profile.sub);
          user = { id: Number(result.lastInsertRowid) };
        }
        db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(user.id, session.id);
        return redirect(res, "/account?notice=Signed+in+with+Google.");
      }
      if (!validCsrf(data, session)) return send(res, 403, "Invalid form token", "text/plain");
      if (url.pathname === "/register") {
        const name = (data.name || "").trim(), email = (data.email || "").trim().toLowerCase(), password = data.password || "";
        if (name.length < 2 || !email.includes("@") || password.length < 8) return redirect(res, `/register?notice=${encodeURIComponent("Please enter valid details. Password must be at least 8 characters.")}`);
        try {
          const result = db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run(name, email, hashPassword(password));
          db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(Number(result.lastInsertRowid), session.id);
          return redirect(res, data.next || "/account");
        } catch (error) {
          if (String(error).includes("UNIQUE")) return redirect(res, `/login?notice=${encodeURIComponent("An account with that email already exists.")}`);
          throw error;
        }
      }
      if (url.pathname === "/login") {
        const user = db.prepare("SELECT * FROM users WHERE email = ?").get((data.email || "").trim().toLowerCase());
        if (!user || !verifyPassword(data.password || "", user.password_hash)) return redirect(res, `/login?notice=${encodeURIComponent("Email or password is incorrect.")}&next=${encodeURIComponent(data.next || "/account")}`);
        db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(user.id, session.id);
        return redirect(res, data.next || "/account");
      }
      if (url.pathname === "/logout") {
        db.prepare("UPDATE sessions SET user_id = NULL WHERE id = ?").run(session.id);
        return redirect(res, "/");
      }
      if (url.pathname === "/track") {
        const order = db.prepare("SELECT * FROM orders WHERE order_number = ? AND phone = ?").get((data.order_number || "").trim().toUpperCase(), (data.phone || "").trim());
        return send(res, 200, order ? trackPage(url, session, cart, order) : trackPage(new URL("/track?notice=Order+not+found.", requestOrigin(req)), session, cart));
      }
      if (url.pathname === "/wishlist/toggle") {
        if (!requireAuth(session, res, "/wishlist")) return;
        const product = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
        if (!product) return redirect(res, "/products?notice=Product+not+found.");
        const existing = db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(session.user.id, product.id);
        if (existing) db.prepare("DELETE FROM wishlist_items WHERE id = ?").run(existing.id);
        else db.prepare("INSERT OR IGNORE INTO wishlist_items (user_id, product_id) VALUES (?, ?)").run(session.user.id, product.id);
        return redirect(res, `/product/${product.slug}?notice=${existing ? "Removed+from+wishlist." : "Added+to+wishlist."}`);
      }
      if (url.pathname === "/reviews/add") {
        if (!requireAuth(session, res, "/login")) return;
        const product = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
        if (!product) return redirect(res, "/products?notice=Product+not+found.");
        const rating = Math.max(1, Math.min(5, Number(data.rating) || 5));
        const comment = String(data.comment || "").trim().slice(0, 600);
        if (comment.length >= 8) db.prepare("INSERT INTO reviews (product_id,user_id,name,rating,comment) VALUES (?,?,?,?,?)").run(product.id, session.user.id, session.user.name, rating, comment);
        return redirect(res, `/product/${product.slug}?notice=Review+submitted.`);
      }
      if (url.pathname === "/admin/products/save") {
        if (!requireAdmin(session, res)) return;
        const image = saveProductImage(data.files?.product_image);
        const id = Number(data.id || 0);
        const name = String(data.name || "").trim();
        const slug = slugify(data.slug || name);
        if (!name || !slug) return redirect(res, "/admin/products?notice=Product+name+is+required.");
        const values = {
          slug,
          name,
          category: data.category,
          price: Math.max(1, Number(data.price) || 1),
          min_qty: Math.max(1, Number(data.min_qty) || 1),
          rating: Math.max(1, Math.min(5, Number(data.rating) || 4.8)),
          badge: String(data.badge || "").trim(),
          description: String(data.description || "").trim(),
          sizes: String(data.sizes || "").trim(),
          materials: String(data.materials || "").trim(),
          print_options: String(data.print_options || "").trim(),
          color: String(data.color || "cobalt").trim(),
          active: data.active === "1" ? 1 : 0
        };
        if (id) {
          const current = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
          if (!current) return redirect(res, "/admin/products?notice=Product+not+found.");
          db.prepare(`UPDATE products SET slug=?,name=?,category=?,price=?,min_qty=?,rating=?,badge=?,description=?,sizes=?,materials=?,print_options=?,color=?,active=?,image_original_name=?,image_stored_name=?,image_mime=?,image_size=? WHERE id=?`)
            .run(values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.active, image?.original || current.image_original_name, image?.stored || current.image_stored_name, image?.mime || current.image_mime, image?.size || current.image_size, id);
        } else {
          db.prepare(`INSERT INTO products (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color,active,image_original_name,image_stored_name,image_mime,image_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.active, image?.original || null, image?.stored || null, image?.mime || null, image?.size || null);
        }
        return redirect(res, "/admin/products?notice=Product+saved.");
      }
      if (url.pathname === "/admin/products/delete") {
        if (!requireAdmin(session, res)) return;
        db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(Number(data.id));
        return redirect(res, "/admin/products?notice=Product+hidden+from+storefront.");
      }
      if (url.pathname === "/admin/orders/status") {
        if (!requireAdmin(session, res)) return;
        const status = ORDER_STATUSES.includes(data.status) ? data.status : "Pending";
        const orderId = Number(data.order_id);
        const note = String(data.note || "").trim().slice(0, 400);
        const tracking = String(data.tracking_number || "").trim().slice(0, 80);
        db.prepare("UPDATE orders SET status = ?, tracking_number = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, tracking || null, orderId);
        db.prepare("INSERT INTO order_status_events (order_id,status,note) VALUES (?,?,?)").run(orderId, status, note);
        await notifyOrder(orderId, "status_update", note);
        return redirect(res, "/admin/orders?notice=Order+status+updated.");
      }
      if (url.pathname === "/cart/add") {
        const product = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
        if (!product) return send(res, 404, "Product not found", "text/plain");
        const artwork = saveArtwork(data.files?.artwork_file);
        const quantity = Math.max(product.min_qty, Number(data.quantity) || product.min_qty);
        db.prepare(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,artwork_note,artwork_original_name,artwork_stored_name,artwork_mime,artwork_size,unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(session.id, product.id, quantity, data.size, data.material, data.print_option, (data.artwork_note || "").slice(0, 500), artwork?.original || null, artwork?.stored || null, artwork?.mime || null, artwork?.size || null, product.price / product.min_qty);
        return redirect(res, "/cart?notice=Product+added+to+your+cart.");
      }
      if (url.pathname === "/cart/update") {
        const quantity = Number(data.quantity);
        if (quantity <= 0) db.prepare("DELETE FROM cart_items WHERE id = ? AND session_id = ?").run(Number(data.item_id), session.id);
        else db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?").run(quantity, Number(data.item_id), session.id);
        return redirect(res, "/cart");
      }
      if (url.pathname === "/payment/create") {
        if (!requireAuth(session, res, "/checkout")) return;
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return sendJson(res, 503, { error: "Online payment is not configured." });
        const freshCart = cartData(session.id);
        if (!freshCart.items.length) return sendJson(res, 400, { error: "Your cart is empty." });
        const totals = cartTotals(freshCart, data.postal_code, data.coupon_code);
        const razorpayOrder = await createRazorpayOrder(totals.total, `po_${Date.now()}`);
        return sendJson(res, 200, { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, keyId: RAZORPAY_KEY_ID });
      }
      if (url.pathname === "/payment/verify") {
        if (!requireAuth(session, res, "/checkout")) return;
        const signature = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET)
          .update(`${data.razorpay_order_id}|${data.razorpay_payment_id}`)
          .digest("hex");
        const receivedSignature = data.razorpay_signature || "";
        if (receivedSignature.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(receivedSignature))) {
          return redirect(res, `/checkout?notice=${encodeURIComponent("Payment verification failed. No order was created.")}`);
        }
        const freshCart = cartData(session.id);
        const orderNumber = createLocalOrder(session, freshCart, data, "razorpay", data.razorpay_payment_id);
        return redirect(res, `/account?notice=${encodeURIComponent(`Payment received. Order ${orderNumber} placed successfully.`)}`);
      }
      if (url.pathname === "/checkout") {
        if (!requireAuth(session, res, "/checkout")) return;
        const freshCart = cartData(session.id);
        if (!freshCart.items.length) return redirect(res, "/cart");
        if (data.payment_method !== "cod") return redirect(res, `/checkout?notice=${encodeURIComponent("Please complete the secure online payment window.")}`);
        const orderNumber = createLocalOrder(session, freshCart, data, "cod");
        return redirect(res, `/account?notice=${encodeURIComponent(`Order ${orderNumber} placed successfully.`)}`);
      }
    }
    send(res, 404, layout("Page not found", `<div class="empty section"><h1>That page missed the press.</h1><p>Let’s get you back to the print shop.</p><a class="button primary" href="/">Go home</a></div>`, session, cart));
  } catch (error) {
    console.error(error);
    send(res, 500, process.env.NODE_ENV === "test" ? error.stack : "Something went wrong. Please try again.", "text/plain");
  }
});

server.listen(PORT, () => console.log(`PrintOasis running at http://localhost:${PORT}`));
