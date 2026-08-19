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
  if (req.method === "GET" && url.pathname === "/admin/coupons") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminCouponsPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/orders") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminOrdersPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/notifications") {
    if (!app.requireAdmin(session, res)) return true;
    app.send(res, 200, app.adminNotificationsPage(session, cart));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!["/admin/products/save", "/admin/products/delete", "/admin/orders/status", "/admin/coupons/save", "/admin/coupons/toggle", "/admin/coupons/delete"].includes(url.pathname)) return false;
  if (!app.requireAdmin(session, res)) return true;
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;

  if (url.pathname === "/admin/products/save") {
    const image = app.saveProductImage(data.files?.product_image);
    const hoverImage = app.saveProductImage(data.files?.hover_image);
    const galleryImages = app.saveProductImages(data.files?.gallery_images);
    const galleryPlacement = ["default", "featured", "trending", "recommendation"].includes(data.gallery_placement) ? data.gallery_placement : "default";
    const id = Number(data.id || 0);
    const name = String(data.name || "").trim();
    const slug = app.slugify(data.slug || name);
    if (!name || !slug) return app.redirect(res, "/admin/products?notice=Product+name+is+required."), true;
    const values = {
      slug, name, category: data.category,
      price: Math.max(1, Number(data.price) || 1),
      min_qty: Math.max(1, Number(data.min_qty) || 1),
      rating: Math.max(1, Math.min(5, Number(data.rating) || 4.8)),
      stock: Math.max(0, Number(data.stock) || 0),
      status: data.status === "hidden" ? "hidden" : "active",
      featured: data.featured ? 1 : 0,
      badge: String(data.badge || "").trim(),
      description: String(data.description || "").trim(),
      sizes: String(data.sizes || "").trim(),
      materials: String(data.materials || "").trim(),
      print_options: String(data.print_options || "").trim(),
      color: String(data.color || "cobalt").trim(),
      active: data.status === "hidden" ? 0 : 1
    };
let productId = id;
if (id) {
  const current = app.db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!current) return app.redirect(res, "/admin/products?notice=Product+not+found."), true;

  app.db.prepare(`UPDATE products SET slug=?,name=?,category=?,price=?,min_qty=?,rating=?,badge=?,description=?,sizes=?,materials=?,print_options=?,color=?,stock=?,status=?,featured=?,active=?,image_original_name=?,image_stored_name=?,image_mime=?,image_size=? WHERE id=?`)
    .run(
      values.slug,
      values.name,
      values.category,
      values.price,
      values.min_qty,
      values.rating,
      values.badge,
      values.description,
      values.sizes,
      values.materials,
      values.print_options,
      values.color,
      values.stock,
      values.status,
      values.featured,
      values.active,
      image?.original || current.image_original_name,
      image?.stored || current.image_stored_name,
      image?.mime || current.image_mime,
      image?.size || current.image_size,
      id
    );
} else {
  const result = app.db.prepare(`INSERT INTO products (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color,stock,reserved,status,featured,active,image_original_name,image_stored_name,image_mime,image_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      values.slug,
      values.name,
      values.category,
      values.price,
      values.min_qty,
      values.rating,
      values.badge,
      values.description,
      values.sizes,
      values.materials,
      values.print_options,
      values.color,
      values.stock,
      0,
      values.status,
      values.featured,
      values.active,
      image?.original || null,
      image?.stored || null,
      image?.mime || null,
      image?.size || null
    );
  productId = Number(result.lastInsertRowid);
}
    if (hoverImage) app.db.prepare("DELETE FROM product_images WHERE product_id = ? AND role = 'hover' AND placement = 'default'").run(productId);
    app.addProductImages(productId, hoverImage, "hover");
    app.addProductImages(productId, galleryImages, "gallery", galleryPlacement);
    app.redirect(res, "/admin/products?notice=Product+saved.");
    return true;
  }
  if (url.pathname === "/admin/products/delete") {
    app.db.prepare("UPDATE products SET status = 'hidden', active = 0 WHERE id = ?").run(Number(data.id));
    app.redirect(res, "/admin/products?notice=Product+hidden+from+storefront.");
    return true;
  }
  if (url.pathname === "/admin/coupons/save") {
    const originalCode = String(data.original_code || "").trim().toUpperCase();
    const code = String(data.code || "").trim().toUpperCase();
    const type = data.type === "fixed" ? "fixed" : "percent";
    const value = Math.max(1, Math.floor(Number(data.value) || 0));
    const minimumOrder = Math.max(0, Math.floor(Number(data.minimum_order) || 0));
    const maximumDiscount = Math.max(0, Math.floor(Number(data.maximum_discount) || 0)) || null;
    const usageLimit = Math.max(0, Math.floor(Number(data.usage_limit) || 0)) || null;
    const expiryDate = String(data.expiry_date || "").trim();
    if (!/^[A-Z0-9_-]{2,24}$/.test(code) || !value || (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))) return app.redirect(res, "/admin/coupons?notice=Enter+a+valid+coupon+code+and+values."), true;
    try {
      if (originalCode) {
        const result = app.db.prepare("UPDATE coupons SET code=?,type=?,value=?,min_total=?,minimum_order=?,maximum_discount=?,expiry_date=?,usage_limit=?,active=? WHERE code=?").run(code, type, value, minimumOrder, minimumOrder, maximumDiscount, expiryDate || null, usageLimit, data.active ? 1 : 0, originalCode);
        if (!result.changes) return app.redirect(res, "/admin/coupons?notice=Coupon+not+found."), true;
      } else {
        app.db.prepare("INSERT INTO coupons (code,type,value,min_total,minimum_order,maximum_discount,expiry_date,usage_limit,active) VALUES (?,?,?,?,?,?,?,?,?)").run(code, type, value, minimumOrder, minimumOrder, maximumDiscount, expiryDate || null, usageLimit, data.active ? 1 : 0);
      }
    } catch (error) {
      if (String(error).includes("UNIQUE")) return app.redirect(res, "/admin/coupons?notice=That+coupon+code+already+exists."), true;
      throw error;
    }
    app.redirect(res, "/admin/coupons?notice=Coupon+saved.");
    return true;
  }
  if (url.pathname === "/admin/coupons/toggle") {
    app.db.prepare("UPDATE coupons SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE code = ?").run(String(data.code || "").trim().toUpperCase());
    app.redirect(res, "/admin/coupons?notice=Coupon+status+updated.");
    return true;
  }
  if (url.pathname === "/admin/coupons/delete") {
    app.db.prepare("DELETE FROM coupons WHERE code = ?").run(String(data.code || "").trim().toUpperCase());
    app.redirect(res, "/admin/coupons?notice=Coupon+deleted.");
    return true;
  }
if (url.pathname === "/admin/orders/status") {
  const status = app.ORDER_STATUSES.includes(data.status) ? data.status : "Pending";
  const orderId = Number(data.order_id);
  const note = String(data.note || "").trim().slice(0, 400);

  const tracking = String(data.tracking_number || "").trim().slice(0, 80);
  const courier = String(data.courier_name || "").trim().slice(0, 80);
  const trackingUrl = String(data.tracking_url || "").trim().slice(0, 500);
  const estimatedDelivery = String(data.estimated_delivery || "").trim().slice(0, 40);

  const current = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

  if (!current)
    return app.redirect(res, "/admin/orders?notice=Order+not+found."), true;

  if (current.status === "Cancelled" && status !== "Cancelled") {
    return app.redirect(
      res,
      "/admin/orders?notice=Cancelled+orders+cannot+be+reopened."
    ), true;
  }

  if (status === "Cancelled" && current.status !== "Cancelled") {
    app.restoreOrderInventory(orderId);
  }

  app.db.prepare(`
    UPDATE orders
    SET
      status = ?,
      tracking_number = ?,
      courier_name = ?,
      tracking_url = ?,
      estimated_delivery = ?,
      status_updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    tracking || null,
    courier || null,
    trackingUrl || null,
    estimatedDelivery || null,
    orderId
  );

  app.db.prepare(`
    INSERT INTO order_status_events (order_id, status, note)
    VALUES (?, ?, ?)
  `).run(orderId, status, note);

  if (current.status !== status) {
    const event = status === "Shipped" ? "shipping_update" : status === "Delivered" ? "delivered" : "status_update";
    await app.notifyOrder(orderId, event, note);
    if (status === "Delivered") await app.notifyOrder(orderId, "review_reminder");
  }

  app.redirect(res, "/admin/orders?notice=Order+status+updated.");
  return true;
}
}
