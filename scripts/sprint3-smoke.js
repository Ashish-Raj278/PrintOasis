const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const { createEmailService, orderEmailTemplate } = require("../services/email");

const task = process.argv[2];
const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3112";
const db = new DatabaseSync("data/store.db");

async function task4() {
  const product = db.prepare("SELECT id, slug FROM products WHERE active = 1 AND status != 'hidden' LIMIT 1").get();
  if (!product) throw new Error("No visible product is available for the review test.");
  db.prepare("DELETE FROM reviews WHERE name = ?").run("Verified Badge Smoke");
  try {
    db.prepare("INSERT INTO reviews (product_id,name,rating,comment,approved,verified_purchase) VALUES (?,?,?,?,1,1)")
      .run(product.id, "Verified Badge Smoke", 5, "Verified purchase badge smoke review.");
    const response = await fetch(`${baseUrl}/product/${product.slug}`);
    const html = await response.text();
    if (!response.ok || !html.includes("Verified Purchase")) throw new Error("Verified purchase badge did not render.");
    console.log("PASS task4=verified-purchase-badge");
  } finally {
    db.prepare("DELETE FROM reviews WHERE name = ?").run("Verified Badge Smoke");
  }
}

async function task5() {
  const stamp = Date.now();
  const product = db.prepare("SELECT id FROM products WHERE active = 1 AND status != 'hidden' LIMIT 1").get();
  if (!product) throw new Error("No visible product is available for the review test.");
  const ownerEmail = `task5-owner-${stamp}@example.com`;
  const otherEmail = `task5-other-${stamp}@example.com`;
  let owner;
  let other;
  let order;
  try {
    owner = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Task Five Owner", ownerEmail, "test").lastInsertRowid);
    other = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Task Five Other", otherEmail, "test").lastInsertRowid);
    const ownerSession = `task5-owner-${stamp}`;
    const otherSession = `task5-other-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(ownerSession, owner, "task5-owner-csrf", Date.now() + 60000);
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(otherSession, other, "task5-other-csrf", Date.now() + 60000);
    order = Number(db.prepare("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`T5-${stamp}`, owner, 500, "Delivered", "Task Five Owner", "9876543210", "1 Test Street", "Bengaluru", "560001", "cod").lastInsertRowid);
    db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)").run(order, product.id, "Task Five Product", 1, 500, "A4 · Matte · Full color");

    const post = (sid, csrf, values) => fetch(`${baseUrl}/account/reviews/save`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `sid=${sid}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, order_id: String(order), product_id: String(product.id), ...values })
    });
    const created = await post(ownerSession, "task5-owner-csrf", { rating: "4", comment: "This review was created from the delivered order." });
    if (![302, 303].includes(created.status)) throw new Error(`Owner review creation failed with ${created.status}: ${(await created.text()).slice(0, 400)}`);
    const initial = db.prepare("SELECT id,rating,comment,verified_purchase FROM reviews WHERE user_id = ? AND product_id = ?").get(owner, product.id);
    if (!initial || initial.rating !== 4 || initial.verified_purchase !== 1) throw new Error("Verified review was not created.");

    const updated = await post(ownerSession, "task5-owner-csrf", { rating: "5", comment: "This review was updated from the delivered order." });
    if (![302, 303].includes(updated.status)) throw new Error("Owner review update did not redirect.");
    const afterUpdate = db.prepare("SELECT COUNT(*) count, rating, comment FROM reviews WHERE user_id = ? AND product_id = ?").get(owner, product.id);
    if (afterUpdate.count !== 1 || afterUpdate.rating !== 5 || !afterUpdate.comment.includes("updated")) throw new Error("Review update did not preserve duplicate prevention.");

    const forbidden = await post(otherSession, "task5-other-csrf", { rating: "1", comment: "Another customer must not change this review." });
    if (![302, 303].includes(forbidden.status)) throw new Error("Unauthorized review request did not redirect.");
    const final = db.prepare("SELECT rating,comment FROM reviews WHERE id = ?").get(initial.id);
    if (final.rating !== 5 || !final.comment.includes("updated")) throw new Error("A non-owner changed a review.");
    console.log("PASS task5=owner-edit-verified-duplicate-protected");
  } finally {
    if (owner) db.prepare("DELETE FROM reviews WHERE user_id = ?").run(owner);
    if (order) db.prepare("DELETE FROM orders WHERE id = ?").run(order);
    db.prepare("DELETE FROM sessions WHERE id LIKE 'task5-%'").run();
    if (owner) db.prepare("DELETE FROM users WHERE id = ?").run(owner);
    if (other) db.prepare("DELETE FROM users WHERE id = ?").run(other);
  }
}

async function task6() {
  const stamp = Date.now();
  const product = db.prepare("SELECT id, slug FROM products WHERE active = 1 AND status != 'hidden' LIMIT 1").get();
  if (!product) throw new Error("No visible product is available for the review UI test.");
  const email = `task6-${stamp}@example.com`;
  let user;
  let order;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Task Six User", email, "test").lastInsertRowid);
    const sessionId = `task6-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task6-csrf", Date.now() + 60000);
    order = Number(db.prepare("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`T6-${stamp}`, user, 500, "Delivered", "Task Six User", "9876543210", "1 Test Street", "Bengaluru", "560001", "cod").lastInsertRowid);
    db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)").run(order, product.id, "Task Six Product", 1, 500, "A4 · Matte · Full color");
    db.prepare("INSERT INTO reviews (product_id,user_id,name,rating,comment,approved,verified_purchase) VALUES (?,?,?,?,?,1,1)").run(product.id, user, "Task Six User", 4, "A review that should be prefilled in order details.");
    const response = await fetch(`${baseUrl}/account/orders/${order}`, { headers: { Cookie: `sid=${sessionId}` } });
    const html = await response.text();
    if (!response.ok || !html.includes('action="/account/reviews/save"') || !html.includes('value="4" selected') || !html.includes("prefilled in order details") || !html.includes('action="/account/reviews/delete"')) throw new Error("Order Details review edit UI was not rendered with existing values.");
    console.log("PASS task6=order-details-review-ui-prefilled");
  } finally {
    if (user) db.prepare("DELETE FROM reviews WHERE user_id = ?").run(user);
    if (order) db.prepare("DELETE FROM orders WHERE id = ?").run(order);
    db.prepare("DELETE FROM sessions WHERE id LIKE 'task6-%'").run();
    if (user) db.prepare("DELETE FROM users WHERE id = ?").run(user);
  }
}

async function task7() {
  const stamp = Date.now();
  const product = db.prepare("SELECT id FROM products WHERE active = 1 AND status != 'hidden' LIMIT 1").get();
  if (!product) throw new Error("No visible product is available for the review deletion test.");
  const email = `task7-${stamp}@example.com`;
  let user;
  let order;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Task Seven User", email, "test").lastInsertRowid);
    const sessionId = `task7-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task7-csrf", Date.now() + 60000);
    order = Number(db.prepare("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`T7-${stamp}`, user, 500, "Delivered", "Task Seven User", "9876543210", "1 Test Street", "Bengaluru", "560001", "cod").lastInsertRowid);
    db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)").run(order, product.id, "Task Seven Product", 1, 500, "A4 · Matte · Full color");
    const reviewId = Number(db.prepare("INSERT INTO reviews (product_id,user_id,name,rating,comment,approved,verified_purchase) VALUES (?,?,?,?,?,1,1)").run(product.id, user, "Task Seven User", 5, "A review that will be deleted from order details.").lastInsertRowid);
    const response = await fetch(`${baseUrl}/account/reviews/delete`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `sid=${sessionId}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "task7-csrf", order_id: String(order), review_id: String(reviewId) })
    });
    if (![302, 303].includes(response.status)) throw new Error("Review deletion did not redirect.");
    if (db.prepare("SELECT id FROM reviews WHERE id = ?").get(reviewId)) throw new Error("Review was not deleted by its owner.");
    console.log("PASS task7=owner-delete-review");
  } finally {
    if (user) db.prepare("DELETE FROM reviews WHERE user_id = ?").run(user);
    if (order) db.prepare("DELETE FROM orders WHERE id = ?").run(order);
    db.prepare("DELETE FROM sessions WHERE id LIKE 'task7-%'").run();
    if (user) db.prepare("DELETE FROM users WHERE id = ?").run(user);
  }
}

async function task8() {
  const columns = db.prepare("PRAGMA table_info(coupons)").all().map(column => column.name);
  const required = ["code", "type", "value", "minimum_order", "maximum_discount", "expiry_date", "usage_limit", "times_used", "active", "created_at"];
  if (required.some(column => !columns.includes(column))) throw new Error("Coupon schema is missing required columns.");
  console.log("PASS task8=coupon-schema");
}

async function task9() {
  const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get();
  if (!admin) throw new Error("No admin user is available for the coupon test.");
  const stamp = Date.now();
  const code = `T9-${stamp}`;
  const sessionId = `task9-${stamp}`;
  try {
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, admin.id, "task9-csrf", Date.now() + 60000);
    const page = await fetch(`${baseUrl}/admin/coupons`, { headers: { Cookie: `sid=${sessionId}` } });
    if (!page.ok || !(await page.text()).includes("Coupon manager")) throw new Error("Coupon manager page did not render.");
    const post = async (path, values) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { Cookie: `sid=${sessionId}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task9-csrf", ...values }) });
    const created = await post("/admin/coupons/save", { code, type: "percent", value: "15", minimum_order: "500", maximum_discount: "200", usage_limit: "3", active: "1" });
    if (![302, 303].includes(created.status)) throw new Error("Coupon creation did not redirect.");
    const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(code);
    if (!coupon || coupon.value !== 15 || coupon.minimum_order !== 500 || coupon.maximum_discount !== 200 || coupon.usage_limit !== 3) throw new Error("Coupon was not saved correctly.");
    await post("/admin/coupons/toggle", { code });
    if (db.prepare("SELECT active FROM coupons WHERE code = ?").get(code).active !== 0) throw new Error("Coupon disable action failed.");
    await post("/admin/coupons/delete", { code });
    if (db.prepare("SELECT code FROM coupons WHERE code = ?").get(code)) throw new Error("Coupon deletion failed.");
    console.log("PASS task9=admin-coupon-crud");
  } finally {
    db.prepare("DELETE FROM coupons WHERE code = ?").run(code);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
}

async function task10() {
  const stamp = Date.now();
  const product = db.prepare("SELECT * FROM products WHERE active = 1 AND status != 'hidden' AND stock - reserved >= 1 LIMIT 1").get();
  if (!product) throw new Error("No available product is available for the coupon checkout test.");
  const code = `T10-${stamp}`;
  const expiredCode = `T10X-${stamp}`;
  const email = `task10-${stamp}@example.com`;
  let user;
  let order;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Task Ten User", email, "test").lastInsertRowid);
    const sessionId = `task10-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task10-csrf", Date.now() + 60000);
    db.prepare("INSERT INTO coupons (code,type,value,min_total,minimum_order,maximum_discount,usage_limit,active) VALUES (?,?,?,?,?,?,?,1)").run(code, "fixed", 1, 0, 0, null, 1);
    db.prepare("INSERT INTO coupons (code,type,value,min_total,minimum_order,expiry_date,active) VALUES (?,?,?,?,?,?,1)").run(expiredCode, "fixed", 1, 0, 0, "2000-01-01");
    db.prepare("INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price) VALUES (?,?,?,?,?,?,?)").run(sessionId, product.id, 1, String(product.sizes).split("|")[0], String(product.materials).split("|")[0], String(product.print_options).split("|")[0], product.price / product.min_qty);
    db.prepare("UPDATE products SET reserved = reserved + 1 WHERE id = ?").run(product.id);
    const cookie = { Cookie: `sid=${sessionId}` };
    const validPage = await fetch(`${baseUrl}/checkout?coupon_code=${code}`, { headers: cookie });
    if (!validPage.ok || !(await validPage.text()).includes(`${code} applied`)) throw new Error("Valid coupon feedback did not render.");
    const expiredPage = await fetch(`${baseUrl}/checkout?coupon_code=${expiredCode}`, { headers: cookie });
    if (!expiredPage.ok || !(await expiredPage.text()).includes("This coupon has expired.")) throw new Error("Expired coupon validation did not render.");
    const checkout = await fetch(`${baseUrl}/checkout`, { method: "POST", redirect: "manual", headers: { ...cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task10-csrf", customer_name: "Task Ten User", phone: "9876543210", address: "1 Test Street", city: "Bengaluru", postal_code: "560001", payment_method: "cod", coupon_code: code }) });
    if (![302, 303].includes(checkout.status)) throw new Error("Coupon checkout did not redirect.");
    order = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user);
    const coupon = db.prepare("SELECT times_used FROM coupons WHERE code = ?").get(code);
    if (!order || order.coupon_code !== code || order.discount !== 1 || coupon.times_used !== 1) throw new Error("Coupon discount or successful-payment usage accounting failed.");
    console.log("PASS task10=validation task11=checkout-coupon-accounting");
  } finally {
    if (order) db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(1, product.id);
    if (user) db.prepare("DELETE FROM cart_items WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)").run(user);
    if (order) db.prepare("DELETE FROM orders WHERE id = ?").run(order.id);
    db.prepare("UPDATE products SET reserved = CASE WHEN reserved < 0 THEN 0 ELSE reserved END WHERE id = ?").run(product.id);
    db.prepare("DELETE FROM coupons WHERE code IN (?, ?)").run(code, expiredCode);
    if (user) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user);
    if (user) db.prepare("DELETE FROM users WHERE id = ?").run(user);
  }
}

async function task12to15() {
  const stamp = Date.now();
  const product = db.prepare("SELECT * FROM products WHERE active = 1 AND status != 'hidden' AND stock - reserved >= 1 LIMIT 1").get();
  if (!product) throw new Error("No available product is available for the wishlist test.");
  const email = `task12-${stamp}@example.com`;
  let user;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Wishlist User", email, "test").lastInsertRowid);
    const sessionId = `task12-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task12-csrf", Date.now() + 60000);
    const post = (path, values) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { Cookie: `sid=${sessionId}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task12-csrf", ...values }) });
    const added = await post("/wishlist/toggle", { product_id: String(product.id), next: "/wishlist" });
    if (![302, 303].includes(added.status) || !db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(user, product.id)) throw new Error("Wishlist add or duplicate prevention failed.");
    const page = await fetch(`${baseUrl}/wishlist`, { headers: { Cookie: `sid=${sessionId}` } });
    const html = await page.text();
    if (!page.ok || !html.includes("Move to cart") || !html.includes("Price unchanged") || !html.includes("In Stock")) throw new Error("Wishlist UI indicators did not render.");
    const moved = await post("/wishlist/move-to-cart", { product_id: String(product.id) });
    if (![302, 303].includes(moved.status)) throw new Error("Wishlist move-to-cart did not redirect.");
    const cartItem = db.prepare("SELECT * FROM cart_items WHERE session_id = ? AND product_id = ?").get(sessionId, product.id);
    if (!cartItem || db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(user, product.id)) throw new Error("Wishlist move-to-cart did not transfer the item.");
    const reserved = db.prepare("SELECT reserved FROM products WHERE id = ?").get(product.id).reserved;
    if (reserved < cartItem.quantity) throw new Error("Wishlist move-to-cart did not use the cart reservation flow.");
    console.log("PASS task12=wishlist-storage task13=wishlist-ui task14=move-to-cart task15=price-stock-indicators");
  } finally {
    if (user) {
      const rows = db.prepare("SELECT product_id, quantity FROM cart_items WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)").all(user);
      for (const row of rows) db.prepare("UPDATE products SET reserved = CASE WHEN reserved - ? < 0 THEN 0 ELSE reserved - ? END WHERE id = ?").run(row.quantity, row.quantity, row.product_id);
      db.prepare("DELETE FROM wishlist_items WHERE user_id = ?").run(user);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user);
      db.prepare("DELETE FROM users WHERE id = ?").run(user);
    }
  }
}

async function task16to18() {
  const stamp = Date.now();
  const product = db.prepare("SELECT * FROM products WHERE active = 1 AND status != 'hidden' AND stock - reserved >= 1 LIMIT 1").get();
  if (!product) throw new Error("No available product is available for the profile test.");
  const email = `task16-${stamp}@example.com`;
  let user;
  try {
    const salt = "task16-salt";
    const passwordHash = `${salt}:${crypto.scryptSync("Testing123!", salt, 64).toString("hex")}`;
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Profile User", email, passwordHash).lastInsertRowid);
    const sessionId = `task16-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task16-csrf", Date.now() + 60000);
    const post = (path, values) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { Cookie: `sid=${sessionId}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task16-csrf", ...values }) });
    const saved = await post("/account/addresses/save", { label: "Office", recipient_name: "Profile User", phone: "9876543210", address: "10 Profile Road", city: "Bengaluru", postal_code: "560001", is_default: "1" });
    if (![302, 303].includes(saved.status)) throw new Error("Address save did not redirect.");
    const address = db.prepare("SELECT * FROM addresses WHERE user_id = ?").get(user);
    if (!address || !address.is_default) throw new Error("Default address was not stored.");
    db.prepare("INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price) VALUES (?,?,?,?,?,?,?)").run(sessionId, product.id, 1, String(product.sizes).split("|")[0], String(product.materials).split("|")[0], String(product.print_options).split("|")[0], product.price / product.min_qty);
    db.prepare("UPDATE products SET reserved = reserved + 1 WHERE id = ?").run(product.id);
    const checkout = await fetch(`${baseUrl}/checkout`, { headers: { Cookie: `sid=${sessionId}` } });
    const html = await checkout.text();
    if (!checkout.ok || !html.includes("10 Profile Road") || !html.includes("560001")) throw new Error("Default address did not prefill checkout.");
    const page = await fetch(`${baseUrl}/account/password`, { headers: { Cookie: `sid=${sessionId}` } });
    if (!page.ok || !(await page.text()).includes("Change password")) throw new Error("Password UI did not render.");
    const password = await post("/account/password", { current_password: "Testing123!", new_password: "Changed123!", confirm_password: "Changed123!" });
    if (![302, 303].includes(password.status)) throw new Error("Password change did not redirect.");
    if (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user).password_hash === passwordHash) throw new Error("Password hash did not change.");
    console.log("PASS task16=saved-addresses task17=default-checkout-address task18=password-change");
  } finally {
    if (user) {
      const rows = db.prepare("SELECT product_id, quantity FROM cart_items WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)").all(user);
      for (const row of rows) db.prepare("UPDATE products SET reserved = CASE WHEN reserved - ? < 0 THEN 0 ELSE reserved - ? END WHERE id = ?").run(row.quantity, row.quantity, row.product_id);
      db.prepare("DELETE FROM addresses WHERE user_id = ?").run(user);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user);
      db.prepare("DELETE FROM users WHERE id = ?").run(user);
    }
  }
}

async function task19to21() {
  const stamp = Date.now();
  const product = db.prepare("SELECT * FROM products WHERE active = 1 AND status != 'hidden' AND stock - reserved >= 1 LIMIT 1").get();
  if (!product) throw new Error("No available product is available for the order history test.");
  const email = `task19-${stamp}@example.com`;
  let user;
  let order;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Order User", email, "test").lastInsertRowid);
    const sessionId = `task19-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, user, "task19-csrf", Date.now() + 60000);
    order = Number(db.prepare("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`T19-${stamp}`, user, 500, "Delivered", "Order User", "9876543210", "1 Test Street", "Bengaluru", "560001", "cod").lastInsertRowid);
    db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,?,?,?)").run(order, product.id, product.name, 1, product.price / product.min_qty, `${String(product.sizes).split("|")[0]} · ${String(product.materials).split("|")[0]} · ${String(product.print_options).split("|")[0]}`);
    const cookie = { Cookie: `sid=${sessionId}` };
    const history = await fetch(`${baseUrl}/account/orders?q=${encodeURIComponent(product.name)}&status=Delivered`, { headers: cookie });
    const html = await history.text();
    if (!history.ok || !html.includes(`T19-${stamp}`) || !html.includes("Filter orders")) throw new Error("Order search or status filter did not render matching results.");
    const reorder = await fetch(`${baseUrl}/account/orders/reorder`, { method: "POST", redirect: "manual", headers: { ...cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task19-csrf", order_id: String(order) }) });
    if (![302, 303].includes(reorder.status)) throw new Error("Reorder did not redirect.");
    const item = db.prepare("SELECT * FROM cart_items WHERE session_id = ? AND product_id = ?").get(sessionId, product.id);
    if (!item || db.prepare("SELECT reserved FROM products WHERE id = ?").get(product.id).reserved < item.quantity) throw new Error("Reorder did not recreate a reserved cart item.");
    console.log("PASS task19=reorder task20=order-search task21=order-filters");
  } finally {
    if (user) {
      const rows = db.prepare("SELECT product_id, quantity FROM cart_items WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)").all(user);
      for (const row of rows) db.prepare("UPDATE products SET reserved = CASE WHEN reserved - ? < 0 THEN 0 ELSE reserved - ? END WHERE id = ?").run(row.quantity, row.quantity, row.product_id);
      if (order) db.prepare("DELETE FROM orders WHERE id = ?").run(order);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user);
      db.prepare("DELETE FROM users WHERE id = ?").run(user);
    }
  }
}

async function task22to26() {
  const stamp = Date.now();
  const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get();
  if (!admin) throw new Error("No admin user is available for the notification test.");
  const email = `task22-${stamp}@example.com`;
  let user;
  let order;
  try {
    user = Number(db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run("Delivery User", email, "test").lastInsertRowid);
    order = Number(db.prepare("INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`T22-${stamp}`, user, 500, "Pending", "Delivery User", "9876543210", "1 Test Street", "Bengaluru", "560001", "cod").lastInsertRowid);
    const sessionId = `task22-${stamp}`;
    db.prepare("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)").run(sessionId, admin.id, "task22-csrf", Date.now() + 60000);
    const postStatus = values => fetch(`${baseUrl}/admin/orders/status`, { method: "POST", redirect: "manual", headers: { Cookie: `sid=${sessionId}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "task22-csrf", order_id: String(order), ...values }) });
    const shipped = await postStatus({ status: "Shipped", courier_name: "Test Courier", tracking_number: "TRACK-22", tracking_url: "https://example.com/track", estimated_delivery: "2026-07-20", note: "Dispatched" });
    if (![302, 303].includes(shipped.status)) throw new Error("Shipping update did not redirect.");
    const shipping = db.prepare("SELECT * FROM notifications WHERE order_id = ? AND event = 'shipping_update' ORDER BY id DESC LIMIT 1").get(order);
    if (!shipping || !shipping.body.includes("Test Courier") || !shipping.body.includes("TRACK-22") || !shipping.body.includes("example.com/track")) throw new Error("Shipping notification is missing delivery details.");
    const delivered = await postStatus({ status: "Delivered", courier_name: "Test Courier", tracking_number: "TRACK-22", tracking_url: "https://example.com/track", estimated_delivery: "2026-07-20", note: "Delivered" });
    if (![302, 303].includes(delivered.status)) throw new Error("Delivered update did not redirect.");
    if (!db.prepare("SELECT id FROM notifications WHERE order_id = ? AND event = 'delivered'").get(order) || !db.prepare("SELECT id FROM notifications WHERE order_id = ? AND event = 'review_reminder'").get(order)) throw new Error("Delivered or review reminder notification was not queued.");
    const faq = await fetch(`${baseUrl}/faq`);
    const html = await faq.text();
    if (!faq.ok || !html.includes("Frequently asked questions") || !html.includes("Bulk orders")) throw new Error("FAQ page did not render its required content.");
    console.log("PASS task22=shipping-email task23=delivered-email task24=review-reminder task25=faq-content task26=faq-ui");
  } finally {
    if (order) {
      db.prepare("DELETE FROM notifications WHERE order_id = ?").run(order);
      db.prepare("DELETE FROM orders WHERE id = ?").run(order);
    }
    db.prepare("DELETE FROM sessions WHERE id LIKE 'task22-%'").run();
    if (user) db.prepare("DELETE FROM users WHERE id = ?").run(user);
  }
}

async function emailDelivery() {
  const configured = createEmailService({ host: "smtp.example.test", port: 587, secure: false, user: "user", pass: "pass", from: "orders@example.test" });
  if (!configured.configured) throw new Error("SMTP configuration was not recognized.");
  const skipped = await createEmailService({ host: "", from: "" }).send({ to: "customer@example.test", subject: "Test", text: "Test" });
  if (!skipped.skipped) throw new Error("Unconfigured SMTP did not fail gracefully.");
  const message = orderEmailTemplate({
    event: "shipping_update",
    order: { id: 1, order_number: "PO-TEST", customer_name: "Customer", total: 500, courier_name: "Courier", tracking_number: "TRACK-1", tracking_url: "https://example.test/track", estimated_delivery: "2026-07-20", status: "Shipped" },
    items: [{ product_id: 9, product_name: "Business Cards", quantity: 100 }],
    note: "Dispatched",
    baseUrl: "https://printoasis.example",
    money: value => "Rs " + value
  });
  if (!message.html.includes("TRACK-1") || !message.html.includes("https://example.test/track") || !message.text.includes("Courier")) throw new Error("Shipping email template is incomplete.");
  console.log("PASS email=smtp-config-graceful-failure-html-template");
}

const tasks = { task4, task5, task6, task7, task8, task9, task10, task12to15, task16to18, task19to21, task22to26, emailDelivery };
if (!tasks[task]) throw new Error(`Unknown Sprint 3 smoke task: ${task || "none"}`);
tasks[task]().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
