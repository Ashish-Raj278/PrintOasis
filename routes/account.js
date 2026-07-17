module.exports = async function accountRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/orders")) {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    app.send(res, 200, url.pathname.endsWith("orders") ? app.ordersPage(session, cart, url) : app.accountPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/account/orders/")) {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    const orderId = Number(url.pathname.slice("/account/orders/".length));
    const order = Number.isInteger(orderId) && orderId > 0 ? app.orderWithUser(orderId) : null;
    if (!order || order.user_id !== session.user.id) {
      app.redirect(res, "/account/orders?notice=" + encodeURIComponent("Order not found."));
      return true;
    }
    app.send(res, 200, app.orderDetailsPage(order, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/wishlist") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    app.send(res, 200, app.wishlistPage(session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/account/addresses") {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    app.send(res, 200, app.addressesPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/account/password") {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    app.send(res, 200, app.passwordPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/track") return app.send(res, 200, app.trackPage(url, session, cart)), true;
  if (req.method === "POST" && url.pathname === "/track") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const order = app.db.prepare("SELECT * FROM orders WHERE order_number = ? AND phone = ?").get((data.order_number || "").trim().toUpperCase(), (data.phone || "").trim());
    app.send(res, 200, order ? app.trackPage(url, session, cart, order) : app.trackPage(new URL("/track?notice=Order+not+found.", app.requestOrigin(req)), session, cart));
    return true;
  }
  const infoRoutes = {
    "/help": "help",
    "/contact": "contact",
    "/business": "business",
    "/faq": "faq",
    "/shipping-policy": "shipping",
    "/returns": "returns",
    "/privacy": "privacy",
    "/terms": "terms",
    "/printing-guidelines": "guidelines",
    "/resources": "resources"
  };
  if (req.method === "GET" && infoRoutes[url.pathname]) {
    app.send(res, 200, app.infoPage(infoRoutes[url.pathname], session, cart, url));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/contact") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim();
    const phone = String(data.phone || "").trim();
    const message = String(data.message || "").trim();
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 7 || message.length < 12) {
      app.redirect(res, "/contact?notice=" + encodeURIComponent("Please complete every contact field with valid details."));
      return true;
    }
    await app.sendContactEnquiry({ name, email, phone, topic: data.topic, message });
    app.redirect(res, "/contact?notice=" + encodeURIComponent("Thanks. Your enquiry is with the PrintOasis team."));
    return true;
  }
  if (req.method !== "POST") return false;
  const accountPosts = ["/account/orders/reorder", "/account/reviews/save", "/account/reviews/delete", "/account/addresses/save", "/account/addresses/default", "/account/addresses/delete", "/account/password"];
  if (!accountPosts.includes(url.pathname)) return false;
  if (!app.requireAuth(session, res, "/account")) return true;
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;

  if (url.pathname === "/account/orders/reorder") {
    const order = app.db.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ?").get(Number(data.order_id), session.user.id);
    if (!order) return app.redirect(res, "/account/orders?notice=Order+not+found."), true;
    const items = app.db.prepare("SELECT oi.*, p.id AS current_product_id, p.slug, p.sizes, p.materials, p.print_options, p.price, p.min_qty, p.stock, p.reserved, p.status, p.active FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?").all(order.id);
    const skipped = [];
    let added = 0;
    app.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        if (!item.current_product_id || !item.slug || !item.active || item.status === "hidden") {
          skipped.push(item.product_name);
          continue;
        }
        const config = String(item.configuration || "").split(" · ");
        try {
          app.addCartItem(session.id, { ...item, id: item.current_product_id }, item.quantity, {
            size: config[0] || String(item.sizes || "").split("|")[0],
            material: config[1] || String(item.materials || "").split("|")[0],
            printOption: config[2] || String(item.print_options || "").split("|")[0]
          });
          added += 1;
        } catch {
          skipped.push(item.product_name);
        }
      }
      app.db.exec("COMMIT");
    } catch (error) {
      app.db.exec("ROLLBACK");
      throw error;
    }
    const message = [(added ? String(added) + " item" + (added === 1 ? "" : "s") + " added to your cart." : "No items could be added."), skipped.length ? "Skipped: " + [...new Set(skipped)].join(", ") + "." : ""].filter(Boolean).join(" ");
    app.redirect(res, "/cart?notice=" + encodeURIComponent(message));
    return true;
  }

  if (url.pathname === "/account/reviews/save") {
    const order = app.db.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ? AND status = 'Delivered'").get(Number(data.order_id), session.user.id);
    const productId = Number(data.product_id);
    const ordered = order && app.db.prepare("SELECT 1 FROM order_items WHERE order_id = ? AND product_id = ?").get(order.id, productId);
    const rating = Math.max(1, Math.min(5, Number(data.rating) || 5));
    const comment = String(data.comment || "").trim().slice(0, 600);
    if (!ordered || !app.hasDeliveredPurchase(session.user.id, productId)) return app.redirect(res, "/account/orders?notice=Only+verified+delivered+purchases+can+be+reviewed."), true;
    if (comment.length < 8) return app.redirect(res, "/account/orders/" + order.id + "?notice=Review+must+contain+at+least+8+characters."), true;
    const existing = app.db.prepare("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?").get(session.user.id, productId);
    if (existing) app.db.prepare("UPDATE reviews SET rating = ?, comment = ?, verified_purchase = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(rating, comment, existing.id, session.user.id);
    else app.db.prepare("INSERT INTO reviews (product_id,user_id,name,rating,comment,verified_purchase) VALUES (?,?,?,?,?,1)").run(productId, session.user.id, session.user.name, rating, comment);
    app.redirect(res, "/account/orders/" + order.id + "?notice=" + encodeURIComponent(existing ? "Review updated." : "Review submitted."));
    return true;
  }

  if (url.pathname === "/account/reviews/delete") {
    const order = app.db.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ?").get(Number(data.order_id), session.user.id);
    const review = app.db.prepare("SELECT id, product_id FROM reviews WHERE id = ? AND user_id = ?").get(Number(data.review_id), session.user.id);
    const ordered = order && review && app.db.prepare("SELECT 1 FROM order_items WHERE order_id = ? AND product_id = ?").get(order.id, review.product_id);
    if (!ordered) return app.redirect(res, "/account/orders?notice=Review+not+found."), true;
    app.db.prepare("DELETE FROM reviews WHERE id = ? AND user_id = ?").run(review.id, session.user.id);
    app.redirect(res, "/account/orders/" + order.id + "?notice=Review+deleted.");
    return true;
  }

  if (url.pathname === "/account/addresses/save") {
    const id = Number(data.id || 0);
    const values = {
      label: String(data.label || "").trim().slice(0, 40),
      recipientName: String(data.recipient_name || "").trim().slice(0, 100),
      phone: String(data.phone || "").trim().slice(0, 30),
      address: String(data.address || "").trim().slice(0, 500),
      city: String(data.city || "").trim().slice(0, 100),
      postalCode: String(data.postal_code || "").trim()
    };
    if (!values.label || !values.recipientName || !values.phone || !values.address || !values.city || !/^[0-9]{6}$/.test(values.postalCode)) return app.redirect(res, "/account/addresses?notice=Please+enter+a+complete+delivery+address."), true;
    const current = id ? app.db.prepare("SELECT * FROM addresses WHERE id = ? AND user_id = ?").get(id, session.user.id) : null;
    if (id && !current) return app.redirect(res, "/account/addresses?notice=Address+not+found."), true;
    const count = app.db.prepare("SELECT COUNT(*) count FROM addresses WHERE user_id = ?").get(session.user.id).count;
    const makeDefault = Boolean(data.is_default) || Boolean(current?.is_default) || !count;
    app.db.exec("BEGIN IMMEDIATE");
    try {
      if (makeDefault) app.db.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ?").run(session.user.id);
      if (current) app.db.prepare("UPDATE addresses SET label=?,recipient_name=?,phone=?,address=?,city=?,postal_code=?,is_default=? WHERE id=? AND user_id=?").run(values.label, values.recipientName, values.phone, values.address, values.city, values.postalCode, makeDefault ? 1 : 0, current.id, session.user.id);
      else app.db.prepare("INSERT INTO addresses (user_id,label,recipient_name,phone,address,city,postal_code,is_default) VALUES (?,?,?,?,?,?,?,?)").run(session.user.id, values.label, values.recipientName, values.phone, values.address, values.city, values.postalCode, makeDefault ? 1 : 0);
      app.db.exec("COMMIT");
    } catch (error) {
      app.db.exec("ROLLBACK");
      throw error;
    }
    app.redirect(res, "/account/addresses?notice=Address+saved.");
    return true;
  }

  if (url.pathname === "/account/addresses/default") {
    const address = app.db.prepare("SELECT id FROM addresses WHERE id = ? AND user_id = ?").get(Number(data.id), session.user.id);
    if (!address) return app.redirect(res, "/account/addresses?notice=Address+not+found."), true;
    app.db.exec("BEGIN IMMEDIATE");
    try {
      app.db.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ?").run(session.user.id);
      app.db.prepare("UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?").run(address.id, session.user.id);
      app.db.exec("COMMIT");
    } catch (error) {
      app.db.exec("ROLLBACK");
      throw error;
    }
    app.redirect(res, "/account/addresses?notice=Default+address+updated.");
    return true;
  }

  if (url.pathname === "/account/addresses/delete") {
    const address = app.db.prepare("SELECT id, is_default FROM addresses WHERE id = ? AND user_id = ?").get(Number(data.id), session.user.id);
    if (!address) return app.redirect(res, "/account/addresses?notice=Address+not+found."), true;
    app.db.exec("BEGIN IMMEDIATE");
    try {
      app.db.prepare("DELETE FROM addresses WHERE id = ? AND user_id = ?").run(address.id, session.user.id);
      if (address.is_default) {
        const replacement = app.db.prepare("SELECT id FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(session.user.id);
        if (replacement) app.db.prepare("UPDATE addresses SET is_default = 1 WHERE id = ?").run(replacement.id);
      }
      app.db.exec("COMMIT");
    } catch (error) {
      app.db.exec("ROLLBACK");
      throw error;
    }
    app.redirect(res, "/account/addresses?notice=Address+deleted.");
    return true;
  }

  if (url.pathname === "/account/password") {
    const user = app.db.prepare("SELECT * FROM users WHERE id = ?").get(session.user.id);
    const currentPassword = String(data.current_password || "");
    const newPassword = String(data.new_password || "");
    if (!user || !app.verifyPassword(currentPassword, user.password_hash)) return app.redirect(res, "/account/password?notice=Current+password+is+incorrect."), true;
    if (newPassword.length < 8 || newPassword !== String(data.confirm_password || "")) return app.redirect(res, "/account/password?notice=New+passwords+must+match+and+contain+at+least+8+characters."), true;
    app.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(app.hashPassword(newPassword), session.user.id);
    app.redirect(res, "/account/password?notice=Password+updated.");
    return true;
  }
  return false;
};
