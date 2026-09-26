const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createDatabaseFromEnv, runMigrations, databaseHealth } = require("./services/database");
const { createRedisService, requestLimitPolicies } = require("./services/redis");
const { URL } = require("node:url");
const { categories, products: catalogProducts, productPriorities } = require("./catalog");
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
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || "hello@printoasis.in").trim();
const SUPPORT_PHONE = (process.env.SUPPORT_PHONE || "+91 80 4567 8900").trim();
const OFFICE_ADDRESS = (process.env.OFFICE_ADDRESS || "Bengaluru, Karnataka, India").trim();
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_SECURE = process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const EMAIL_DELIVERY_ENABLED = process.env.EMAIL_DELIVERY_ENABLED !== "false" && process.env.NODE_ENV !== "test";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || (process.env.NODE_ENV === "production" ? "" : "admin@printoasis.example")).trim().toLowerCase();
const CONTACT_RECIPIENT = (process.env.CONTACT_RECIPIENT || ADMIN_EMAIL || SUPPORT_EMAIL).trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "PrintOasisAdmin123!");
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PRODUCT_IMAGE_DIR = path.join(UPLOAD_DIR, "product-images");
const IMAGE_LIBRARY_DIR = path.join(ROOT, "public", "assets", "images");
const PRODUCT_IMAGE_LIBRARY_DIR = path.join(IMAGE_LIBRARY_DIR, "products");
const CATEGORY_IMAGE_LIBRARY_DIR = path.join(IMAGE_LIBRARY_DIR, "categories");
const HOME_IMAGE_LIBRARY_DIR = path.join(IMAGE_LIBRARY_DIR, "home");
const EMAIL_LOG_DIR = path.join(DATA_DIR, "email-outbox");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
fs.mkdirSync(PRODUCT_IMAGE_LIBRARY_DIR, { recursive: true });
fs.mkdirSync(CATEGORY_IMAGE_LIBRARY_DIR, { recursive: true });
fs.mkdirSync(HOME_IMAGE_LIBRARY_DIR, { recursive: true });
fs.mkdirSync(EMAIL_LOG_DIR, { recursive: true });
const emailService = createEmailService({ enabled: EMAIL_DELIVERY_ENABLED, host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, user: SMTP_USER, pass: SMTP_PASS, from: EMAIL_FROM });
let db;
let redis;
const ORDER_STATUSES = ["Pending", "Printing", "Packed", "Shipped", "Delivered", "Cancelled"];
const ALLOWED_ARTWORK_EXTENSIONS = new Set([".pdf", ".png", ".ai", ".psd"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const PREFERRED_IMAGE_EXTENSIONS = [".webp", ".avif", ".jpg", ".jpeg", ".png"];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEEDED_STOCK = 1000;
let lastSessionCleanupAt = 0;
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);

function requestOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function initDb() {
  db = createDatabaseFromEnv();
  await runMigrations(db);
  await db.run("UPDATE products SET reserved = 0 WHERE reserved < 0");
  await db.run("UPDATE products SET status = 'hidden', active = 0 WHERE active = 0 AND status != 'hidden'");
  await db.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,?,?,?,?,?) ON CONFLICT (code) DO NOTHING", "WELCOME10", "percent", 10, 499, 499, 1);
  await db.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,?,?,?,?,?) ON CONFLICT (code) DO NOTHING", "PRINT100", "fixed", 100, 999, 999, 1);
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    await db.run(`INSERT INTO users (name,email,password_hash,is_admin) VALUES (?,?,?,1) ON CONFLICT (email) DO UPDATE SET is_admin = 1`, "PrintOasis Admin", ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));
  }
  await db.transaction(async tx => {
    await tx.run("DELETE FROM products WHERE name = ? OR name LIKE ?", "Ashish R", "Smoke Poster %");
    for (const product of catalogProducts) {
      await tx.run("UPDATE products SET stock = ? WHERE slug = ? AND stock <= 0 AND reserved = 0", DEFAULT_SEEDED_STOCK, product[0]);
      await tx.run(`
        INSERT INTO products (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (slug) DO UPDATE SET
          name=EXCLUDED.name, category=EXCLUDED.category, price=EXCLUDED.price,
          min_qty=EXCLUDED.min_qty, rating=EXCLUDED.rating, badge=EXCLUDED.badge,
          description=EXCLUDED.description, sizes=EXCLUDED.sizes,
          materials=EXCLUDED.materials, print_options=EXCLUDED.print_options,
          color=EXCLUDED.color
      `, ...product);
    }
  });
}

async function initRedis() {
  if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0) throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
  redis = createRedisService();
  await redis.connect();
}


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
const imageMimeType = extension => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" })[String(extension).toLowerCase()] || "application/octet-stream";

function publicImageUrl(file) {
  return `/public/assets/images/${file.split(path.sep).join("/").split("/").map(encodeURIComponent).join("/")}`;
}

function libraryImage(file, stem) {
  for (const extension of PREFERRED_IMAGE_EXTENSIONS) {
    const candidate = path.join(file, `${stem}${extension}`);
    if (fs.existsSync(candidate)) return { url: publicImageUrl(path.relative(IMAGE_LIBRARY_DIR, candidate)), source: "library", name: path.basename(candidate), alt: "" };
  }
  return null;
}

function libraryGalleryImages(product) {
  const directory = path.join(PRODUCT_IMAGE_LIBRARY_DIR, slugify(product.category), slugify(product.slug));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && PREFERRED_IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map(entry => ({
      name: entry.name,
      url: publicImageUrl(path.relative(IMAGE_LIBRARY_DIR, path.join(directory, entry.name))),
      source: "library",
      alt: ""
    }));
}

function productImageRecords(product) {
  return Array.isArray(product?.image_assets) ? product.image_assets : [];
}

function productImageSet(product) {
  const libraryDirectory = path.join(PRODUCT_IMAGE_LIBRARY_DIR, slugify(product.category), slugify(product.slug));
  const records = productImageRecords(product).map(image => ({
    ...image,
    name: image.image_stored_name,
    url: `/uploads/product-images/${encodeURIComponent(image.image_stored_name)}`,
    source: "upload",
    alt: ""
  }));
  const library = libraryGalleryImages(product);
  const libraryByStem = new Map(library.map(image => [path.basename(image.name, path.extname(image.name)).toLowerCase(), image]));
  const recordFor = (role, placement = "default") => records.find(image => image.role === role && image.placement === placement) || records.find(image => image.role === role && image.placement === "default");
  const legacy = product.image_stored_name ? { name: product.image_stored_name, url: `/uploads/product-images/${encodeURIComponent(product.image_stored_name)}`, source: "legacy", alt: "" } : null;
  const primary = libraryImage(libraryDirectory, "primary") || recordFor("primary") || legacy || records.find(image => image.role === "gallery") || libraryByStem.get("gallery-01") || library[0] || null;
  const hover = libraryImage(libraryDirectory, "hover") || recordFor("hover") || primary;
  const placements = Object.fromEntries(["hero", "card", "featured", "trending", "recommendation", "lifestyle"].map(placement => [
    placement,
    libraryImage(libraryDirectory, placement) || recordFor("primary", placement) || recordFor("gallery", placement) || primary
  ]));
  const gallery = [primary, ...library, ...records].filter(Boolean).filter((image, index, all) => all.findIndex(candidate => candidate.url === image.url) === index);
  return { primary, hover, gallery, ...placements };
}

function categoryImageSet(category) {
  const directory = path.join(CATEGORY_IMAGE_LIBRARY_DIR, slugify(category));
  return { hero: libraryImage(directory, "hero"), cover: libraryImage(directory, "cover"), featured: libraryImage(directory, "featured") };
}

function homeImage(stem, fallback) {
  return libraryImage(HOME_IMAGE_LIBRARY_DIR, stem)?.url || `/public/${fallback}`;
}

async function addProductImages(productId, images, role = "gallery", placement = "default", executor = db) {
  const files = (Array.isArray(images) ? images : [images]).filter(Boolean);
  if (!files.length) return;
  const max = await executor.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM product_images WHERE product_id = ?", productId);
  let sortOrder = Number(max.value) + 1;
  for (const image of files) await executor.run("INSERT INTO product_images (product_id,image_original_name,image_stored_name,image_mime,image_size,role,placement,sort_order) VALUES (?,?,?,?,?,?,?,?)", productId, image.original, image.stored, image.mime, image.size, role, placement, sortOrder++);
}

async function attachProductImages(products, executor = db) {
  if (!products.length) return products;
  const ids = products.map(product => product.id).filter(Boolean);
  if (!ids.length) return products;
  const rows = await executor.all(`SELECT * FROM product_images WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order, id`, ...ids);
  const byProduct = new Map();
  for (const row of rows) {
    const images = byProduct.get(row.product_id) || [];
    images.push(row);
    byProduct.set(row.product_id, images);
  }
  return products.map(product => ({ ...product, image_assets: byProduct.get(product.id) || [] }));
}const orderProductsByPriority = (products, category) => {
  const priority = new Map((productPriorities[category] || []).map((slug, index) => [slug, index]));
  return [...products].sort((left, right) => {
    const leftPriority = priority.get(left.slug) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.slug) ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || Number(right.rating || 0) - Number(left.rating || 0) || Number(left.id || 0) - Number(right.id || 0);
  });
};

function shippingFee(subtotal, postalCode = "") {
  if (subtotal >= 999) return 0;
  const pin = String(postalCode || "");
  return /^(11|40|41|56|57|60|70)/.test(pin) ? 99 : 149;
}

async function couponValidation(code, subtotal) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { coupon: null, error: "" };
  const coupon = await db.get("SELECT * FROM coupons WHERE code = ?", normalized);
  if (!coupon) return { coupon: null, error: "Coupon code is invalid." };
  if (!coupon.active) return { coupon: null, error: "This coupon is not active." };
  const expiryDate = coupon.expiry_date instanceof Date
    ? `${coupon.expiry_date.getFullYear()}-${String(coupon.expiry_date.getMonth() + 1).padStart(2, "0")}-${String(coupon.expiry_date.getDate()).padStart(2, "0")}`
    : coupon.expiry_date;
  if (expiryDate && expiryDate < new Date().toISOString().slice(0, 10)) return { coupon: null, error: "This coupon has expired." };
  if (coupon.usage_limit !== null && Number(coupon.times_used) >= Number(coupon.usage_limit)) return { coupon: null, error: "This coupon has reached its usage limit." };
  const minimumOrder = Number(coupon.minimum_order || coupon.min_total || 0);
  if (subtotal < minimumOrder) return { coupon: null, error: `This coupon requires an order of at least ${money(minimumOrder)}.` };
  return { coupon, error: "" };
}

async function couponFor(code, subtotal) { return (await couponValidation(code, subtotal)).coupon; }

async function cartTotals(cart, postalCode = "", couponCode = "") {
  const couponResult = await couponValidation(couponCode, cart.subtotal);
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
function productAvailable(product) { return Number(product?.stock || 0) - Number(product?.reserved || 0); }
function sellableQuantity(product) { return Math.max(0, productAvailable(product)); }

async function hasDeliveredPurchase(userId, productId) {
  return Boolean(await db.get(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.product_id = ? AND o.status = 'Delivered' LIMIT 1`, userId, productId));
}
async function defaultAddress(userId) { return db.get("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1", userId); }

async function addCartItem(sessionId, product, quantity, configuration, executor = db) {
  const requested = Math.max(1, Math.floor(Number(quantity) || product.min_qty));
  const available = productAvailable(product);
  if (available <= 0) throw new Error(`${product.name} is out of stock.`);
  if (requested > available) throw new Error(`Only ${sellableQuantity(product)} items available for ${product.name}.`);
  const reservation = await executor.run("UPDATE products SET reserved = reserved + ? WHERE id = ? AND reserved + ? <= stock", requested, product.id, requested);
  if (!reservation.changes) throw new Error(`Only ${sellableQuantity(product)} items available for ${product.name}.`);
  await executor.run(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,artwork_note,artwork_original_name,artwork_stored_name,artwork_mime,artwork_size,unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, sessionId, product.id, requested, configuration.size, configuration.material, configuration.printOption, configuration.artworkNote || null, configuration.artworkOriginalName || null, configuration.artworkStoredName || null, configuration.artworkMime || null, configuration.artworkSize || null, product.price / product.min_qty);
  return requested;
}

async function releaseReservedQuantity(productId, quantity, executor = db) {
  const amount = Math.max(0, Number(quantity) || 0);
  if (amount) await executor.run("UPDATE products SET reserved = GREATEST(0, reserved - ?) WHERE id = ?", amount, productId);
}

async function cleanupExpiredSessions(now = Date.now(), force = false) {
  if (!force && now - lastSessionCleanupAt < 60000) return;
  lastSessionCleanupAt = now;
  const expired = await db.all("SELECT id FROM sessions WHERE expires_at <= ?", now);
  for (const row of expired) {
    await releaseSessionReservations(row.id);
    await redis.deleteSession(row.id);
  }
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", now);
}

async function releaseSessionReservations(sessionId) {
  return db.transaction(async tx => {
    const items = await tx.all("SELECT product_id, quantity FROM cart_items WHERE session_id = ? FOR UPDATE", sessionId);
    const quantities = new Map();
    for (const item of items) quantities.set(item.product_id, (quantities.get(item.product_id) || 0) + Number(item.quantity));
    for (const [productId, quantity] of quantities) await releaseReservedQuantity(productId, quantity, tx);
    await tx.run("DELETE FROM cart_items WHERE session_id = ?", sessionId);
  });
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

async function getSession(req, res) {
  await cleanupExpiredSessions();
  const cookies = parseCookies(req);
  const now = Date.now();
  const anchor = cookies.sid && await db.get("SELECT id, expires_at FROM sessions WHERE id = ? AND expires_at > ?", cookies.sid, now);
  let session = anchor ? await redis.getSession(cookies.sid) : null;
  if (cookies.sid && (!anchor || !session || Number(session.expires_at) !== Number(anchor.expires_at) || Number(session.expires_at) <= now || session.id !== cookies.sid || typeof session.csrf !== "string")) {
    if (!anchor) await cleanupExpiredSessions(now, true);
    await releaseSessionReservations(cookies.sid);
    await redis.deleteSession(cookies.sid);
    await db.run("DELETE FROM sessions WHERE id = ?", cookies.sid);
    session = null;
  }
  if (!session) {
    const id = crypto.randomBytes(24).toString("hex");
    const csrf = crypto.randomBytes(18).toString("hex");
    const expiresAt = Date.now() + 30 * 86400000;
    await db.run("INSERT INTO sessions (id, csrf, expires_at) VALUES (?, ?, ?)", id, csrf, expiresAt);
    try { await redis.setSession({ id, user_id: null, csrf, expires_at: expiresAt }); }
    catch (error) { await db.run("DELETE FROM sessions WHERE id = ?", id); throw error; }
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = PUBLIC_BASE_URL.startsWith("https://") || forwardedProto === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    session = { id, user_id: null, csrf, expires_at: expiresAt };
  }
  const user = session.user_id ? await db.get("SELECT id,name,email,is_admin FROM users WHERE id = ?", session.user_id) : null;
  return { ...session, user };
}
async function updateSessionUser(sessionId, userId) {
  const current = await redis.getSession(sessionId);
  if (!current) throw new Error("Session is no longer valid.");
  const previousUserId = current.user_id || null;
  const next = { ...current, user_id: userId || null };
  const updated = await db.run("UPDATE sessions SET user_id = ? WHERE id = ? AND expires_at > ?", next.user_id, sessionId, Date.now());
  if (!updated.changes) throw new Error("Session is no longer valid.");
  try { await redis.setSession(next); }
  catch (error) {
    try { await db.run("UPDATE sessions SET user_id = ? WHERE id = ?", previousUserId, sessionId); } catch {}
    throw error;
  }
}

async function applyRateLimits(policies, res) {
  try {
    for (const policy of policies) {
      const result = await redis.incrementRateLimit(policy);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfter));
        send(res, 429, "Too many requests. Please try again later.", "text/plain; charset=utf-8");
        return false;
      }
    }
    return true;
  } catch {
    send(res, 503, "Service temporarily unavailable. Please try again shortly.", "text/plain; charset=utf-8");
    return false;
  }
}
function isAdmin(session) {
  return Boolean(session.user && session.user.is_admin);
}
async function generateInvoice(orderId) {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", orderId);
    if (!order) return;

    const items = await db.all("SELECT * FROM order_items WHERE order_id = ?", orderId);

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

async function cartData(sessionId) {
  const rows = await db.all(`SELECT ci.*, p.slug, p.name, p.color, p.category, p.stock, p.reserved, p.status, p.active FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? ORDER BY ci.id DESC`, sessionId);
  const items = await attachProductImages(rows);
  return { items, count: items.reduce((n, item) => n + item.quantity, 0), subtotal: items.reduce((n, item) => n + item.quantity * item.unit_price, 0) };
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
      if (name && filename) {
        const file = { filename, contentType, data: body };
        const existing = files[name];
        files[name] = existing ? (Array.isArray(existing) ? [...existing, file] : [existing, file]) : file;
      }
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

function saveProductImages(files) {
  return (Array.isArray(files) ? files : [files]).map(saveProductImage).filter(Boolean);
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

async function nav(session, cart) {
  const navigationProducts = await db.all(`SELECT id, name, slug, category, badge, rating FROM products WHERE ${visibleProductCondition()}`);
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
    products: orderProductsByPriority(productsByCategory.get(category[0]) || [], category[0])
  }));
  const megaMenu = (group, allProducts = false) => {
    const menuId = allProducts ? "all-products-menu" : `category-menu-${group.slug}`;
    const featured = group.products[0];
    const menuProducts = group.products.slice(0, 6);
    const content = allProducts
      ? `<div class="mega-menu-grid">${navigationGroups.map(item => `<section><h2><a href="/products?category=${encodeURIComponent(item.slug)}">${esc(item.name)}</a></h2>${item.products.length ? item.products.slice(0, 3).map(product => `<a href="/product/${encodeURIComponent(product.slug)}">${esc(product.name)}${product.badge ? `<small>${esc(product.badge)}</small>` : ""}</a>`).join("") : `<p class="mega-empty">New products coming soon.</p>`}</section>`).join("")}</div>`
      : `<div class="mega-category-content"><section class="mega-product-list"><p>${esc(group.description)}</p>${menuProducts.length ? menuProducts.map(product => `<a href="/product/${encodeURIComponent(product.slug)}">${esc(product.name)}${product.badge ? `<small>${esc(product.badge)}</small>` : ""}</a>`).join("") : `<p class="mega-empty">New products coming soon.</p>`}</section>${featured ? `<a class="mega-featured-product" href="/product/${encodeURIComponent(featured.slug)}"><span>FEATURED PRODUCT</span><b>${esc(featured.name)}</b><small>${featured.badge ? esc(featured.badge) : "Recommended"}</small><i>Explore &rarr;</i></a>` : ""}</div>`;
    const categoryHref = allProducts ? "/products" : `/products?category=${encodeURIComponent(group.slug)}`;
    const label = allProducts ? "All products" : esc(group.name);
    return `<div class="mega-nav-wrap"><a class="mega-nav-trigger" href="${categoryHref}" data-category="${esc(group.slug)}">${label}</a><button class="mega-nav-toggle" type="button" aria-label="Show ${label} menu" aria-expanded="false" aria-haspopup="true" aria-controls="${menuId}"><span aria-hidden="true">+</span></button><div class="mega-products-menu" id="${menuId}" role="region" aria-label="${label} menu" aria-hidden="true"><div class="mega-menu-heading"><span>${allProducts ? "SHOP BY CATEGORY" : esc(group.name.toUpperCase())}</span></div>${content}</div></div>`;
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

async function layout(title, content, session, cart, description = "Custom printing for business, events and everyday moments.") {
  return `<!doctype html>
  <html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${esc(description)}">
    <meta property="og:type" content="website"><meta property="og:title" content="${esc(title)} · PrintOasis"><meta property="og:description" content="${esc(description)}">
    <title>${esc(title)} · PrintOasis</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/public/styles.css">
  </head><body>
    ${await nav(session, cart)}
    <main id="main-content" tabindex="-1">${content}</main>
    <footer>
      <div><a class="brand light" href="/"><span>PRINT</span>OASIS<i>.</i></a><p>Premium print, made practical for teams, brands and everyday ideas.</p><a class="footer-contact" href="mailto:hello@printoasis.in">hello@printoasis.in</a></div>
      <div><h4>Shop</h4><a href="/products">All products</a><a href="/products?category=business-cards">Business cards</a><a href="/products?category=marketing">Marketing prints</a><a href="/products?category=same-day">Same-day prints</a></div>
      <div><h4>Help</h4><a href="/help">Help centre</a><a href="/faq">FAQ</a><a href="/shipping-policy">Shipping policy</a><a href="/returns">Returns & refunds</a><a href="/printing-guidelines">Printing guidelines</a><a href="/contact">Contact us</a></div>
      <div><h4>For business</h4><a href="/business">Business solutions</a><a href="/contact">Corporate orders</a><a href="/products?category=bulk">Bulk printing</a></div>
      <div><h4>Resources</h4><a href="/resources">Resources hub</a><a href="/printing-guidelines">Printing guidelines</a><a href="/help">Help centre</a><a href="/faq">FAQ</a><a href="/shipping-policy">Shipping policy</a><a href="/returns">Returns & refunds</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
      <p class="copyright">© ${new Date().getFullYear()} PrintOasis Print Services. Made for ideas worth sharing.</p>
    </footer>
    <script src="/public/app.js" defer></script>
  </body></html>`;
}

function productArt(product, large = false, placement = "card") {
  const images = productImageSet(product);
  const primary = images[placement] || images.primary;
  if (primary) {
    const hover = images.hover && images.hover.url !== primary.url ? images.hover : null;
    const loading = large ? "fetchpriority=high" : 'loading="lazy" decoding="async"';
    return `<div class="product-photo ${large ? "large" : ""}" data-product-image><img class="product-photo-primary" src="${esc(primary.url)}" alt="${esc(product.name)} mockup" width="1200" height="900" ${loading}>${hover ? `<img class="product-photo-hover" src="${esc(hover.url)}" alt="" width="1200" height="900" loading="lazy" decoding="async">` : ""}</div>`;
  }
  const categoryClass = String(product.category || "products").replace(/[^a-z0-9-]/gi, "");
  return `<div class="product-art art-${categoryClass} ${esc(product.color)} ${large ? "large" : ""}" role="img" aria-label="${esc(product.name)} product mockup">
    <span class="art-shadow"></span><span class="art-sheet"></span><span class="art-mark">${esc(product.name.split(" ").map(w => w[0]).join("").slice(0, 2))}</span>
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

function productCard(product, searchQuery = "", placement = "card") {
  const available = sellableQuantity(product);
  return `<article class="product-card">
    <a href="/product/${product.slug}">${productArt(product, false, placement)}</a>
    <div class="product-meta">${product.badge ? `<span class="badge">${esc(product.badge)}</span>` : ""}<span>★ ${product.rating}</span></div>
    <h3><a href="/product/${product.slug}">${highlightSearch(product.name, searchQuery)}</a></h3>
    <p>From <strong>${money(product.price)}</strong> / ${product.min_qty === 1 ? "piece" : `${product.min_qty} pcs`}${available <= 0 ? ` <span class="stock-note">Out of Stock</span>` : ""}</p>
    ${searchQuery ? `<small class="product-search-snippet">${highlightSearch(product.description, searchQuery)}</small>` : ""}
  </article>`;
}

function productGallery(product) {
  const images = productImageSet(product);
  if (!images.primary) return productArt(product, true, "hero");
  const gallery = images.gallery.length ? images.gallery : [images.primary];
  return `<div class="product-gallery-images" data-product-gallery><div class="product-photo large product-gallery-main" data-product-image><img class="product-photo-primary" src="${esc(images.hero?.url || images.primary.url)}" alt="${esc(product.name)} mockup" width="1600" height="1200" fetchpriority="high"></div>${gallery.length > 1 ? `<div class="product-gallery-thumbnails" aria-label="${esc(product.name)} image gallery">${gallery.map((image, index) => `<button type="button" class="${image.url === (images.hero?.url || images.primary.url) ? "is-active" : ""}" data-gallery-image data-image-src="${esc(image.url)}" data-image-alt="${esc(product.name)} product view ${index + 1}" aria-label="View ${esc(product.name)} image ${index + 1}" aria-current="${image.url === (images.hero?.url || images.primary.url) ? "true" : "false"}"><img src="${esc(image.url)}" alt="" width="120" height="90" loading="lazy" decoding="async"></button>`).join("")}</div>` : ""}</div>`;
}

async function homePage(session, cart) {
  const featured = await attachProductImages(await db.all(`SELECT * FROM products WHERE ${visibleProductCondition()} ORDER BY featured DESC, rating DESC LIMIT 8`));
  const categoryCounts = new Map((await db.all(`SELECT category, COUNT(*) AS count FROM products WHERE ${visibleProductCondition()} GROUP BY category`)).map(row => [row.category, row.count]));
  const testimonials = await db.all(`
    SELECT r.name, r.rating, r.comment, r.verified_purchase, p.name AS product_name
    FROM reviews r
    JOIN products p ON p.id = r.product_id
    WHERE r.approved = 1 AND ${visibleProductCondition("p")}
    ORDER BY r.id DESC
    LIMIT 6
  `);
  const homeStats = {
    orders: Number((await db.get("SELECT COUNT(*) AS count FROM orders WHERE status != 'Cancelled'")).count),
    customers: Number((await db.get("SELECT COUNT(*) AS count FROM users")).count),
    products: Number((await db.get(`SELECT COUNT(*) AS count FROM products WHERE ${visibleProductCondition()}`)).count),
    categories: categories.length
  };
  const heroSlides = [
    ["PREMIUM BUSINESS CARDS", "Leave a lasting first impression.", "Exceptionally finished cards with the weight, texture and precision your brand deserves.", "/products?category=business-cards", "Explore Business Cards", "hero-business", homeImage("hero-business-cards", "hero-business-cards.png"), "Premium PrintOasis business cards on a modern desk"],
    ["CUSTOM APPAREL", "Wear the work you are proud of.", "Turn team uniforms, event merchandise and everyday ideas into memorable custom apparel.", "/products?category=apparel", "Create Custom Apparel", "hero-apparel", homeImage("hero-custom-apparel", "hero-custom-apparel.png"), "PrintOasis branded premium hoodie and apparel"],
    ["MARKETING MATERIALS", "Make every campaign impossible to miss.", "Posters, flyers, folders and campaign materials, produced with rich colour and a crisp finish.", "/products?category=marketing", "Shop Marketing Prints", "hero-marketing", homeImage("hero-marketing-materials", "hero-marketing-materials.png"), "PrintOasis branded marketing materials and presentation folders"]
  ];
  return await layout("Online printing made brilliantly simple", `
    <section class="home-hero carousel-shell" data-carousel data-carousel-interval="4000" aria-label="PrintOasis promotions">
      <div class="carousel-track">${heroSlides.map((slide, index) => `<article class="hero-slide ${slide[5]} ${index === 0 ? "is-active" : ""}" aria-hidden="${index === 0 ? "false" : "true"}"><img src="/public/${slide[6]}" alt="${slide[7]}" ${index === 0 ? "fetchpriority=high" : 'loading="lazy" decoding="async"'}><div class="hero-slide-overlay"></div><div class="hero-copy"><span class="eyebrow">${slide[0]}</span><h1>${slide[1]}</h1><p>${slide[2]}</p><div class="hero-cta"><a class="button primary" href="${slide[3]}">${slide[4]}</a><a class="button ghost light-ghost" href="/products">All products</a></div></div></article>`).join("")}</div>
      <div class="carousel-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous promotion">&larr;</button><div class="carousel-dots" role="tablist" aria-label="Choose promotion">${heroSlides.map((_, index) => `<button type="button" role="tab" aria-label="Promotion ${index + 1}" aria-selected="${index === 0}" data-carousel-dot="${index}"></button>`).join("")}</div><button class="carousel-arrow next" type="button" aria-label="Next promotion">&rarr;</button></div>
      <a class="hero-scroll-indicator" href="#offers" aria-label="Scroll to current offers"><span></span>Scroll to discover</a>
    </section>
    <section class="home-offers section" id="offers" data-carousel data-carousel-interval="5500" aria-label="Current offers">
      <div class="section-heading"><div><span class="eyebrow">PRINT MORE, SAVE MORE</span><h2>Offers worth printing for</h2></div><a href="/products">Shop all offers &rarr;</a></div>
      <div class="offers-viewport"><div class="carousel-track offer-track">${[["BUSINESS CARD EDITION", "20% OFF", "Business Cards", "Premium finishes. Premium first impressions.", "business-cards", "Shop now", "350 GSM", "PREMIUM CARD"], ["DELIVERY BENEFIT", "FREE SHIPPING", "On orders above Rs. 999", "Fast delivery across India.", "products", "Explore", "PO", "DELIVERY BOX"], ["FOR BUSINESS", "UP TO 40% OFF", "Bulk Printing", "Perfect for businesses and corporate orders.", "business", "Get quote", "500+", "PRINT RUNS"], ["EXPRESS PRODUCTION", "SAME DAY", "Printing & Dispatch", "Selected products only.", "same-day", "Order now", "4 HRS", "SELECT ITEMS"]].map((offer, index) => `<article class="offer-card offer-${index + 1}" aria-hidden="${index === 0 ? "false" : "true"}"><span>${offer[0]}</span><h3>${offer[1]}</h3><h4>${offer[2]}</h4><p>${offer[3]}</p><a href="/${offer[4] === "products" ? "products" : offer[4] === "business" ? "business" : `products?category=${offer[4]}`}">${offer[5]} <span aria-hidden="true">&rarr;</span></a><div class="offer-mark" aria-hidden="true"><b>${offer[6]}</b><small>${offer[7]}</small></div></article>`).join("")}</div></div>
      <div class="carousel-controls compact-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous offer">&larr;</button><div class="carousel-dots" role="tablist" aria-label="Choose offer">${[0, 1, 2, 3].map(index => `<button type="button" role="tab" aria-label="Offer ${index + 1}" aria-selected="${index === 0}" data-carousel-dot="${index}"></button>`).join("")}</div><button class="carousel-arrow next" type="button" aria-label="Next offer">&rarr;</button></div>
    </section>
    <section class="section popular-categories reveal-on-scroll">
      <div class="section-heading"><div><span class="eyebrow">FIND YOUR PRINT</span><h2>Shop by category</h2></div><a href="/products">See everything →</a></div>
      <div class="category-grid">${categories.map(c => `<a class="category-card" href="/products?category=${c[0]}"><span>${c[3]}</span><div><h3>${c[1]}</h3><p>${c[2]}</p><small>${categoryCounts.get(c[0]) || 0} product${categoryCounts.get(c[0]) === 1 ? "" : "s"}</small></div><b>→</b></a>`).join("")}</div>
    </section>
    <section class="section tint featured-products reveal-on-scroll" data-product-carousel data-carousel-interval="8000">
      <div class="section-heading"><div><span class="eyebrow">CUSTOMER FAVOURITES</span><h2>Most loved prints</h2></div><a href="/products">View all →</a></div>
      <div class="product-carousel-viewport"><div class="product-grid product-carousel-track">${featured.map(product => productCard(product, "", "featured")).join("")}</div></div>
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

async function productsPage(url, session, cart) {
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
  if (q) { sql += " AND (name ILIKE ? OR description ILIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += sort === "price-asc" ? " ORDER BY price ASC, rating DESC" : sort === "price-desc" ? " ORDER BY price DESC, rating DESC" : sort === "newest" ? " ORDER BY id DESC" : " ORDER BY rating DESC, name";
  let products = await db.all(sql, ...args);
  const categoryInfo = categories.find(c => c[0] === category);
  if (categoryInfo && !q && sort === "recommended") products.splice(0, products.length, ...orderProductsByPriority(products, category));
  products = await attachProductImages(products);
  const categoryProduct = products[0];
  const categoryImages = categoryInfo ? categoryImageSet(category) : null;
  const whatsappUrl = `https://wa.me/${SUPPORT_PHONE.replace(/\D/g, "")}?text=${encodeURIComponent(`Hello PrintOasis, I would like help with ${categoryInfo ? categoryInfo[1] : "a custom print order"}.`)}`;
  const pageHero = categoryInfo
    ? `<section class="page-hero compact category-landing category-${esc(category)}"><div><span class="eyebrow">PRINTOASIS COLLECTION</span><h1>${esc(categoryInfo[1])}</h1><p>${esc(categoryInfo[2])}</p><div class="category-landing-actions"><a class="button primary" href="#catalog-results">Explore the collection</a><a class="button ghost whatsapp-cta" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer">Need a custom quantity? WhatsApp us</a></div></div><div class="category-landing-art">${categoryImages?.hero ? `<div class="product-photo category-cover" data-product-image><img class="product-photo-primary" src="${esc(categoryImages.hero.url)}" alt="${esc(categoryInfo[1])} collection" width="1200" height="675" loading="lazy" decoding="async"></div>` : categoryProduct ? productArt(categoryProduct, false, "hero") : ""}</div></section>`
    : `<section class="page-hero compact"><span class="eyebrow">PRINT SHOP</span><h1>${q ? `Results for “${esc(q)}”` : "All products"}</h1><p>${q ? "Browse professionally finished products for your next idea." : `${products.length} customizable products for work, events and gifting.`}</p></section>`;
  return await layout(categoryInfo ? categoryInfo[1] : q ? `Search: ${q}` : "All products", `
    ${pageHero}
    <section class="catalog section" id="catalog-results">
      <aside class="catalog-filters"><h3>Categories</h3><a class="${!category ? "active" : ""}" href="${productsUrl("")}"${!category ? ' aria-current="page"' : ""}>All products</a>${categories.map(c => `<a class="${category === c[0] ? "active" : ""}" href="${productsUrl(c[0])}"${category === c[0] ? ' aria-current="page"' : ""}>${c[1]}</a>`).join("")}</aside>
      <div><div class="catalog-bar"><div><span class="catalog-result-label">${q ? `Search results for “${esc(q)}”` : categoryInfo ? esc(categoryInfo[1]) : "All products"}</span><b>${products.length} product${products.length === 1 ? "" : "s"}</b></div><form class="catalog-sort" method="get" action="/products"><input type="hidden" name="q" value="${esc(q)}"><input type="hidden" name="category" value="${esc(category)}"><label>Sort by<select name="sort" onchange="this.form.submit()"><option value="recommended" ${sort === "recommended" ? "selected" : ""}>Recommended</option><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest</option><option value="price-asc" ${sort === "price-asc" ? "selected" : ""}>Price: low to high</option><option value="price-desc" ${sort === "price-desc" ? "selected" : ""}>Price: high to low</option></select></label><noscript><button class="button ghost" type="submit">Apply</button></noscript></form></div>
      ${products.length ? `<div class="product-grid">${products.map(product => productCard(product, q)).join("")}</div>` : `${emptyState("search", "That search needs a little more ink", "Try a product type, finish or occasion. You can also browse one of our popular collections.", "/products", "Continue shopping", "/help", "Get print help")}<div class="search-recovery"><b>Popular searches</b><div>${["Business Cards", "Flyers", "Stickers", "Photo Mugs"].map(item => `<a href="/products?q=${encodeURIComponent(item)}">${esc(item)}</a>`).join("")}</div></div><div class="search-category-shortcuts">${categories.slice(0, 5).map(item => `<a href="/products?category=${encodeURIComponent(item[0])}">${esc(item[1])}</a>`).join("")}</div>`}</div>
    </section>
  `, session, cart);
}

async function productPage(product, session, cart, url) {
  [product] = await attachProductImages([product]);
  const sizes = split(product.sizes), materials = split(product.materials), options = split(product.print_options);
  const available = productAvailable(product);
  const sellable = sellableQuantity(product);
  const defaultQuantity = sellable > 0 ? Math.min(Math.max(1, product.min_qty), sellable) : 0;
  const reviews = await db.all("SELECT * FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY id DESC LIMIT 6", product.id);
  const reviewSummaryRow = await db.get(`
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
  `, product.id);
  const reviewSummary = {
    ...reviewSummaryRow,
    count: Number(reviewSummaryRow.count) || 0,
    avg: reviewSummaryRow.avg === null ? null : Number(reviewSummaryRow.avg)
  };
  const stockState = sellable <= 0
    ? { kind: "out", label: "Out of stock" }
    : sellable <= Math.max(product.min_qty, 5)
      ? { kind: "low", label: `Low stock: ${sellable} available` }
      : { kind: "in", label: `In stock: ${sellable} available` };
  const recommendations = await attachProductImages(await db.all(`SELECT * FROM products WHERE category = ? AND id != ? AND ${visibleProductCondition()} ORDER BY rating DESC LIMIT 4`, product.category, product.id));
  const wished = session.user ? await db.get("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?", session.user.id, product.id) : null;
  const canReview = session.user ? await hasDeliveredPurchase(session.user.id, product.id) : false;
  return await layout(product.name, `
    <section class="breadcrumbs"><a href="/">Home</a><span>/</span><a href="/products?category=${product.category}">${esc(categories.find(c => c[0] === product.category)?.[1] || "Products")}</a><span>/</span>${esc(product.name)}</section>
    ${notice(url)}
    <section class="product-detail">
      <div class="product-gallery">${productGallery(product)}<div class="quality-note"><b>✓ Free artwork quality check</b><span>We review every file before printing.</span></div></div>
      <div class="product-config">
        ${product.badge ? `<span class="badge">${esc(product.badge)}</span>` : ""}<h1>${esc(product.name)}</h1><div class="rating"><span class="rating-stars" aria-label="${product.rating} out of 5 stars">★★★★★</span><span>${product.rating} · ${reviewSummary.count ? `${reviewSummary.count} review${reviewSummary.count === 1 ? "" : "s"}` : "No reviews yet"}</span></div><p class="lead">${esc(product.description)}</p>
        <ul class="feature-list"><li>Low minimum order of ${product.min_qty}</li><li>Rich, calibrated color</li><li>Tracked delivery across India</li></ul>
        ${session.user ? `<form action="/wishlist/toggle" method="post" class="inline-action"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><button class="button ghost wishlist-button" type="submit" aria-label="${wished ? "Remove from wishlist" : "Add to wishlist"}">${wished ? "♥ Saved" : "♡ Wishlist"}</button></form>` : `<a class="button ghost wishlist-button" href="/login?next=${encodeURIComponent(`/product/${product.slug}`)}">♡ Wishlist</a>`}
        <form id="product-config" action="/cart/add" method="post" class="config-form" enctype="multipart/form-data">
          <input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}">
          <label>Size<select name="size">${sizes.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Material<select name="material">${materials.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Print / finish<select name="print_option">${options.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>
          <label>Quantity<input type="number" name="quantity" min="1" step="1" max="${sellable}" value="${defaultQuantity || 1}" ${sellable <= 0 ? "disabled" : "required"}></label>
          <label class="full">Artwork notes <textarea name="artwork_note" rows="3" placeholder="Design link, file name, colors or special instructions"></textarea></label>
          <label class="full">Upload artwork <input class="artwork-input" type="file" name="artwork_file" accept=".pdf,.png,.ai,.psd,application/pdf,image/png"><small class="input-help">Accepted: PDF, PNG, AI, PSD up to 25 MB.</small><span class="artwork-preview"></span></label>
          <div class="price-box"><span>Starting total</span><strong data-unit-price="${product.price / product.min_qty}">${money(defaultQuantity ? defaultQuantity * product.price / product.min_qty : product.price)}</strong><small>${available <= 0 ? "Out of Stock" : `${sellable} available now`} · Inclusive of taxes</small><span class="stock-state ${stockState.kind}">${stockState.label}</span></div>
          ${available > 0
  ? `<button class="button primary full product-add-button" type="submit">Add to cart</button>`
  : `<button class="button full" type="button" disabled>Out of Stock</button>`}
        </form>
        <div class="mobile-cart-bar" aria-label="Quick add to cart"><span>From ${money(product.price)}</span><button class="button primary" form="product-config" type="submit" ${available <= 0 ? "disabled" : ""}>${available > 0 ? "Add to cart" : "Out of stock"}</button></div>
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
        <div class="reviews">${reviews.length ? reviews.map(r => `<article><b>${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</b><p>${esc(r.comment)}</p><small>${esc(r.name)} · ${new Date(r.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}${r.verified_purchase ? ` · <span class="verified-purchase">Verified Purchase</span>` : ""}</small></article>`).join("") : emptyState("review", "No reviews yet", "Verified customer feedback will appear here after delivery.", "/products", "Browse products", "/help", "Read FAQ")}</div>
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
    ${recommendations.length ? `<section class="section tint related-products" data-product-carousel><div class="section-heading"><div><span class="eyebrow">SMART RECOMMENDATIONS</span><h2>Often ordered together</h2></div><a href="/products?category=${encodeURIComponent(product.category)}">View category &rarr;</a></div><div class="product-carousel-viewport"><div class="product-grid product-carousel-track">${recommendations.map(item => productCard(item, "", "recommendation")).join("")}</div></div><div class="product-carousel-controls"><button class="carousel-arrow previous" type="button" aria-label="Previous related products">&larr;</button><button class="carousel-arrow next" type="button" aria-label="Next related products">&rarr;</button></div></section>` : ""}
  `, session, cart, product.description);
}

async function authPage(mode, url, session, cart, origin) {
  const login = mode === "login";
  return await layout(login ? "Login" : "Create account", `
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

async function cartPage(url, session, cart) {
  const totals = await cartTotals(cart);
  return await layout("Your cart", `
    <section class="page-hero compact"><span class="eyebrow">YOUR ORDER</span><h1>Shopping cart</h1><p>Review your print specifications before checkout.</p></section>
    ${notice(url)}
    <section class="cart-layout section">
      <div>${cart.items.length ? cart.items.map(item => `<article class="cart-item">${productArt(item)}<div class="cart-copy"><h3><a href="/product/${item.slug}">${esc(item.name)}</a></h3><p>${esc(item.size)} · ${esc(item.material)} · ${esc(item.print_option)}</p>${item.artwork_note ? `<small>Artwork note: ${esc(item.artwork_note)}</small>` : ""}${item.artwork_original_name ? `<small>Uploaded file: ${esc(item.artwork_original_name)}</small>` : ""}</div><form action="/cart/update" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="item_id" value="${item.id}"><label>Qty<input name="quantity" type="number" min="0" max="${item.quantity + sellableQuantity(item)}" value="${item.quantity}"></label><small>${item.quantity + sellableQuantity(item)} max available</small><button>Update</button></form><strong>${money(item.quantity * item.unit_price)}</strong></article>`).join("") : emptyState("cart", "Your cart is waiting.", "Choose a product and make it yours when the idea is ready.", "/products", "Browse products", "/help", "Need print help?")}</div>
      ${cart.items.length ? `<aside class="order-summary"><h2>Order summary</h2><p><span>Subtotal</span><b>${money(totals.subtotal)}</b></p><p><span>Delivery estimate</span><b>${totals.delivery === 0 ? "FREE" : money(totals.delivery)}</b></p><p class="total"><span>Total</span><b>${money(totals.total)}</b></p><small>Taxes included. Exact shipping updates by PIN code at checkout.</small><a class="button primary" href="/checkout">Proceed to checkout</a><a href="/products">Continue shopping</a></aside>` : ""}
    </section>
  `, session, cart);
}

async function checkoutPage(session, cart, url = new URL("/checkout", "http://localhost")) {
  const razorpayReady = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
  const savedAddress = await defaultAddress(session.user.id);
  const couponCode = String(url.searchParams.get("coupon_code") || "").trim().toUpperCase();
  const totals = await cartTotals(cart, savedAddress?.postal_code || "", couponCode);
  return await layout("Checkout", `
    <section class="page-hero compact"><span class="eyebrow">SECURE CHECKOUT</span><h1>Delivery & payment</h1><p>Your order and payment are verified securely before production.</p></section>
    ${notice(url)}
    <section class="checkout-layout section">
      <form class="checkout-form" id="checkout-form" action="/checkout" method="post" data-razorpay-ready="${razorpayReady}" data-key-id="${esc(RAZORPAY_KEY_ID)}"><input type="hidden" name="csrf" value="${session.csrf}">
        <h2>Contact & delivery</h2>
        ${savedAddress ? `<p class="saved-address-note">Using your default address: ${esc(savedAddress.label)}. <a href="/account/addresses">Manage addresses</a></p>` : `<p class="saved-address-note">Save delivery addresses from <a href="/account/addresses">your account</a> to prefill checkout.</p>`}
        <div class="form-grid"><label>Full name<input name="customer_name" value="${esc(savedAddress?.recipient_name || session.user.name)}" required></label><label>Phone number<input name="phone" value="${esc(savedAddress?.phone || "")}" inputmode="tel" pattern="[0-9 +()-]{8,18}" required></label><label class="full">Address<textarea name="address" required rows="3">${esc(savedAddress?.address || "")}</textarea></label><label>City<input name="city" value="${esc(savedAddress?.city || "")}" required></label><label>PIN code<input name="postal_code" value="${esc(savedAddress?.postal_code || "")}" inputmode="numeric" pattern="[0-9]{6}" required></label><label>GST number <small class="input-help">Optional, shown on invoice.</small><input name="gst_number" maxlength="20"></label><label>Coupon code <small class="input-help">Try WELCOME10 or PRINT100.</small><input name="coupon_code" value="${esc(couponCode)}" maxlength="24"></label></div>
        <button class="button ghost coupon-apply" type="submit" formmethod="get" formaction="/checkout" formnovalidate>Apply coupon</button>
        ${totals.couponError ? `<p class="form-error">${esc(totals.couponError)}</p>` : totals.coupon ? `<p class="form-success"><b>${esc(totals.coupon.code)}</b> applied. You save ${money(totals.discount)}. <button class="copy-control" type="button" data-copy-value="${esc(totals.coupon.code)}" data-copy-label="Coupon code">Copy code</button></p>` : ""}
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

async function accountPage(url, session, cart) {
  const orders = await db.all("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", session.user.id);
  return await layout("My account", `
    <section class="account-head"><div><span class="eyebrow">MY PRINTOASIS</span><h1>Hello, ${esc(session.user.name)}.</h1><p>${esc(session.user.email)}</p></div><form action="/logout" method="post"><input type="hidden" name="csrf" value="${session.csrf}"><button class="button ghost">Log out</button></form></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a class="active" href="/account">Overview</a><a href="/account/orders">Orders</a><a href="/account/addresses">Addresses</a><a href="/account/password">Security</a><a href="/products">Start a new order</a></aside><div><div class="account-cards"><article><span>Orders</span><b>${orders.length}</b><a href="/account/orders">View history →</a></article><article><span>Saved email</span><b class="small">${esc(session.user.email)}</b><a href="/account/addresses">Manage addresses →</a></article></div><h2>Recent orders</h2>${orderList(orders.slice(0, 3), session)}</div></section>
  `, session, cart);
}

async function addressesPage(url, session, cart) {
  const editId = Number(url.searchParams.get("edit") || 0);
  const addresses = await db.all("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", session.user.id);
  const editing = editId ? addresses.find(address => address.id === editId) : null;
  const address = editing || { id: "", label: "Home", recipient_name: session.user.name, phone: "", address: "", city: "", postal_code: "", is_default: !addresses.length };
  return await layout("Saved addresses", `
    <section class="page-hero compact"><span class="eyebrow">MY ACCOUNT</span><h1>Saved addresses</h1><p>Keep delivery details ready for a faster checkout.</p></section>
    ${notice(url)}
    <section class="account-layout section"><aside><a href="/account">Overview</a><a href="/account/orders">Orders</a><a class="active" href="/account/addresses">Addresses</a><a href="/account/password">Security</a><a href="/products">Start a new order</a></aside><div><form class="account-form" method="post" action="/account/addresses/save"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${address.id}"><h2>${editing ? "Edit address" : "Add address"}</h2><div class="form-grid"><label>Label<input name="label" value="${esc(address.label)}" maxlength="40" required></label><label>Recipient name<input name="recipient_name" value="${esc(address.recipient_name)}" required></label><label>Phone<input name="phone" value="${esc(address.phone)}" inputmode="tel" pattern="[0-9 +()-]{8,18}" required></label><label>PIN code<input name="postal_code" value="${esc(address.postal_code)}" inputmode="numeric" pattern="[0-9]{6}" required></label><label class="full">Address<textarea name="address" rows="3" required>${esc(address.address)}</textarea></label><label>City<input name="city" value="${esc(address.city)}" required></label><label class="check-row"><input type="checkbox" name="is_default" value="1" ${address.is_default ? "checked" : ""}>Use as default delivery address</label></div><button class="button primary" type="submit">${editing ? "Save address" : "Add address"}</button></form><div class="address-list">${addresses.length ? addresses.map(item => `<article><div><b>${esc(item.label)}${item.is_default ? " · Default" : ""}</b><p>${esc(item.recipient_name)} · ${esc(item.phone)}<br>${esc(item.address)}, ${esc(item.city)} ${esc(item.postal_code)}</p></div><nav><a class="button ghost" href="/account/addresses?edit=${item.id}">Edit</a>${item.is_default ? "" : `<form method="post" action="/account/addresses/default"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${item.id}"><button class="button ghost">Set default</button></form>`}<form method="post" action="/account/addresses/delete" onsubmit="return confirm('Delete this saved address?');"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${item.id}"><button class="button ghost">Delete</button></form></nav></article>`).join("") : `<div class="empty slim"><h3>No saved addresses yet</h3><p>Add one to prefill checkout.</p></div>`}</div></div></section>
  `, session, cart);
}

async function passwordPage(url, session, cart) {
  return await layout("Account security", `
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
        <div class="order-card-summary"><span>${esc(order.order_number)} <button class="copy-control" type="button" data-copy-value="${esc(order.order_number)}" data-copy-label="Order ID">Copy</button></span><small>Placed ${new Date(order.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}</small></div>
        <b class="status ${statusClass(order.status)}">${esc(order.status)}</b>
        <small class="order-card-total">${money(order.total)} · ${order.status === "Delivered" ? "Completed" : "In progress"}</small>
        <a class="button ghost" href="/account/orders/${order.id}">View Details →</a>
        ${session ? `<form method="post" action="/account/orders/reorder"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="order_id" value="${order.id}"><button class="button ghost" type="submit">Reorder</button></form>` : ""}
      </article>
    `).join("")}
  </div>`;
}

async function ordersPage(session, cart, url) {
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ORDER_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const where = ["o.user_id = ?"];
  const params = [session.user.id];
  if (status) { where.push("o.status = ?"); params.push(status); }
  if (query) {
    where.push("(o.order_number ILIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name ILIKE ?))");
    params.push(`%${query}%`, `%${query}%`);
  }
  const orders = await db.all(`SELECT o.* FROM orders o WHERE ${where.join(" AND ")} ORDER BY o.id DESC`, ...params);

  return await layout(
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

async function orderDetailsPage(order, session, cart) {
  const items = await db.all(`SELECT oi.*, p.slug FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`, order.id);

  const reviewByProductId = new Map();
  if (items.length) {
    const reviewRows = await db.all(`SELECT id, product_id, rating, comment FROM reviews WHERE user_id = ? AND product_id IN (${items.map(() => "?").join(",")})`, session.user.id, ...items.map(item => item.product_id));
    for (const review of reviewRows) reviewByProductId.set(review.product_id, review);
  }
  for (const item of items) item.review = reviewByProductId.get(item.product_id) || null;

  return await layout(
    `Order ${order.order_number}`,
    `<section class="page-hero compact">
      <span class="eyebrow">MY ACCOUNT</span>
      <h1>${esc(order.order_number)} <button class="copy-control" type="button" data-copy-value="${esc(order.order_number)}" data-copy-label="Order ID">Copy order ID</button></h1>
      <p>${new Date(order.created_at).toLocaleDateString("en-IN", { dateStyle: "long" })}</p>
    </section>

    <section class="section narrow order-details">
      <header class="order-detail-header"><div><span class="eyebrow">ORDER STATUS</span><h2>${esc(order.status)}</h2><p>Order total <strong>${money(order.total)}</strong></p></div><b class="status ${statusClass(order.status)}">${esc(order.status)}</b></header>

      <section class="shipment-panel"><div><span class="panel-label">Shipment timeline</span><h3>${order.status === "Delivered" ? "Delivered to your address" : "Your order is moving through production"}</h3></div>${statusTimeline(order)}</section>

      <div class="order-information-grid">
        <article><span class="panel-label">Delivery address</span><p>${esc(order.customer_name)}<br>${esc(order.address)}<br>${esc(order.city)} - ${esc(order.postal_code)}<br><a href="tel:${encodeURIComponent(order.phone)}">${esc(order.phone)}</a></p></article>
        <article><span class="panel-label">Payment summary</span><p><strong>${money(order.total)}</strong><br>${esc(order.payment_id ? "Payment confirmed" : "Payment details recorded")}<br>Placed ${new Date(order.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}</p></article>
        <article class="tracking-information"><span class="panel-label">Tracking</span>${order.courier_name || order.tracking_number || order.estimated_delivery ? `<p>${order.courier_name ? `<strong>${esc(order.courier_name)}</strong><br>` : ""}${order.tracking_number ? `<code>${esc(order.tracking_number)}</code> <button class="copy-control" type="button" data-copy-value="${esc(order.tracking_number)}" data-copy-label="Tracking number">Copy</button><br>` : ""}${order.estimated_delivery ? `Estimated delivery: ${new Date(order.estimated_delivery).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}</p>` : `<p>Tracking details will appear when your order is dispatched.</p>`}${order.tracking_url ? `<a class="button primary" href="${esc(order.tracking_url)}" target="_blank" rel="noopener">Track package</a>` : ""}</article>
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

async function infoPage(kind, session, cart, url = new URL("/", "http://localhost")) {
  if (kind === "resources") {
    const groups = [
      ["Getting started", [["HC", "Help centre", "Practical guidance for placing, managing and understanding print orders.", "/help"], ["FAQ", "Frequently asked questions", "Fast answers on artwork, payment, delivery, invoices and more.", "/faq"]]],
      ["Printing resources", [["300", "Printing guidelines", "Prepare files, colours, bleed and layouts for better press results.", "/printing-guidelines"]]],
      ["Orders & delivery", [["TRK", "Shipping policy", "Production, delivery options, tracking and same-day eligibility.", "/shipping-policy"], ["R&R", "Returns & refunds", "Support for damaged, defective or incorrectly printed work.", "/returns"]]],
      ["Legal", [["P", "Privacy policy", "How we collect, use and protect account and order information.", "/privacy"], ["T&C", "Terms & conditions", "Clear expectations for site use, orders, artwork and cancellation.", "/terms"]]],
      ["Business", [["B2B", "Business solutions", "Corporate printing, recurring orders, fulfilment and quotations.", "/business"]]],
      ["Support", [["PO", "Contact us", "Speak to the PrintOasis team about support or a custom print brief.", "/contact"]]]
    ];
    const content = `<section class="page-hero trust-hero resources-hero"><span class="eyebrow">PRINTOASIS RESOURCES</span><h1>Everything you need to print with confidence</h1><p>Find practical print advice, clear policies and the right route to support before, during and after your order.</p></section><div class="section resources-section">${groups.map(([heading, cards]) => `<section class="resource-group" aria-labelledby="resource-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}"><div class="resource-heading"><span class="eyebrow">${esc(heading)}</span><h2 id="resource-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}">${esc(heading)}</h2></div><div class="resource-grid">${cards.map(([icon, title, description, href]) => `<a class="resource-card" href="${href}"><span class="resource-icon" aria-hidden="true">${esc(icon)}</span><span><b>${esc(title)}</b><small>${esc(description)}</small></span><i aria-hidden="true">→</i></a>`).join("")}</div></section>`).join("")}</div>`;
    return await layout("Resources", content, session, cart, "PrintOasis guidance, policies, printing advice and support resources in one place.");
  }
  const pages = {
    help: { eyebrow: "HELP CENTRE", title: "Helpful answers for every print order", description: "Clear guidance on ordering, artwork, delivery and managing your PrintOasis account.", sections: [["Ordering", "Choose a product, select the size, stock and finish, then upload artwork or add a clear production note before checkout."], ["Payments", "Secure online payments are handled at checkout. Your order confirmation and invoice remain available from My Orders."], ["Shipping", "Production begins after artwork checks. Once dispatched, the courier, tracking number and estimated delivery date appear on your order."], ["Returns", "Because every order is made to specification, we review damaged, defective or incorrectly printed items individually. See our Returns & Refund Policy for details."], ["Custom printing", "Need something outside the listed options? Share the finished size, quantity, material and delivery location with our business team."], ["Artwork upload", "Upload PDF, PNG, AI or PSD files. A press-ready PDF is usually the fastest route to production."], ["Invoices", "Download a GST-ready invoice from the relevant order after it has been placed."], ["Coupons", "Enter one valid code at checkout. Coupons cannot be combined and may exclude selected products or delivery charges."], ["Accounts", "Use My Account to manage addresses, passwords, orders, saved products and reviews."], ["Reviews", "Reviews open after a delivered order and help other customers make confident print choices."]], links: [["Read the FAQ", "/faq"], ["Printing guidelines", "/printing-guidelines"], ["Talk to support", "/contact"]] },
    shipping: { eyebrow: "SHIPPING POLICY", title: "From approved artwork to your doorstep", description: "How PrintOasis processes, produces and delivers made-to-order print across India.", sections: [["Order processing", "Orders are reviewed for payment, artwork and production details before being released to print. We may contact you where a supplied file or specification needs clarification."], ["Production time", "Most standard products move into production within 1–2 working days after artwork approval. Complex finishes, large quantities and bespoke products may require additional production time."], ["Standard delivery", "Standard delivery is available to serviceable Indian PIN codes after production is complete. Transit time varies by destination, courier capacity and local conditions."], ["Express delivery", "Express options appear at checkout only where the product, production schedule and delivery PIN code are eligible. Selecting express shipping does not shorten artwork review requirements."], ["Same-day printing eligibility", "Same-day production is available only on selected products, before the displayed cut-off time, with print-ready artwork and in supported service areas. Dispatch timing is confirmed at checkout."], ["Shipping charges", "Delivery charges are calculated at checkout from the destination, package size and service selected. Any applicable charge is shown before payment."], ["Free shipping", "Eligible orders above the advertised threshold receive standard delivery at no additional cost. Oversized, remote-area or expedited shipments may be excluded and are clearly priced before checkout."], ["Delivery partners", "We work with established courier partners selected for coverage, handling quality and tracking visibility. A courier may change when it improves serviceability for your order."], ["Order tracking", "When your order is shipped, we add the courier, tracking number and tracking link to My Orders and send a shipping update where email delivery is configured."], ["Delivery delays", "Weather, carrier disruption, public holidays, remote-area routing and incomplete delivery details can affect transit. We will help investigate a delayed tracked shipment."], ["International shipping", "PrintOasis currently serves delivery addresses within India. International orders are not available through the standard checkout at this time."], ["Contact support", "For a delivery query, keep your order number handy and contact our support team. We will coordinate with the courier where appropriate."]], links: [["Track an order", "/track"], ["Returns & refunds", "/returns"], ["Contact support", "/contact"]] },
    returns: { eyebrow: "RETURNS & REFUNDS", title: "Fair support for work that misses the mark", description: "Our approach to replacements, cancellations and refunds for made-to-order print.", sections: [["Return eligibility", "Please inspect your delivery promptly. Contact us within 48 hours of delivery with your order number, photographs of the issue and the outer packaging where relevant."], ["Customised products", "Custom-printed products are made specifically for you and generally cannot be returned for a change of mind, incorrect customer-supplied content, colour expectations from an uncalibrated screen or a change in requirements."], ["Damaged product replacement", "If an item is damaged in transit or has a material production defect, our team will review the evidence and may arrange a replacement, reprint or other suitable resolution."], ["Wrong item received", "If the delivered product does not match the approved specification or your order confirmation, contact us promptly. Do not dispose of the item until we have reviewed the case."], ["Refund timeline", "Approved refunds are initiated after our review and typically reflect in the original payment method within 5–10 business days, subject to your payment provider or bank."], ["Cancellation policy", "You may request cancellation before production begins. Once artwork is approved and a job has entered printing, cancellation or a full refund may not be possible because materials and press time are committed."], ["Refund method", "Refunds are made to the original payment method where possible. We do not provide cash refunds for online payments."], ["Contact support", "Include your order number, issue description and clear photographs so we can resolve the request efficiently."]], links: [["Shipping policy", "/shipping-policy"], ["Contact support", "/contact"], ["Read the FAQ", "/faq"]] },
    privacy: { eyebrow: "PRIVACY POLICY", title: "Your information, handled with care", description: "How PrintOasis uses, protects and gives you control over personal information.", sections: [["Information collected", "We collect information you provide when you browse, register, place an order, upload artwork, contact us or use account features."], ["Account information", "This may include your name, email address, phone number, saved addresses, password hash and account preferences needed to operate your account."], ["Payment information", "Payments are processed by our payment partners. PrintOasis does not store complete card details or banking credentials on its application servers."], ["Cookies", "We use essential cookies to keep sessions, carts and preferences working. Browser controls can restrict cookies, but some storefront functions may no longer operate correctly."], ["Analytics", "We may use aggregated usage information to understand site performance, improve navigation and measure the usefulness of campaigns. We do not sell personal information."], ["Marketing communications", "With your consent, we may send product, service or offer updates. You can opt out of promotional messages using the instructions included in them."], ["Data protection", "We apply reasonable technical and organisational safeguards, including controlled access and secure service providers. No online service can guarantee absolute security."], ["Third-party services", "Payment gateways, couriers, email providers and analytics services process information only as needed to provide their services and under their own privacy terms."], ["Your rights", "You may request access, correction or deletion of eligible personal information, subject to legal, accounting and fraud-prevention obligations."], ["Contact information", "For privacy questions or requests, contact PrintOasis support with the email address associated with your account."]], links: [["Terms & conditions", "/terms"], ["Contact support", "/contact"]] },
    terms: { eyebrow: "TERMS & CONDITIONS", title: "Clear terms for confident ordering", description: "The terms that apply when you use PrintOasis, submit artwork or place an order.", sections: [["Website usage", "Use PrintOasis lawfully and provide accurate account, billing, delivery and artwork information. Do not interfere with site security or attempt unauthorised access."], ["Orders", "An order becomes accepted when we confirm payment and can proceed with the supplied specification. We may contact you to clarify artwork, availability, pricing or delivery details before production."], ["Pricing", "Prices, taxes, promotional offers and delivery charges are shown before checkout and may change for future orders. Obvious pricing or configuration errors may be corrected before production."], ["Product availability", "Product options, materials, finishes and delivery services depend on current availability. We may suggest a comparable alternative where a selected option becomes unavailable."], ["Intellectual property", "PrintOasis owns its site content, brand and original materials. You retain responsibility for the artwork you upload and must have the rights, licences and permissions required to print it."], ["User responsibilities", "Do not submit unlawful, infringing, offensive or misleading artwork. We may decline, pause or cancel work that appears to breach law, third-party rights or our production standards."], ["Limitation of liability", "To the extent permitted by law, our liability is limited to the value paid for the affected order. We are not liable for indirect loss, lost profits or delays outside reasonable control."], ["Cancellation", "Cancellation requests are assessed against the order stage. Made-to-order jobs cannot usually be cancelled after production begins."], ["Governing law", "These terms are governed by the laws of India. Courts with appropriate jurisdiction in India will handle disputes, subject to applicable consumer protections."], ["Contact information", "Contact our support team before placing a complex or business-critical order if you need clarification on these terms."]], links: [["Privacy policy", "/privacy"], ["Returns & refunds", "/returns"], ["Contact support", "/contact"]] },
    guidelines: { eyebrow: "PRINTING GUIDELINES", title: "Prepare artwork that prints beautifully", description: "A practical prepress checklist for sharper, more predictable printed results.", sections: [["Artwork resolution", "Build artwork at its final print size. Use 300 DPI for small-format print and avoid enlarging low-resolution web images."], ["Recommended DPI", "Use 300 DPI for business cards, brochures, labels and photo products. For large-format viewing at distance, 150 DPI at final size is often sufficient."], ["CMYK and RGB", "Convert artwork to CMYK for the closest press result. RGB screens can display colours that cannot be reproduced exactly in ink, so minor shifts may occur."], ["Bleed area", "Add 3 mm bleed on every edge unless a product template states otherwise. Extend background colours and images through the bleed to prevent fine white edges after trimming."], ["Safe margin", "Keep text, logos and critical elements at least 3 mm inside the trim line. Use a larger margin for folded products, labels and complex die-cuts."], ["Accepted file formats", "PDF is preferred. We also accept PNG, AI and PSD files where the product supports upload. Keep layers and linked assets intact when sharing editable artwork."], ["Fonts", "Outline fonts or embed them in your PDF. This prevents substitutions when a font is not installed in the production environment."], ["Image quality", "Avoid screenshots, compressed social-media images and images copied from the web. Check photographs at 100% zoom for blur, noise or visible compression."], ["PDF recommendations", "Export a press-ready PDF with bleed, crop marks only when requested, embedded fonts and flattened transparency where appropriate."], ["Large format printing", "Use vector logos where possible, keep viewing distance in mind and avoid very small text. Confirm the finished size, fixing method and installation surface before ordering."], ["Business card design", "Prioritise readability: keep type generous, use high contrast, include only essential information and allow the card stock and finish to do some of the talking."], ["Poster design", "Use a single clear message, strong hierarchy and high-resolution images. Design for the actual viewing distance, not just for a screen at arm's length."], ["Label printing", "Confirm the container size, label shape, application surface and any moisture, oil or refrigeration requirements before choosing a stock or adhesive."]], links: [["Browse business cards", "/products?category=business-cards"], ["Browse marketing prints", "/products?category=marketing"], ["Talk to prepress", "/contact"]] },
    business: { eyebrow: "BUSINESS SOLUTIONS", title: "Print, managed for business", description: "One dependable print partner for teams, locations, campaigns and repeat work.", sections: [["Corporate printing", "Coordinate everyday stationery, sales collateral, signage and packaging with specifications that stay consistent from order to order."], ["Bulk orders", "Plan volume orders with production schedules, delivery splits and commercial pricing tailored to the quantity and format you need."], ["GST billing", "Provide your GST details during checkout for eligible invoicing. Business teams can also request consolidated billing support for approved programmes."], ["Dedicated account manager", "For recurring or multi-location work, a single PrintOasis contact can help coordinate quoting, prepress, production and dispatch."], ["Recurring orders", "Set dependable re-order specifications for items your team uses often, from stationery and labels to onboarding kits and campaign materials."], ["Office branding", "Bring together wall graphics, name plates, desk collateral, display material and branded essentials for a cohesive workplace experience."], ["Employee welcome kits", "Create practical, brand-led kits with apparel, ID collateral, notebooks, drinkware and packaging for new joiners and events."], ["Marketing campaign printing", "Launch consistent campaign material across formats, including flyers, brochures, posters, banners and direct-to-location dispatch."], ["Enterprise pricing", "Larger, repeat and complex programmes can be quoted with transparent specifications, lead times and delivery assumptions."], ["Custom quotations", "Tell us the finished size, quantity, stock, finishing, delivery locations and deadline. We will help turn the brief into a production-ready quote."]], links: [["Request a business quote", "/contact"], ["Explore bulk printing", "/products?category=bulk"], ["Printing guidelines", "/printing-guidelines"]] },
    faq: { eyebrow: "FAQ", title: "Straight answers for every print order", description: "Quick, practical answers on artwork, production, delivery, payments and after-sales support.", sections: [["How do I place an order?", "Choose a product, configure the size and finish, upload artwork or add a production note, then review your cart before checkout."], ["Which files can I upload?", "PDF, PNG, AI and PSD files are supported where artwork upload is available. A press-ready PDF is the preferred option for reliable output."], ["Do you check artwork before printing?", "We perform a basic prepress review for technical suitability. You remain responsible for spelling, layout, rights and final creative approval unless a separate design service is agreed."], ["How long does production take?", "Most standard jobs move through production within 1–2 working days after approval. The product page, checkout and order updates provide the best timing guidance."], ["Can I get same-day printing?", "Selected products may qualify when ordered before the displayed cut-off with print-ready artwork and a supported delivery location."], ["How do I track an order?", "Use Track Package with your order number and phone, or open My Orders once a courier and tracking number have been assigned."], ["Can I change or cancel an order?", "Contact us as soon as possible. Changes or cancellation may be possible before production starts, but not once materials and press time are committed."], ["Can I return a customised product?", "Made-to-order products cannot normally be returned for a change of mind. We will review damaged, defective or incorrectly printed items promptly."], ["How do coupons work?", "Enter one valid code at checkout. Eligibility, expiry, minimum order value and maximum discount are shown with the offer."], ["Can I get a GST invoice?", "Provide your GST details at checkout where applicable, then download the invoice from the completed order."], ["Do you support corporate orders?", "Yes. PrintOasis can quote for recurring, bulk, campaign and multi-location work. Contact the business team with your requirements."]], links: [["Help centre", "/help"], ["Shipping policy", "/shipping-policy"], ["Returns & refunds", "/returns"]] },
    contact: { eyebrow: "CONTACT PRINTOASIS", title: "Talk to people who understand print", description: "Get help with an order, a detailed production brief or a business printing requirement.", sections: [["Customer support", `${SUPPORT_EMAIL} · ${SUPPORT_PHONE}`], ["Working hours", "Monday–Saturday · 9:00 AM–7:00 PM IST. We respond to submitted enquiries during support hours."], ["Office", OFFICE_ADDRESS], ["Business enquiries", "For corporate printing, recurring orders, welcome kits or multi-location fulfilment, choose Business enquiry in the form."], ["Social updates", "Follow PrintOasis on your preferred social channels for product inspiration, print tips and seasonal offers."]], links: [["Business solutions", "/business"], ["Help centre", "/help"], ["Track a package", "/track"]] }
  };
  const page = pages[kind] || pages.help;
  const isContact = kind === "contact";
  const contactDetails = isContact ? `<section class="section contact-layout"><div class="info-grid trust-grid">${page.sections.map(([heading, copy]) => `<article><h2>${esc(heading)}</h2><p>${heading === "Customer support" ? `<a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a><br><a href="tel:${encodeURIComponent(SUPPORT_PHONE)}">${esc(SUPPORT_PHONE)}</a>` : esc(copy)}</p></article>`).join("")}</div><form class="contact-form" method="post" action="/contact"><input type="hidden" name="csrf" value="${session.csrf}"><h2>Send an enquiry</h2><p>Tell us what you are planning and we will route it to the right PrintOasis team.</p><label>Name<input name="name" autocomplete="name" minlength="2" required></label><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Phone<input name="phone" type="tel" autocomplete="tel" required></label><label>How can we help?<select name="topic"><option>Order support</option><option>Business enquiry</option><option>Artwork and prepress</option><option>Delivery and tracking</option><option>Returns and refunds</option></select></label><label class="full">Message<textarea name="message" rows="5" minlength="12" maxlength="2000" required placeholder="Tell us the product, quantity, deadline and anything else we should know."></textarea></label><button class="button primary" type="submit">Send enquiry</button></form></section>` : `<section class="section trust-section"><div class="trust-grid">${page.sections.map(([heading, copy]) => `<article><h2>${esc(heading)}</h2><p>${esc(copy)}</p></article>`).join("")}</div></section>`;
  const resourceLink = ["help", "faq", "contact", "guidelines", "business"].includes(kind) ? [["Browse all resources", "/resources"]] : [];
  const relatedLinks = [...(page.links || []), ...resourceLink];
  const pageLinks = relatedLinks.length ? `<nav class="section trust-links" aria-label="Related information">${relatedLinks.map(([label, href]) => `<a class="button ghost" href="${href}">${esc(label)}</a>`).join("")}</nav>` : "";
  const cta = kind === "business" ? `<a class="button primary" href="/contact">Request a business quote</a>` : kind === "guidelines" ? `<a class="button primary" href="/products">Browse print products</a>` : "";
  return await layout(page.title, `${notice(url)}<section class="page-hero trust-hero"><span class="eyebrow">${esc(page.eyebrow)}</span><h1>${esc(page.title)}</h1><p>${esc(page.description)}</p>${cta}</section>${contactDetails}${pageLinks}`, session, cart, page.description);
}

function adminTabs(active) {
  const tabs = [["/admin", "Dashboard"], ["/admin/products", "Products"], ["/admin/coupons", "Coupons"], ["/admin/orders", "Orders"], ["/admin/notifications", "Notifications"]];
  return `<aside aria-label="Admin navigation">${tabs.map(([href, label]) => `<a class="${active === label ? "active" : ""}" href="${href}"${active === label ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</aside>`;
}

async function adminPage(title, active, body, session, cart) {
  return await layout(title, `
    <section class="page-hero compact"><span class="eyebrow">ADMIN</span><h1>${esc(title)}</h1><p>Manage PrintOasis products, orders, statuses and customer operations.</p></section>
    <section class="account-layout admin-layout section">${adminTabs(active)}<div>${body}</div></section>
  `, session, cart);
}

async function adminDashboardPage(session, cart) {
  const stats = {
    products: (await db.get(`SELECT COUNT(*) count FROM products WHERE ${visibleProductCondition()}`)).count,
    orders: (await db.get("SELECT COUNT(*) count FROM orders")).count,
    pending: (await db.get("SELECT COUNT(*) count FROM orders WHERE status NOT IN ('Delivered','Cancelled')")).count,
    revenue: (await db.get("SELECT COALESCE(SUM(total),0) total FROM orders")).total
  };
  const statusCounts = await db.all("SELECT status, COUNT(*) count FROM orders GROUP BY status ORDER BY count DESC");
  const recent = await db.all("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 6");
  return await adminPage("Operations dashboard", "Dashboard", `
    <div class="account-cards admin-stats">
      <article class="admin-stat-card"><span>Active products</span><b>${stats.products}</b><a href="/admin/products">Manage catalog</a></article>
      <article class="admin-stat-card"><span>Total orders</span><b>${stats.orders}</b><a href="/admin/orders">View orders</a></article>
      <article class="admin-stat-card"><span>Open jobs</span><b>${stats.pending}</b><a href="/admin/orders">Update status</a></article>
      <article class="admin-stat-card"><span>Revenue</span><b class="small">${money(stats.revenue)}</b><a href="/admin/orders">See sales</a></article>
    </div>
    <div class="admin-grid"><article><h2>Status pipeline</h2>${statusCounts.length ? statusCounts.map(s => `<p><span class="status ${statusClass(s.status)}">${esc(s.status)}</span><b>${s.count}</b></p>`).join("") : "<p>No orders yet.</p>"}</article><article><h2>Recent orders</h2>${adminOrderRows(recent, session, false)}</article></div>
  `, session, cart);
}

async function productForm(product, session) {
  const p = product || { id: "", slug: "", name: "", category: categories[0][0], price: 399, min_qty: 1, rating: 4.8, badge: "New", description: "", sizes: "", materials: "", print_options: "", color: "cobalt", stock: 100, reserved: 0, status: "active", featured: 0, active: 1 };
  const available = productAvailable(p);
  const imageCount = product ? (await db.get("SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?", product.id)).count : 0;
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
    <label>Primary product image <small class="input-help">JPG, PNG or WebP up to 8 MB. Existing single-image products remain supported.</small><input type="file" name="product_image" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"></label>
    <label>Hover image <small class="input-help">Optional alternate card view.</small><input type="file" name="hover_image" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"></label>
    <label class="full">Gallery images <small class="input-help">Optional additional angles, details or lifestyle images. ${imageCount ? `${imageCount} additional image${imageCount === 1 ? "" : "s"} already attached.` : ""}</small><input type="file" name="gallery_images" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"></label>
    <label>Gallery placement <select name="gallery_placement"><option value="default">Product gallery</option><option value="featured">Featured products</option><option value="trending">Trending products</option><option value="recommendation">Recommendations</option></select><small class="input-help">Applies to newly added gallery images.</small></label>
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

async function adminProductsPage(url, session, cart) {
  const editId = Number(url.searchParams.get("edit") || 0);
  const editing = editId ? await db.get("SELECT * FROM products WHERE id = ?", editId) : null;
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ["", "active", "hidden"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const inventory = ["", "in", "low", "out"].includes(url.searchParams.get("inventory")) ? url.searchParams.get("inventory") : "";
  const where = [];
  const params = [];
  if (query) { where.push("(name ILIKE ? OR slug ILIKE ? OR category ILIKE ?)"); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (status) { where.push("status = ?"); params.push(status); }
  const productSql = `SELECT * FROM products${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY status = 'hidden', category, name`;
  const products = (await attachProductImages(await db.all(productSql, ...params))).filter(product => {
    const available = productAvailable(product);
    if (inventory === "out") return available <= 0;
    if (inventory === "low") return available > 0 && available <= Math.max(5, product.min_qty);
    if (inventory === "in") return available > Math.max(5, product.min_qty);
    return true;
  });
  return await adminPage("Product manager", "Products", `
    <div class="section-heading compact-heading"><div><span class="eyebrow">CATALOG CRUD</span><h2>${editing ? `Edit ${esc(editing.name)}` : "Add product"}</h2></div></div>
    ${await productForm(editing, session)}
    <div class="admin-table"><div class="admin-table-heading"><div><span class="eyebrow">CATALOG OVERVIEW</span><h2>All products</h2></div><form class="admin-list-filters" method="get" action="/admin/products"><input name="q" value="${esc(query)}" placeholder="Search name, slug or category"><select name="status"><option value="">All statuses</option><option value="active" ${status === "active" ? "selected" : ""}>Active</option><option value="hidden" ${status === "hidden" ? "selected" : ""}>Hidden</option></select><select name="inventory"><option value="">All inventory</option><option value="in" ${inventory === "in" ? "selected" : ""}>In stock</option><option value="low" ${inventory === "low" ? "selected" : ""}>Low stock</option><option value="out" ${inventory === "out" ? "selected" : ""}>Out of stock</option></select><button class="button ghost" type="submit">Filter</button></form></div>${products.map(p => { const available = productAvailable(p); const stockKind = available <= 0 ? "out" : available <= Math.max(5, p.min_qty) ? "low" : "in"; return `<article><div>${productArt(p)}<span><b>${esc(p.name)}</b><small>${esc(p.category)} · ${money(p.price)} · min ${p.min_qty} · ${p.status === "hidden" ? "hidden" : "active"}</small><span class="admin-inventory"><span class="stock-state ${stockKind}">${available <= 0 ? "Out of stock" : available <= Math.max(5, p.min_qty) ? `Low: ${available} available` : `${available} available`}</span><small>Physical ${p.stock ?? 0} · Reserved ${p.reserved ?? 0}</small></span></span></div><nav><a class="button ghost" href="/admin/products?edit=${p.id}">Edit</a><form method="post" action="/admin/products/delete"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="id" value="${p.id}"><button class="button ghost" type="submit">Delete</button></form></nav></article>`; }).join("") || emptyState("admin-products", "No products matched these filters", "Try clearing a filter or create a new product.", "/admin/products", "Clear filters")}</div>
  `, session, cart);
}

async function couponForm(coupon, session) {
  const item = coupon || { code: "", type: "percent", value: 10, minimum_order: 0, maximum_discount: "", expiry_date: "", usage_limit: "", times_used: 0, active: 1 };
  return `<form class="admin-form" method="post" action="/admin/coupons/save"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="original_code" value="${esc(coupon?.code || "")}"><label>Code<input name="code" value="${esc(item.code)}" maxlength="24" pattern="[A-Za-z0-9_-]+" required></label><label>Type<select name="type"><option value="percent" ${item.type === "percent" ? "selected" : ""}>Percentage</option><option value="fixed" ${item.type === "fixed" ? "selected" : ""}>Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" value="${item.value}" required></label><label>Minimum order<input name="minimum_order" type="number" min="0" value="${item.minimum_order || 0}" required></label><label>Maximum discount <small class="input-help">Optional cap for percentage coupons.</small><input name="maximum_discount" type="number" min="1" value="${esc(item.maximum_discount || "")}"></label><label>Expiry date <small class="input-help">Optional; valid through this date.</small><input name="expiry_date" type="date" value="${esc(item.expiry_date || "")}"></label><label>Usage limit <small class="input-help">Optional total limit.</small><input name="usage_limit" type="number" min="1" value="${esc(item.usage_limit || "")}"></label><label>Times used<input type="number" value="${item.times_used || 0}" readonly></label><label class="check-row"><input type="checkbox" name="active" value="1" ${item.active ? "checked" : ""}>Coupon is active</label><button class="button primary full" type="submit">${coupon ? "Save coupon" : "Create coupon"}</button></form>`;
}

async function adminCouponsPage(url, session, cart) {
  const editCode = String(url.searchParams.get("edit") || "").trim().toUpperCase();
  const editing = editCode ? await db.get("SELECT * FROM coupons WHERE code = ?", editCode) : null;
  const coupons = await db.all("SELECT * FROM coupons ORDER BY active DESC, created_at DESC, code");
  return await adminPage("Coupon manager", "Coupons", `
    <div class="section-heading compact-heading"><div><span class="eyebrow">CHECKOUT PROMOTIONS</span><h2>${editing ? `Edit ${esc(editing.code)}` : "Create coupon"}</h2></div></div>
    ${await couponForm(editing, session)}
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
            ${new Date(o.created_at).toLocaleString("en-IN")}
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

async function adminOrdersPage(url, session, cart) {
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  const status = ORDER_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const where = [];
  const params = [];
  if (query) { where.push("(o.order_number ILIKE ? OR o.customer_name ILIKE ? OR u.email ILIKE ?)"); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (status) { where.push("o.status = ?"); params.push(status); }
  const orders = await db.all(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY o.id DESC`, ...params);
  return await adminPage("Order manager", "Orders", `<div class="admin-table-heading"><div><span class="eyebrow">FULFILMENT</span><h2>Order operations</h2></div><form class="admin-list-filters" method="get" action="/admin/orders"><input name="q" value="${esc(query)}" placeholder="Order number, customer or email"><select name="status"><option value="">All statuses</option>${ORDER_STATUSES.map(item => `<option ${status === item ? "selected" : ""}>${item}</option>`).join("")}</select><button class="button ghost" type="submit">Filter</button></form></div><p class="lead">Update statuses through Pending, Printing, Packed, Shipped, Delivered and Cancelled. Cancelled orders automatically restore deducted stock once.</p>${adminOrderRows(orders, session, true)}`, session, cart);
}

async function adminNotificationsPage(session, cart) {
  const notifications = await db.all("SELECT * FROM notifications ORDER BY id DESC LIMIT 60");
  return await adminPage("Notification outbox", "Notifications", `<div class="admin-table">${notifications.length ? notifications.map(n => `<article><div><b>${esc(n.subject)}</b><small>${esc(n.event)} · ${esc(n.recipient)} · ${esc(n.status)}</small><small>${new Date(n.created_at).toLocaleString("en-IN")}</small></div></article>`).join("") : `<div class="empty slim"><h3>No notifications yet</h3><p>Order confirmations and status updates will appear here.</p></div>`}</div>`, session, cart);
}

async function wishlistPage(session, cart) {
  const products = await attachProductImages(await db.all(`SELECT p.*, w.saved_price FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND ${visibleProductCondition("p")} ORDER BY w.id DESC`, session.user.id));
  return await layout("Wishlist", `<section class="page-hero compact"><span class="eyebrow">SAVED PRINTS</span><h1>Your wishlist</h1><p>Keep client favourites and repeat-order ideas close.</p></section><section class="section wishlist-section">${products.length ? `<div class="product-grid wishlist-grid">${products.map(product => { const available = sellableQuantity(product); const priceChanged = Number(product.price) !== Number(product.saved_price); const priceNote = Number(product.price) < Number(product.saved_price) ? "Price dropped" : Number(product.price) > Number(product.saved_price) ? "Price increased" : "Price unchanged"; const stockKind = available <= 0 ? "out" : available <= Math.max(5, product.min_qty) ? "low" : "in"; const stockNote = stockKind === "out" ? "Out of Stock" : stockKind === "low" ? "Low Stock" : "In Stock"; return `<article class="wishlist-card">${productArt(product)}<div class="wishlist-card-content"><div class="wishlist-card-meta"><span class="wishlist-price-note ${priceChanged ? "changed" : ""}">${esc(priceNote)}</span><span class="stock-state ${stockKind}">${esc(stockNote)}</span></div><h3><a href="/product/${esc(product.slug)}">${esc(product.name)}</a></h3><div class="wishlist-pricing"><strong>${money(product.price)}</strong>${priceChanged ? `<s>${money(product.saved_price)}</s>` : ""}${Number(product.price) < Number(product.saved_price) ? `<small>Save ${money(Number(product.saved_price) - Number(product.price))}</small>` : ""}</div><div class="wishlist-actions"><a class="button ghost" href="/product/${esc(product.slug)}">View product</a><form method="post" action="/wishlist/move-to-cart"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><button class="button primary" type="submit" ${available <= 0 ? "disabled" : ""}>Add to cart</button></form><form method="post" action="/wishlist/toggle"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="product_id" value="${product.id}"><input type="hidden" name="next" value="/wishlist"><button class="button ghost" type="submit" aria-label="Remove ${esc(product.name)} from wishlist">Remove</button></form></div></div></article>`; }).join("")}</div>` : emptyState("wishlist", "Save products for later", "Keep client favourites and repeat-order ideas ready to revisit.", "/products", "Browse products", "/account", "View account")}</section>`, session, cart);
}

function statusTimeline(order) {
  if (order.status === "Cancelled") return `<div class="status-timeline" aria-label="Order status timeline"><span class="done">Pending</span><span class="done current" aria-current="step">Cancelled</span></div>`;
  const index = Math.max(0, ORDER_STATUSES.indexOf(order.status));
  return `<div class="status-timeline" aria-label="Order status timeline">${ORDER_STATUSES.filter(s => s !== "Cancelled").map((s, i) => `<span class="${i <= index ? "done" : ""}${i === index ? " current" : ""}"${i === index ? ' aria-current="step"' : ""}>${esc(s)}</span>`).join("")}</div>`;
}

async function trackPage(url, session, cart, result = null) {
  return await layout(
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

async function invoicePage(order, items, session, cart) {
  const taxable = Math.round(order.total / 1.18);
  const gst = order.total - taxable;
  return await layout(`Invoice ${order.order_number}`, `<section class="invoice section narrow"><div class="invoice-head"><div><span class="eyebrow">GST INVOICE</span><h1>${esc(order.order_number)}</h1><p>${new Date(order.created_at).toLocaleDateString("en-IN", { dateStyle: "long" })}</p></div><div class="invoice-actions"><a class="button ghost" href="/account/orders/${order.id}">Back to order</a><button class="button primary" onclick="window.print()">Print / Save PDF</button></div></div><div class="invoice-box"><h2>Bill to</h2><p>${esc(order.customer_name)}<br>${esc(order.address)}<br>${esc(order.city)} - ${esc(order.postal_code)}<br>Phone: ${esc(order.phone)}${order.gst_number ? `<br>GST: ${esc(order.gst_number)}` : ""}</p></div><table class="invoice-table"><caption class="sr-only">Invoice items for ${esc(order.order_number)}</caption><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Rate</th><th scope="col">Total</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.product_name)}<small>${esc(i.configuration)}</small></td><td>${i.quantity}</td><td>${money(i.unit_price)}</td><td>${money(i.quantity * i.unit_price)}</td></tr>`).join("")}</tbody></table><div class="invoice-totals"><p><span>Shipping</span><b>${money(order.shipping_fee || 0)}</b></p><p><span>Discount</span><b>${money(order.discount || 0)}</b></p><p><span>Taxable value</span><b>${money(taxable)}</b></p><p><span>GST included</span><b>${money(gst)}</b></p><p class="total"><span>Grand total</span><b>${money(order.total)}</b></p></div></section>`, session, cart);
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

async function orderWithUser(orderId) {
  return db.get("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?", orderId);
}

async function queueNotification(orderId, event, recipient, subject, body, html) {
  const canSendSmtp = emailService.configured;
  const result = await db.run("INSERT INTO notifications (order_id,event,recipient,subject,body,status) VALUES (?,?,?,?,?,?) RETURNING id", orderId, event, recipient, subject, body, canSendSmtp || EMAIL_WEBHOOK_URL ? "queued" : "logged");
  const notificationId = result.rows[0].id;
  fs.writeFileSync(path.join(EMAIL_LOG_DIR, `${Date.now()}-${notificationId}.txt`), `To: ${recipient}\nFrom: ${EMAIL_FROM}\nSubject: ${subject}\n\n${body}`);
  if (canSendSmtp) {
    const delivery = await emailService.send({ to: recipient, subject, text: body, html });
    await db.run("UPDATE notifications SET status = ?, sent_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id = ?", delivery.delivered ? "sent" : `failed:${String(delivery.error || "SMTP delivery failed").slice(0, 80)}`, delivery.delivered, notificationId);
    return;
  }
  console.info(`Email logged for ${recipient}: SMTP is not configured.`);
  if (!EMAIL_WEBHOOK_URL) return;
  try {
    const response = await fetch(EMAIL_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: EMAIL_FROM, to: recipient, subject, text: body, html, event, orderId }) });
    await db.run("UPDATE notifications SET status = ?, sent_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id = ?", response.ok ? "sent" : `failed:${response.status}`, response.ok, notificationId);
  } catch (error) {
    await db.run("UPDATE notifications SET status = ? WHERE id = ?", `failed:${error.message.slice(0, 80)}`, notificationId);
  }
}

async function notifyOrder(orderId, event, note = "") {
  const order = await orderWithUser(orderId);
  if (!order) return;
  const items = await db.all("SELECT product_id, product_name, quantity FROM order_items WHERE order_id = ?", order.id);
  const message = orderEmailTemplate({ event, order, items, note, baseUrl: PUBLIC_BASE_URL, money });
  await queueNotification(order.id, event, order.email, message.subject, message.text, message.html);
}

async function sendContactEnquiry(enquiry) {
  const clean = value => String(value || "").replace(/[\r\n]+/g, " ").trim();
  const subject = `PrintOasis contact: ${clean(enquiry.topic || "General enquiry")}`;
  const text = [`Name: ${clean(enquiry.name)}`, `Email: ${clean(enquiry.email)}`, `Phone: ${clean(enquiry.phone)}`, `Topic: ${clean(enquiry.topic)}`, "", clean(enquiry.message)].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#172033"><h1>PrintOasis contact enquiry</h1><p><strong>Name:</strong> ${esc(clean(enquiry.name))}<br><strong>Email:</strong> ${esc(clean(enquiry.email))}<br><strong>Phone:</strong> ${esc(clean(enquiry.phone))}<br><strong>Topic:</strong> ${esc(clean(enquiry.topic))}</p><p>${esc(clean(enquiry.message)).replace(/\n/g, "<br>")}</p></div>`;
  const fileName = `contact-${Date.now()}-${crypto.randomBytes(5).toString("hex")}.txt`;
  fs.writeFileSync(path.join(EMAIL_LOG_DIR, fileName), `To: ${CONTACT_RECIPIENT}\nFrom: ${EMAIL_FROM}\nReply-To: ${clean(enquiry.email)}\nSubject: ${subject}\n\n${text}`);
  const delivery = await emailService.send({ to: CONTACT_RECIPIENT, replyTo: clean(enquiry.email), subject, text, html });
  if (!delivery.delivered) console.info(`Contact enquiry logged locally for ${clean(enquiry.email)}.`);
  return delivery;
}

async function createLocalOrder(session, cart, data, paymentMethod, paymentId = null) {
  if (!cart.items.length) throw new Error("Your cart is empty.");
  const totals = await cartTotals(cart, data.postal_code, data.coupon_code);
  if (data.coupon_code && totals.couponError) throw new Error(totals.couponError);
  const orderNumber = `PO-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`;
  const orderId = await db.transaction(async tx => {
    const requestedByProduct = new Map();
    for (const item of cart.items) requestedByProduct.set(item.product_id, (requestedByProduct.get(item.product_id) || 0) + item.quantity);
    for (const [productId, quantity] of requestedByProduct.entries()) {
      const product = await tx.get(`SELECT * FROM products WHERE id = ? AND ${visibleProductCondition()} FOR UPDATE`, productId);
      if (!product) throw new Error("One of the products in your cart is no longer available.");
      if (Number(product.stock || 0) < quantity) throw new Error(`Only ${Math.max(0, Number(product.stock || 0))} items available for ${product.name}.`);
      if (Number(product.reserved || 0) < quantity) throw new Error(`Reservation expired for ${product.name}. Please add it to cart again.`);
    }
    if (totals.coupon) {
      const usage = await tx.run("UPDATE coupons SET times_used = times_used + 1 WHERE code = ? AND active = 1 AND (usage_limit IS NULL OR times_used < usage_limit) AND (expiry_date IS NULL OR expiry_date >= ?)", totals.coupon.code, new Date().toISOString().slice(0, 10));
      if (!usage.changes) throw new Error("This coupon is no longer available.");
    }
    const order = await tx.run("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,shipping_fee,discount,coupon_code,gst_number,payment_method,payment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", orderNumber, session.user.id, totals.total, "Pending", data.customer_name, data.phone, data.address, data.city, data.postal_code, totals.delivery, totals.discount, totals.coupon?.code || null, data.gst_number || null, paymentMethod, paymentId);
    const id = order.rows[0].id;
    for (const item of cart.items) {
      await tx.run("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)", id, item.product_id, item.name, item.quantity, item.unit_price, `${item.size} · ${item.material} · ${item.print_option}${item.artwork_original_name ? ` · Artwork: ${item.artwork_original_name}` : ""}`);
      const deduction = await tx.run("UPDATE products SET stock = stock - ?, reserved = reserved - ? WHERE id = ? AND stock >= ? AND reserved >= ?", item.quantity, item.quantity, item.product_id, item.quantity, item.quantity);
      if (!deduction.changes) throw new Error(`Inventory changed for ${item.name}. Please review your cart.`);
    }
    await tx.run("INSERT INTO order_status_events (order_id,status,note) VALUES (?,?,?)", id, "Pending", "Order confirmed and queued for artwork review.");
    await tx.run("DELETE FROM cart_items WHERE session_id = ?", session.id);
    return id;
  });
  notifyOrder(orderId, "order_confirmation").catch(console.error);
  return orderNumber;
}

async function restoreOrderInventory(orderId) {
  return db.transaction(async tx => {
    const order = await tx.get("SELECT id, inventory_restocked FROM orders WHERE id = ? FOR UPDATE", orderId);
    if (!order || order.inventory_restocked) return false;
    const items = await tx.all("SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL", orderId);
    for (const item of items) await tx.run("UPDATE products SET stock = stock + ? WHERE id = ?", item.quantity, item.product_id);
    await tx.run("UPDATE orders SET inventory_restocked = 1 WHERE id = ?", orderId);
    return true;
  });
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
  const types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };
  send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
  return true;
}

function serveProductImage(req, res, url) {
  const name = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
  const file = path.join(PRODUCT_IMAGE_DIR, name);
  if (!file.startsWith(PRODUCT_IMAGE_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain"), true;
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), imageMimeType(ext));
  return true;
}

const app = {
  ADMIN_EMAIL,
  GOOGLE_CLIENT_ID,
  ORDER_STATUSES,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  addCartItem,
  addProductImages,
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
  get db() { return db; },
  databaseHealth,
  redisHealth: async () => Boolean(redis && await redis.health()),
  redisService: () => redis,
  updateSessionUser,
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
  saveProductImages,
  sendContactEnquiry,
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
    if (!await applyRateLimits(requestLimitPolicies(req, routedUrl.pathname, {}, null, "ip", TRUST_PROXY_HOPS), res)) return;
    const routedSession = await getSession(req, res);
    const routedCart = await cartData(routedSession.id);
    const routedData = req.method === "POST" ? await requestData(req) : {};
    if (!await applyRateLimits(requestLimitPolicies(req, routedUrl.pathname, routedData, routedSession, "account", TRUST_PROXY_HOPS), res)) return;
    const routedContext = { req, res, url: routedUrl, data: routedData, session: routedSession, cart: routedCart, app };
    for (const route of routes.slice(1)) {
      if (await route(routedContext)) return;
    }
    return send(res, 404, await layout("Page not found", `<section class="not-found section"><div class="not-found-mark" aria-hidden="true"><span>404</span></div><div><span class="eyebrow">PAGE NOT FOUND</span><h1>Looks like this page wasn't printed correctly.</h1><p>The link may have moved, expired or never made it to production. Search the catalog or head back to a fresh start.</p><form class="not-found-search" action="/products" role="search"><label class="sr-only" for="not-found-query">Search PrintOasis products</label><input id="not-found-query" name="q" placeholder="Search cards, flyers, stickers..." required><button class="button primary" type="submit">Search products</button></form><div class="not-found-actions"><a class="button primary" href="/">Return home</a><a class="button ghost" href="/products">Continue shopping</a></div></div></section>`, routedSession, routedCart));

  } catch (error) {
    if (error.code !== "REDIS_UNAVAILABLE") console.error(error);
    if (res.headersSent) return res.destroy();
    if (error.code === "REDIS_UNAVAILABLE") return send(res, 503, "Service temporarily unavailable. Please try again shortly.", "text/plain; charset=utf-8");
    send(res, 500, process.env.NODE_ENV === "test" ? error.stack : "Something went wrong. Please try again.", "text/plain");
  }
});

async function start() {
  try {
    await initRedis();
    await initDb();
    if (!await databaseHealth(db) || !await redis.health()) throw new Error("Application dependency health check failed.");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, () => { server.off("error", reject); resolve(); });
    });
    console.log(`PrintOasis running at http://localhost:${PORT}`);
  } catch (error) {
    if (redis) {
      try { await redis.close(); } catch {}
      redis = undefined;
    }
    if (db) {
      try { await db.close(); } catch (closeError) { console.error("PostgreSQL pool cleanup after startup failure failed:", closeError); }
      db = undefined;
    }
    console.error("PrintOasis could not start because a required database or shared Redis service is unavailable.", error.code === "REDIS_UNAVAILABLE" ? error.message : error);
    process.exitCode = 1;
    throw error;
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing HTTP server and PostgreSQL pool.`);
  try {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    if (redis) {
      await redis.close();
      redis = undefined;
    }
    if (db) {
      await db.close();
      db = undefined;
    }
  }
}
process.once("SIGINT", () => shutdown("SIGINT").catch(error => { console.error(error); process.exitCode = 1; }));
process.once("SIGTERM", () => shutdown("SIGTERM").catch(error => { console.error(error); process.exitCode = 1; }));

if (require.main === module) start().catch(() => {});
module.exports = { app, server, start, initDb, shutdown };
