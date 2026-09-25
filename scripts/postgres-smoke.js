const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertSequentialOversell, runRegression } = require("./postgres-regression");
let restoredAssertions = 0;

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is required. Refusing to run PostgreSQL smoke tests without an isolated database.");
assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl: testUrl });
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.ADMIN_EMAIL = "postgres-smoke-admin@example.test";
process.env.ADMIN_PASSWORD = "PostgresSmokeAdmin123!";
process.env.EMAIL_DELIVERY_ENABLED = "false";

const { app, server, start, shutdown } = require("../server");
const stamp = Date.now();
const prefix = `pg-smoke-${stamp}`;
let baseUrl = "";

function cookieFrom(response) {
  const values = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map(value => value.split(";")[0]).find(value => value.startsWith("sid=")) || "";
}
function sessionId(cookie) { const match = String(cookie).match(/sid=([^;]+)/); return match ? decodeURIComponent(match[1]) : ""; }
function csrf(html) {
  const match = String(html).match(/name="csrf" value="([^"]+)"/);
  assert(match, "Expected a CSRF token in SSR HTML.");
  return match[1];
}
async function get(path, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
  return { response, html: await response.text(), cookie: cookieFrom(response) || cookie };
}
async function post(path, form, cookie) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return { response, html: await response.text(), cookie: cookieFrom(response) || cookie };
}
async function register(name, email) {
  const page = await get("/register");
  const result = await post("/register", { csrf: csrf(page.html), name, email, password: "Testing123!", next: "/account" }, page.cookie);
  assert.equal(result.response.status, 303, "Registration should redirect.");
  return result.cookie;
}
async function login(email, password) {
  const page = await get("/login?next=/admin");
  const result = await post("/login", { csrf: csrf(page.html), email, password, next: "/admin" }, page.cookie);
  assert.equal(result.response.status, 303, "Login should redirect.");
  return result.cookie;
}
async function addToCart(cookie, productId, quantity = 1) {
  const product = await get(`/product/${productId.slug}`, cookie);
  const result = await post("/cart/add", { csrf: csrf(product.html), product_id: productId.id, quantity, size: "A4", material: "Matte", print_option: "Full color" }, product.cookie);
  assert.equal(result.response.status, 303, "Cart add should redirect.");
  return result.cookie;
}
async function createProduct(adminCookie, slug, stock) {
  const page = await get("/admin/products", adminCookie);
  const result = await post("/admin/products/save", { csrf: csrf(page.html), name: `Postgres Smoke ${slug}`, slug, category: "marketing", price: "200", min_qty: "1", rating: "4.5", badge: "Smoke", description: "Isolated PostgreSQL smoke-test product.", sizes: "A4", materials: "Matte", print_options: "Full color", color: "mint", stock: String(stock), status: "active" }, page.cookie);
  assert.equal(result.response.status, 303, "Admin product create should redirect.");
  const product = await app.db.get("SELECT * FROM products WHERE slug = ?", slug);
  assert(product, "Admin-created product should exist.");
  return product;
}
async function cleanup() {
  await app.db.transaction(async tx => {
    const products = await tx.all("SELECT id FROM products WHERE slug LIKE ?", `${prefix}%`);
    const ids = products.map(product => product.id);
    if (ids.length) {
      await tx.run(`DELETE FROM cart_items WHERE product_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      await tx.run(`DELETE FROM wishlist_items WHERE product_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      await tx.run(`DELETE FROM reviews WHERE product_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      await tx.run(`DELETE FROM order_items WHERE product_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      await tx.run(`DELETE FROM products WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    }
    const users = await tx.all("SELECT id FROM users WHERE email LIKE ?", `${prefix}%@example.test`);
    const userIds = users.map(user => user.id);
    if (userIds.length) {
      const orders = await tx.all(`SELECT id FROM orders WHERE user_id IN (${userIds.map(() => "?").join(",")})`, ...userIds);
      if (orders.length) await tx.run(`DELETE FROM notifications WHERE order_id IN (${orders.map(() => "?").join(",")})`, ...orders.map(order => order.id));
      await tx.run(`DELETE FROM orders WHERE user_id IN (${userIds.map(() => "?").join(",")})`, ...userIds);
      await tx.run(`DELETE FROM sessions WHERE user_id IN (${userIds.map(() => "?").join(",")})`, ...userIds);
      await tx.run(`DELETE FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`, ...userIds);
    }
    await tx.run("DELETE FROM sessions WHERE id LIKE ?", `${prefix}%`);
    await tx.run("DELETE FROM coupons WHERE code LIKE ?", `${prefix.toUpperCase()}%`);
  });
}

async function main() {
  await start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await get("/healthz"); assert.equal(health.response.status, 200); assert.equal(health.html, "ok");
    const home = await get("/"); assert.equal(home.response.status, 200); assert.match(home.html, /PrintOasis/);
    const listing = await get("/products"); assert.equal(listing.response.status, 200);

    const admin = await login("postgres-smoke-admin@example.test", "PostgresSmokeAdmin123!");
    const product = await createProduct(admin, `${prefix}-card`, 2);
    const detail = await get(`/product/${product.slug}`); assert.equal(detail.response.status, 200);

    const customer = await register("Postgres Smoke Customer", `${prefix}-customer@example.test`);
    await addToCart(customer, product, 2);
    let inventory = await app.db.get("SELECT stock, reserved FROM products WHERE id = ?", product.id);
    assert.deepEqual({ stock: Number(inventory.stock), reserved: Number(inventory.reserved) }, { stock: 2, reserved: 2 }, "Cart reservation must not deduct physical stock.");

    restoredAssertions += await assertSequentialOversell({ app, get, post, csrf, product, customer });
    const cart = await get("/cart", customer);
    const itemId = cart.html.match(/name="item_id" value="(\d+)"/)[1];
    await post("/cart/update", { csrf: csrf(cart.html), item_id: itemId, quantity: "1" }, cart.cookie);
    inventory = await app.db.get("SELECT stock, reserved FROM products WHERE id = ?", product.id);
    assert.deepEqual({ stock: Number(inventory.stock), reserved: Number(inventory.reserved) }, { stock: 2, reserved: 1 }, "Quantity decrease must release one reservation.");

    const checkout = await get("/checkout", customer);
    const completed = await post("/checkout", { csrf: csrf(checkout.html), customer_name: "Postgres Smoke Customer", phone: "9876500000", address: "1 Test Lane", city: "Bengaluru", postal_code: "560001", payment_method: "cod" }, checkout.cookie);
    assert.equal(completed.response.status, 303, "Checkout should redirect.");
    const order = await app.db.get("SELECT * FROM orders WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1", `${prefix}-customer@example.test`);
    assert(order, "Checkout should create an order.");
    inventory = await app.db.get("SELECT stock, reserved FROM products WHERE id = ?", product.id);
    assert.deepEqual({ stock: Number(inventory.stock), reserved: Number(inventory.reserved) }, { stock: 1, reserved: 0 }, "Checkout must convert the reservation into physical-stock deduction.");

    const adminOrders = await get("/admin/orders", admin);
    const cancellation = await post("/admin/orders/status", { csrf: csrf(adminOrders.html), order_id: order.id, status: "Cancelled", note: "Smoke cancellation" }, adminOrders.cookie);
    assert.equal(cancellation.response.status, 303, "Cancellation should redirect.");
    inventory = await app.db.get("SELECT stock, reserved FROM products WHERE id = ?", product.id);
    const cancelled = await app.db.get("SELECT inventory_restocked FROM orders WHERE id = ?", order.id);
    assert.deepEqual({ stock: Number(inventory.stock), reserved: Number(inventory.reserved), restocked: Number(cancelled.inventory_restocked) }, { stock: 2, reserved: 0, restocked: 1 }, "Cancellation must restock exactly once.");

    const paymentCustomer = await register("Payment Failure", `${prefix}-payment@example.test`);
    await addToCart(paymentCustomer, product, 1);
    let paymentCart = await get("/cart", paymentCustomer);
    const paymentFailed = await post("/payment/failed", { csrf: csrf(paymentCart.html) }, paymentCart.cookie);
    assert.equal(paymentFailed.response.status, 200, "Payment failure endpoint should respond.");
    inventory = await app.db.get("SELECT reserved FROM products WHERE id = ?", product.id);
    assert.equal(Number(inventory.reserved), 0, "Failed payment must release its reservation.");

    const logoutCustomer = await register("Logout Release", `${prefix}-logout@example.test`);
    await addToCart(logoutCustomer, product, 1);
    let logoutPage = await get("/account", logoutCustomer);
    const logout = await post("/logout", { csrf: csrf(logoutPage.html) }, logoutPage.cookie);
    assert.equal(logout.response.status, 303, "Logout should redirect.");
    inventory = await app.db.get("SELECT reserved FROM products WHERE id = ?", product.id);
    assert.equal(Number(inventory.reserved), 0, "Logout must release reservations.");

    const coupon = `${prefix.toUpperCase()}-5`;
    await app.db.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,usage_limit,active) VALUES (?,?,?,?,?,?,1)", coupon, "fixed", 5, 0, 0, 1);
    const rollbackCode = `${prefix.toUpperCase()}-ROLLBACK`;
    try { await app.db.transaction(async tx => { await tx.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,active) VALUES (?,?,?,?,?,1)", rollbackCode, "fixed", 1, 0, 0); throw new Error("intentional rollback"); }); } catch (error) { assert.equal(error.message, "intentional rollback"); }
    assert.equal(await app.db.get("SELECT code FROM coupons WHERE code = ?", rollbackCode), undefined, "Failed transaction must roll back.");

    await addToCart(customer, product, 1);
    const couponCheckout = await get("/checkout", customer);
    const secondCheckout = await post("/checkout", { csrf: csrf(couponCheckout.html), customer_name: "Postgres Smoke Customer", phone: "9876500000", address: "1 Test Lane", city: "Bengaluru", postal_code: "560001", payment_method: "cod", coupon_code: coupon }, couponCheckout.cookie);
    assert.equal(secondCheckout.response.status, 303, "Coupon checkout should redirect.");
    const deliveredOrder = await app.db.get("SELECT * FROM orders WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1", `${prefix}-customer@example.test`);
    const couponUsage = await app.db.get("SELECT times_used FROM coupons WHERE code = ?", coupon);
    assert.equal(Number(couponUsage.times_used), 1, "Coupon usage should be accounted during checkout.");
    const statusPage = await get("/admin/orders", admin);
    await post("/admin/orders/status", { csrf: csrf(statusPage.html), order_id: deliveredOrder.id, status: "Delivered", note: "Smoke delivery" }, statusPage.cookie);
    const orderPage = await get(`/account/orders/${deliveredOrder.id}`, customer);
    const review = await post("/account/reviews/save", { csrf: csrf(orderPage.html), order_id: deliveredOrder.id, product_id: product.id, rating: "5", comment: "A verified PostgreSQL smoke-test review." }, orderPage.cookie);
    assert.equal(review.response.status, 303, "Verified review should redirect.");
    const savedReview = await app.db.get("SELECT verified_purchase FROM reviews WHERE user_id = (SELECT id FROM users WHERE email = ?) AND product_id = ?", `${prefix}-customer@example.test`, product.id);
    assert.equal(Number(savedReview.verified_purchase), 1, "Delivered customers must be able to submit verified reviews.");

    const reservationProduct = await createProduct(admin, `${prefix}-concurrent`, 1);
    const first = await register("Concurrent One", `${prefix}-one@example.test`), second = await register("Concurrent Two", `${prefix}-two@example.test`);
    await Promise.all([addToCart(first, reservationProduct), addToCart(second, reservationProduct)]);
    const concurrent = await app.db.get("SELECT stock, reserved FROM products WHERE id = ?", reservationProduct.id);
    const reservedItems = await app.db.get("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE product_id = ?", reservationProduct.id);
    assert.equal(Number(concurrent.reserved), 1, "Concurrent reservations must never exceed physical stock.");
    assert.equal(Number(reservedItems.quantity), 1, "Exactly one concurrent reservation should succeed.");
    await app.db.run("UPDATE sessions SET expires_at = 0 WHERE id IN (?, ?)", sessionId(first), sessionId(second));
    // The expired cookie intentionally triggers getSession's forced cleanup path.
    await get("/", first);
    const released = await app.db.get("SELECT reserved FROM products WHERE id = ?", reservationProduct.id);
    assert.equal(Number(released.reserved), 0, "Expired sessions must release reservations.");

    const visible = await get("/products?category=marketing"); assert.equal(visible.response.status, 200);
    const hidden = await post("/admin/products/delete", { csrf: csrf(await (await get("/admin/products", admin)).html), id: reservationProduct.id }, admin);
    assert.equal(hidden.response.status, 303, "Admin hide should redirect.");
    const hiddenPage = await get(`/product/${reservationProduct.slug}`); assert.equal(hiddenPage.response.status, 404, "Hidden products must not be purchasable.");
    restoredAssertions += await runRegression({ app, get, post, csrf, prefix, admin, customer, product, deliveredOrder, register, login, addToCart, sessionId, createProduct });
    console.log(`PASS PostgreSQL smoke: existing PostgreSQL stages plus restored regression assertions (${restoredAssertions}).`);
  } finally { await cleanup(); await shutdown("postgres smoke"); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });