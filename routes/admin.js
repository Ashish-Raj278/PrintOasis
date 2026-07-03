module.exports = async function adminRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/admin") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminDashboardPage(session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/products") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminProductsPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/orders") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminOrdersPage(session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/notifications") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminNotificationsPage(session, cart));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!["/admin/products/save", "/admin/products/delete", "/admin/orders/status"].includes(url.pathname)) return false;
  if (!app.requireAdmin(session, res)) return true;
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;

  if (url.pathname === "/admin/products/save") {
    const image = app.saveProductImage(data.files?.product_image);
    const id = Number(data.id || 0);
    const name = String(data.name || "").trim();
    const slug = app.slugify(data.slug || name);
    if (!name || !slug) return app.redirect(res, "/admin/products?notice=Product+name+is+required."), true;
    const values = {
      slug, name, category: data.category,
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
      const current = app.db.prepare("SELECT * FROM products WHERE id = ?").get(id);
      if (!current) return app.redirect(res, "/admin/products?notice=Product+not+found."), true;
      app.db.prepare(`UPDATE products SET slug=?,name=?,category=?,price=?,min_qty=?,rating=?,badge=?,description=?,sizes=?,materials=?,print_options=?,color=?,active=?,image_original_name=?,image_stored_name=?,image_mime=?,image_size=? WHERE id=?`)
        .run(values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.active, image?.original || current.image_original_name, image?.stored || current.image_stored_name, image?.mime || current.image_mime, image?.size || current.image_size, id);
    } else {
      app.db.prepare(`INSERT INTO products (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color,active,image_original_name,image_stored_name,image_mime,image_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.active, image?.original || null, image?.stored || null, image?.mime || null, image?.size || null);
    }
    app.redirect(res, "/admin/products?notice=Product+saved.");
    return true;
  }
  if (url.pathname === "/admin/products/delete") {
    app.db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(Number(data.id));
    app.redirect(res, "/admin/products?notice=Product+hidden+from+storefront.");
    return true;
  }
  if (url.pathname === "/admin/orders/status") {
    const status = app.ORDER_STATUSES.includes(data.status) ? data.status : "Pending";
    const orderId = Number(data.order_id);
    const note = String(data.note || "").trim().slice(0, 400);
    const tracking = String(data.tracking_number || "").trim().slice(0, 80);
    app.db.prepare("UPDATE orders SET status = ?, tracking_number = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, tracking || null, orderId);
    app.db.prepare("INSERT INTO order_status_events (order_id,status,note) VALUES (?,?,?)").run(orderId, status, note);
    await app.notifyOrder(orderId, "status_update", note);
    app.redirect(res, "/admin/orders?notice=Order+status+updated.");
    return true;
  }
  return false;
};
