const assert = require("node:assert/strict");
const { createEmailService, orderEmailTemplate } = require("../services/email");

function checks() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); },
    match(value, pattern, message) { count += 1; assert.match(value, pattern, message); }
  };
}

async function assertSequentialOversell({ app, get, post, csrf, product, customer }) {
  const c = checks();
  const form = await get(`/product/${product.slug}`, customer);
  const result = await post("/cart/add", { csrf: csrf(form.html), product_id: product.id, quantity: "1", size: "A4", material: "Matte", print_option: "Full color" }, form.cookie);
  c.equal(result.response.status, 303, "Sequential oversell attempt redirects.");
  c.match(decodeURIComponent(result.response.headers.get("location") || ""), /Only 0 items available|out of stock/i, "Sequential oversell attempt is rejected.");
  const stock = await app.db.get("SELECT stock,reserved FROM products WHERE id=?", product.id);
  c.ok(Number(stock.stock) >= 0 && Number(stock.reserved) >= 0 && Number(stock.reserved) <= Number(stock.stock), "Stock and reserved quantities remain within invariants.");
  return c.count;
}

async function runRegression({ app, get, post, csrf, prefix, admin, customer, product, deliveredOrder, register, login, addToCart, sessionId, createProduct }) {
  const c = checks();
  const home = await get("/"); c.match(home.html, /data-carousel/, "Homepage carousel is rendered."); c.match(home.html, /hero-slide/, "Homepage has carousel slides.");
  const dashboard = await get("/admin", admin); c.equal(dashboard.response.status, 200, "Admin dashboard is accessible."); c.match(dashboard.html, /Operations dashboard/, "Admin dashboard content is rendered.");

  const couponPage = () => get("/admin/coupons", admin);
  const saveCoupon = (page, code, value, opts = {}) => post("/admin/coupons/save", { csrf: csrf(page.html), original_code: opts.original || "", code, type: "fixed", value: String(value), minimum_order: "0", maximum_discount: "", expiry_date: opts.expiry || "", usage_limit: "", active: "1" }, page.cookie);
  const managed = `${prefix.toUpperCase()}M`, expired = `${prefix.toUpperCase()}E`, remove = `${prefix.toUpperCase()}D`;
  let page = await couponPage(); c.equal((await saveCoupon(page, managed, 5)).response.status, 303, "Admin creates coupon.");
  c.ok(await app.db.get("SELECT code FROM coupons WHERE code=?", managed), "Created coupon is persisted.");
  page = await get(`/admin/coupons?edit=${encodeURIComponent(managed)}`, admin); c.match(page.html, new RegExp(`name="original_code" value="${managed}"`), "Admin coupon edit form loads.");
  await saveCoupon(page, managed, 7, { original: managed }); c.equal(Number((await app.db.get("SELECT value FROM coupons WHERE code=?", managed)).value), 7, "Admin coupon edit persists.");
  page = await couponPage(); await post("/admin/coupons/toggle", { csrf: csrf(page.html), code: managed }, page.cookie);
  c.equal(Number((await app.db.get("SELECT active FROM coupons WHERE code=?", managed)).active), 0, "Admin disables coupon.");
  page = await couponPage(); await post("/admin/coupons/toggle", { csrf: csrf(page.html), code: managed }, page.cookie);
  c.equal(Number((await app.db.get("SELECT active FROM coupons WHERE code=?", managed)).active), 1, "Admin enables coupon.");
  page = await couponPage(); await saveCoupon(page, remove, 5);
  page = await couponPage(); await post("/admin/coupons/delete", { csrf: csrf(page.html), code: remove }, page.cookie);
  c.equal(await app.db.get("SELECT code FROM coupons WHERE code=?", remove), undefined, "Admin deletes coupon.");
  const expiredOn = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  page = await couponPage(); await saveCoupon(page, expired, 5, { expiry: expiredOn });
  await addToCart(customer, product, 1);
  c.match((await get(`/checkout?coupon_code=${encodeURIComponent(expired)}`, customer)).html, /This coupon has expired\./, "Expired coupon is rejected in checkout.");
  let cart = await get("/cart", customer), itemId = cart.html.match(/name="item_id" value="(\d+)"/)[1];
  await post("/cart/update", { csrf: csrf(cart.html), item_id: itemId, quantity: "0" }, cart.cookie);

  page = await get("/account/addresses", customer);
  c.equal((await post("/account/addresses/save", { csrf: csrf(page.html), label: "Smoke Home", recipient_name: "Postgres Smoke Customer", phone: "9876500000", address: "42 Test Avenue", city: "Bengaluru", postal_code: "560002", is_default: "1" }, page.cookie)).response.status, 303, "Customer saves address.");
  const address = await app.db.get("SELECT * FROM addresses WHERE user_id=(SELECT id FROM users WHERE email=?) AND label=?", `${prefix}-customer@example.test`, "Smoke Home");
  c.ok(address && Number(address.is_default) === 1, "Saved address is default.");
  await addToCart(customer, product, 1);
  const checkout = await get("/checkout", customer);
  c.match(checkout.html, /value="Postgres Smoke Customer"/, "Checkout prefills recipient."); c.match(checkout.html, /42 Test Avenue/, "Checkout prefills street address."); c.match(checkout.html, /value="560002"/, "Checkout prefills postal code.");
  cart = await get("/cart", customer); itemId = cart.html.match(/name="item_id" value="(\d+)"/)[1];
  await post("/cart/update", { csrf: csrf(cart.html), item_id: itemId, quantity: "0" }, cart.cookie);

  const search = await get(`/products?q=${encodeURIComponent(product.name)}`); c.match(search.html, /Postgres Smoke/, "Product search finds the smoke product.");
  const filtered = await get(`/account/orders?q=${encodeURIComponent(product.name)}&status=Delivered`, customer);
  c.match(filtered.html, new RegExp(deliveredOrder.order_number), "Order search and status filter match the delivered order."); c.match(filtered.html, /Filter orders/, "Order filter UI renders.");
  c.match((await get("/account/orders?status=Cancelled", customer)).html, /Cancelled/, "Cancelled-order filter renders matching data.");

  page = await get("/admin/orders", admin);
  c.equal((await post("/admin/orders/status", { csrf: csrf(page.html), order_id: deliveredOrder.id, status: "Shipped", courier_name: "Smoke Courier", tracking_number: `${prefix.toUpperCase()}-TRACK`, tracking_url: "https://example.test/track", estimated_delivery: "2030-12-31", note: "Smoke dispatch" }, page.cookie)).response.status, 303, "Admin updates shipment details.");
  let notice = await app.db.get("SELECT * FROM notifications WHERE order_id=? AND event='shipping_update' ORDER BY id DESC LIMIT 1", deliveredOrder.id);
  c.ok(notice && notice.body.includes("Smoke Courier") && notice.body.includes(`${prefix.toUpperCase()}-TRACK`) && notice.body.includes("https://example.test/track"), "Shipment notification includes delivery details.");
  page = await get("/track", customer);
  const track = await post("/track", { csrf: csrf(page.html), order_number: deliveredOrder.order_number, phone: "9876500000" }, page.cookie);
  c.equal(track.response.status, 200, "Customer tracking lookup responds."); c.match(track.html, /Shipped/, "Tracking displays current status."); c.match(track.html, new RegExp(`${prefix.toUpperCase()}-TRACK`), "Tracking displays number."); c.match(track.html, /Smoke Courier/, "Tracking displays courier."); c.match(track.html, /example\.test\/track/, "Tracking displays URL.");
  const invoice = await get(`/invoice/${encodeURIComponent(deliveredOrder.order_number)}`, customer);
  c.equal(invoice.response.status, 200, "Customer can view invoice."); c.match(invoice.html, /GST INVOICE/, "Invoice heading renders."); c.match(invoice.html, new RegExp(deliveredOrder.order_number), "Invoice identifies order.");
  page = await get("/admin/orders", admin); await post("/admin/orders/status", { csrf: csrf(page.html), order_id: deliveredOrder.id, status: "Delivered", note: "Smoke delivered" }, page.cookie);
  const delivered = await app.db.get("SELECT * FROM notifications WHERE order_id=? AND event='delivered' ORDER BY id DESC LIMIT 1", deliveredOrder.id);
  const reminder = await app.db.get("SELECT * FROM notifications WHERE order_id=? AND event='review_reminder' ORDER BY id DESC LIMIT 1", deliveredOrder.id);
  c.ok(delivered && delivered.body.includes(deliveredOrder.order_number), "Delivery notification is recorded."); c.ok(reminder && reminder.body.includes(product.name), "Review reminder includes purchased item.");
  const faq = await get("/faq"); c.equal(faq.response.status, 200, "FAQ route succeeds."); c.match(faq.html, /Straight answers for every print order/, "FAQ heading renders."); c.match(faq.html, /How do I place an order\?/, "FAQ content renders.");

  const review = await app.db.get("SELECT * FROM reviews WHERE user_id=(SELECT id FROM users WHERE email=?) AND product_id=?", `${prefix}-customer@example.test`, product.id);
  c.ok(review && Number(review.verified_purchase) === 1, "Review is purchase-verified."); c.match((await get(`/product/${product.slug}`, customer)).html, /Verified Purchase/, "Verified-review badge renders.");
  const countReviews = async () => Number((await app.db.get("SELECT COUNT(*) AS count FROM reviews WHERE user_id=(SELECT id FROM users WHERE email=?) AND product_id=?", `${prefix}-customer@example.test`, product.id)).count);
  page = await get(`/product/${product.slug}`, customer); await post("/reviews/add", { csrf: csrf(page.html), product_id: product.id, rating: "4", comment: "A duplicate review must not be added." }, page.cookie);
  c.equal(await countReviews(), 1, "Duplicate review is prevented.");
  const other = await register("Review Access Tester", `${prefix}-review-other@example.test`);
  c.equal((await post("/account/reviews/save", { csrf: csrf((await get("/account", other)).html), order_id: deliveredOrder.id, product_id: product.id, rating: "1", comment: "Unauthorized review edit attempt." }, other)).response.status, 303, "Review ownership blocks another customer.");
  c.equal(Number((await app.db.get("SELECT rating FROM reviews WHERE id=?", review.id)).rating), Number(review.rating), "Unauthorized edit leaves review unchanged.");
  page = await get(`/account/orders/${deliveredOrder.id}`, customer);
  c.equal((await post("/account/reviews/save", { csrf: csrf(page.html), order_id: deliveredOrder.id, product_id: product.id, rating: "4", comment: "Owner updated this verified review." }, page.cookie)).response.status, 303, "Review owner can edit.");
  c.equal(Number((await app.db.get("SELECT rating FROM reviews WHERE id=?", review.id)).rating), 4, "Review edit persists.");
  page = await get(`/account/orders/${deliveredOrder.id}`, customer);
  c.equal((await post("/account/reviews/delete", { csrf: csrf(page.html), order_id: deliveredOrder.id, review_id: review.id }, page.cookie)).response.status, 303, "Review owner can delete."); c.equal(await countReviews(), 0, "Review delete persists.");

  const wishProduct = await createProduct(admin, `${prefix}-wishlist`, 3);
  page = await get(`/product/${wishProduct.slug}`, customer); await post("/wishlist/toggle", { csrf: csrf(page.html), product_id: wishProduct.id }, page.cookie);
  const wishlistCount = async () => Number((await app.db.get("SELECT COUNT(*) AS count FROM wishlist_items WHERE user_id=(SELECT id FROM users WHERE email=?) AND product_id=?", `${prefix}-customer@example.test`, wishProduct.id)).count);
  c.equal(await wishlistCount(), 1, "Wishlist add creates one saved item.");
  const duplicateWish = await app.db.run("INSERT INTO wishlist_items (user_id,product_id,saved_price) VALUES ((SELECT id FROM users WHERE email=?),?,?) ON CONFLICT (user_id,product_id) DO NOTHING", `${prefix}-customer@example.test`, wishProduct.id, wishProduct.price);
  c.equal(duplicateWish.changes, 0, "Wishlist duplicate insert is ignored by its unique key.");
  page = await get("/wishlist", customer); c.match(page.html, /Postgres Smoke/, "Wishlist page lists saved product.");
  c.equal((await post("/wishlist/move-to-cart", { csrf: csrf(page.html), product_id: wishProduct.id }, page.cookie)).response.status, 303, "Wishlist item moves to cart.");
  c.equal(await wishlistCount(), 0, "Move-to-cart removes saved item.");
  c.ok(await app.db.get("SELECT id FROM cart_items WHERE session_id=? AND product_id=?", sessionId(customer), wishProduct.id), "Move-to-cart creates cart item.");
  const wishInventory = await app.db.get("SELECT stock,reserved FROM products WHERE id=?", wishProduct.id);
  c.ok(Number(wishInventory.stock) >= 0 && Number(wishInventory.reserved) >= 0 && Number(wishInventory.reserved) <= Number(wishInventory.stock), "Wishlist reservation respects inventory bounds.");

  page = await get("/account/password", customer);
  c.equal((await post("/account/password", { csrf: csrf(page.html), current_password: "Testing123!", new_password: "Testing456!", confirm_password: "Testing456!" }, page.cookie)).response.status, 303, "Password change succeeds.");
  c.ok((await login(`${prefix}-customer@example.test`, "Testing456!")).startsWith("sid="), "New password authenticates.");
  const reorderPage = await get(`/account/orders?q=${encodeURIComponent(product.name)}&status=Delivered`, customer);
  c.equal((await post("/account/orders/reorder", { csrf: csrf(reorderPage.html), order_id: deliveredOrder.id }, reorderPage.cookie)).response.status, 303, "Customer can reorder.");
  c.ok(await app.db.get("SELECT id FROM cart_items WHERE session_id=? AND product_id=?", sessionId(customer), product.id), "Reorder adds prior product to cart.");

  const configuredEmail = createEmailService({ enabled: true, host: "smtp.example.test", port: 587, secure: false, from: "orders@example.test" });
  c.equal(configuredEmail.configured, true, "Email service recognizes SMTP configuration without connecting.");
  const disabledEmail = createEmailService({ enabled: false, host: "smtp.example.test", port: 587, secure: false, from: "orders@example.test" });
  c.equal((await disabledEmail.send({ to: "customer@example.test", subject: "Test", text: "Test" })).skipped, true, "Disabled email delivery skips safely.");
  const emailOrder = { id: 1, order_number: "PO-TEST", customer_name: "QA <script>", total: 500, courier_name: "Test Courier", tracking_number: "TRACK-1", tracking_url: "https://example.test/track?a=1&b=2", estimated_delivery: "2030-12-31", status: "Shipped" };
  const shippingMail = orderEmailTemplate({ event: "shipping_update", order: emailOrder, items: [{ product_id: product.id, product_name: product.name, quantity: 1 }], note: "Packed", baseUrl: "https://printoasis.example", money: amount => `Rs ${amount}` });
  c.match(shippingMail.subject, /PO-TEST is on the way/, "Shipping email subject."); c.match(shippingMail.text, /TRACK-1/, "Shipping email tracking details."); c.match(shippingMail.html, /&lt;script&gt;/, "Email HTML escapes customer values.");
  const deliveredMail = orderEmailTemplate({ event: "delivered", order: emailOrder, items: [{ product_id: product.id, product_name: product.name, quantity: 2 }], baseUrl: "https://printoasis.example", money: amount => `Rs ${amount}` });
  c.match(deliveredMail.html, new RegExp(product.name), "Delivery email item summary.");
  const reviewMail = orderEmailTemplate({ event: "review_reminder", order: emailOrder, items: [{ product_id: product.id, product_name: product.name, quantity: 1 }], baseUrl: "https://printoasis.example", money: amount => `Rs ${amount}` });
  c.match(reviewMail.text, /Review your products/, "Review reminder email content.");
  return c.count;
}

module.exports = { assertSequentialOversell, runRegression };