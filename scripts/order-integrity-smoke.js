const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertOrderIntegrityBehavior } = require("./order-integrity-regression");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for order-integrity regression tests.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl });
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6380";
  process.env.REDIS_PREFIX = `order-integrity-test:${crypto.randomUUID()}`;
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.ADMIN_EMAIL = "order-integrity-admin@example.test";
  process.env.ADMIN_PASSWORD = "OrderIntegrityTestAdmin123!";
  process.env.EMAIL_DELIVERY_ENABLED = "false";

  const { app, server, start, shutdown } = require("../server");
  const prefix = `order-integrity-${crypto.randomUUID()}`;
  let baseUrl = "";
  const sessionCookies = new Set();
  const sessionId = cookie => decodeURIComponent(String(cookie).match(/sid=([^;]+)/)?.[1] || "");
  function csrf(html) {
    const token = String(html).match(/name="csrf" value="([^"]+)"/)?.[1];
    assert(token, "Expected a CSRF token in SSR HTML.");
    return token;
  }
  function savedCookie(response, fallback = "") {
    const values = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
    const cookie = values.map(value => value.split(";")[0]).find(value => value.startsWith("sid=")) || fallback;
    if (cookie) sessionCookies.add(sessionId(cookie));
    return cookie;
  }
  async function get(urlPath, cookie = "") {
    const response = await fetch(`${baseUrl}${urlPath}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
    return { response, html: await response.text(), cookie: savedCookie(response, cookie) };
  }
  async function post(urlPath, fields, cookie) {
    const response = await fetch(`${baseUrl}${urlPath}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    return { response, html: await response.text(), cookie: savedCookie(response, cookie) };
  }
  async function login(email, password) {
    const page = await get("/login");
    const result = await post("/login", { csrf: csrf(page.html), email, password }, page.cookie);
    assert.equal(result.response.status, 303, "Test admin login succeeds.");
    return result.cookie;
  }
  async function register(email) {
    const page = await get("/register");
    const result = await post("/register", { csrf: csrf(page.html), name: "Stage Five Customer", email, password: "Testing123!" }, page.cookie);
    assert.equal(result.response.status, 303, "Test customer registration succeeds.");
    return result.cookie;
  }
  try {
    await start();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    const customerEmail = `${prefix}@example.test`;
    const customer = await register(customerEmail);
    const productSlug = `${prefix}-product`;
    const productPage = await get("/admin/products", admin);
    const productSave = await post("/admin/products/save", {
      csrf: csrf(productPage.html), name: "Stage Five Invoice Product", slug: productSlug,
      category: "business-cards", price: "200", min_qty: "1", rating: "5", badge: "",
      description: "Isolated Stage 5 fixture", sizes: "Standard", materials: "Matte",
      print_options: "Full color", color: "navy", stock: "5", status: "active"
    }, productPage.cookie);
    assert.equal(productSave.response.status, 303, "Stage 5 product fixture is created.");
    const product = await app.db.get("SELECT * FROM products WHERE slug=?", productSlug);
    assert(product, "Stage 5 product fixture exists.");

    const couponCode = `${prefix.slice(-10).toUpperCase()}C`;
    await app.db.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,'fixed',10,0,0,1)", couponCode);
    const detail = await get(`/product/${product.slug}`, customer);
    const added = await post("/cart/add", { csrf: csrf(detail.html), product_id: product.id, quantity: "1", size: "Standard", material: "Matte", print_option: "Full color" }, detail.cookie);
    assert.equal(added.response.status, 303, "Stage 5 product is reserved for checkout.");
    const checkout = await get(`/checkout?coupon_code=${encodeURIComponent(couponCode)}`, added.cookie);
    const completed = await post("/checkout", { csrf: csrf(checkout.html), customer_name: "Stage Five Customer", phone: "9876500000", address: "1 Test Road", city: "Bengaluru", postal_code: "560001", payment_method: "cod", coupon_code: couponCode }, checkout.cookie);
    assert.equal(completed.response.status, 303, "Stage 5 COD checkout succeeds.");
    const deliveredOrder = await app.db.get("SELECT * FROM orders WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1", customerEmail);
    assert(deliveredOrder, "Stage 5 immutable invoice order fixture exists.");
    await app.transitionOrderStatus(deliveredOrder.id, "Printing", {}, { actorType: "admin" });
    await app.transitionOrderStatus(deliveredOrder.id, "Packed", {}, { actorType: "admin" });
    await app.transitionOrderStatus(deliveredOrder.id, "Shipped", {}, { actorType: "admin" });
    await app.transitionOrderStatus(deliveredOrder.id, "Delivered", {}, { actorType: "admin" });
    await app.db.run("UPDATE coupons SET expiry_date=CURRENT_DATE - 1 WHERE code=?", couponCode);

    const assertions = await assertOrderIntegrityBehavior({
      app, get, post, csrf, prefix, admin, customer, product, deliveredOrder,
      sessionId: () => sessionId(customer)
    });
    process.stdout.write(`PASS isolated Stage 5 order/invoice integrity regression (${assertions} assertions). No live payment calls.\n`);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    try {
      for (const id of sessionCookies) {
        if (id) await app.db.run("DELETE FROM sessions WHERE id=?", id);
      }
      await app.db.run("DELETE FROM orders WHERE order_number LIKE ? OR user_id=(SELECT id FROM users WHERE email=?)", `${prefix}%`, `${prefix}@example.test`);
      await app.db.run("DELETE FROM coupons WHERE code LIKE ?", `${prefix.slice(-10).toUpperCase()}%`).catch(() => {});
      await app.db.run("DELETE FROM products WHERE slug=?", `${prefix}-product`);
      await app.db.run("DELETE FROM users WHERE email=?", `${prefix}@example.test`);
    } finally {
      const client = app.redisService().client;
      let keys = [];
      for await (const batch of client.scanIterator({ MATCH: `${process.env.REDIS_PREFIX}:*`, COUNT: 100 })) {
        keys.push(...batch);
        if (keys.length >= 100) { await client.del(keys); keys = []; }
      }
      if (keys.length) await client.del(keys);
      await shutdown("order integrity regression");
    }
  }
}

main().catch(error => {
  process.stderr.write(`Order-integrity regression failed: ${error.message}\n`);
  process.exitCode = 1;
});
