module.exports = async function adminRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  const pages = { "/admin": () => app.adminDashboardPage(session, cart), "/admin/products": () => app.adminProductsPage(url, session, cart), "/admin/coupons": () => app.adminCouponsPage(url, session, cart), "/admin/orders": () => app.adminOrdersPage(url, session, cart), "/admin/notifications": () => app.adminNotificationsPage(session, cart) };
  if (req.method === "GET" && pages[url.pathname]) { if (!app.requireAdmin(session, res)) return true; app.send(res, 200, await pages[url.pathname]()); return true; }
  if (req.method !== "POST") return false;
  const posts = ["/admin/products/save", "/admin/products/delete", "/admin/orders/status", "/admin/orders/refund", "/admin/coupons/save", "/admin/coupons/toggle", "/admin/coupons/delete"];
  if (!posts.includes(url.pathname)) return false;
  if (!app.requireAdmin(session, res)) return true;
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
  if (url.pathname === "/admin/products/save") {
    let image, hoverImage, galleryImages = [];
    try {
      image = app.saveProductImage(data.files?.product_image);
      hoverImage = app.saveProductImage(data.files?.hover_image);
      galleryImages = app.saveProductImages(data.files?.gallery_images);
      const galleryPlacement = ["default", "featured", "trending", "recommendation"].includes(data.gallery_placement) ? data.gallery_placement : "default";
      const id = Number(data.id || 0), name = String(data.name || "").trim(), slug = app.slugify(data.slug || name);
      if (!name || !slug) throw new Error("Product name is required.");
      const values = { slug, name, category: data.category, price: Math.max(1, Number(data.price) || 1), min_qty: Math.max(1, Number(data.min_qty) || 1), rating: Math.max(1, Math.min(5, Number(data.rating) || 4.8)), stock: Math.max(0, Number(data.stock) || 0), status: data.status === "hidden" ? "hidden" : "active", featured: data.featured ? 1 : 0, badge: String(data.badge || "").trim(), description: String(data.description || "").trim(), sizes: String(data.sizes || "").trim(), materials: String(data.materials || "").trim(), print_options: String(data.print_options || "").trim(), color: String(data.color || "cobalt").trim(), active: data.status === "hidden" ? 0 : 1 };
      await app.db.transaction(async tx => {
        let productId = id;
        if (id) {
          const current = await tx.get("SELECT * FROM products WHERE id = ? FOR UPDATE", id); if (!current) throw new Error("Product not found.");
          await tx.run(`UPDATE products SET slug=?,name=?,category=?,price=?,min_qty=?,rating=?,badge=?,description=?,sizes=?,materials=?,print_options=?,color=?,stock=?,status=?,featured=?,active=?,image_original_name=?,image_stored_name=?,image_mime=?,image_size=? WHERE id=?`, values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.stock, values.status, values.featured, values.active, image?.original || current.image_original_name, image?.stored || current.image_stored_name, image?.mime || current.image_mime, image?.size || current.image_size, id);
        } else {
          const result = await tx.run(`INSERT INTO products (slug,name,category,price,min_qty,rating,badge,description,sizes,materials,print_options,color,stock,reserved,status,featured,active,image_original_name,image_stored_name,image_mime,image_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, values.slug, values.name, values.category, values.price, values.min_qty, values.rating, values.badge, values.description, values.sizes, values.materials, values.print_options, values.color, values.stock, 0, values.status, values.featured, values.active, image?.original || null, image?.stored || null, image?.mime || null, image?.size || null); productId = result.rows[0].id;
        }
        if (hoverImage) await tx.run("DELETE FROM product_images WHERE product_id = ? AND role = 'hover' AND placement = 'default'", productId);
        await app.addProductImages(productId, hoverImage, "hover", "default", tx); await app.addProductImages(productId, galleryImages, "gallery", galleryPlacement, tx);
      });
      app.redirect(res, "/admin/products?notice=Product+saved.");
    } catch (error) {
      app.removeSavedUploads([image, hoverImage, ...galleryImages], app.productImageDirectory);
      app.redirect(res, `/admin/products?notice=${encodeURIComponent(error.message)}`);
    }
    return true;
  }
  if (url.pathname === "/admin/products/delete") { await app.db.run("UPDATE products SET status = 'hidden', active = 0 WHERE id = ?", Number(data.id)); app.redirect(res, "/admin/products?notice=Product+hidden+from+storefront."); return true; }
  if (url.pathname === "/admin/coupons/save") {
    const originalCode = String(data.original_code || "").trim().toUpperCase(), code = String(data.code || "").trim().toUpperCase(), type = data.type === "fixed" ? "fixed" : "percent", value = Math.max(1, Math.floor(Number(data.value) || 0)), minimumOrder = Math.max(0, Math.floor(Number(data.minimum_order) || 0)), maximumDiscount = Math.max(0, Math.floor(Number(data.maximum_discount) || 0)) || null, usageLimit = Math.max(0, Math.floor(Number(data.usage_limit) || 0)) || null, expiryDate = String(data.expiry_date || "").trim();
    if (!/^[A-Z0-9_-]{2,24}$/.test(code) || !value || (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))) return app.redirect(res, "/admin/coupons?notice=Enter+a+valid+coupon+code+and+values."), true;
    try { if (originalCode) { const result = await app.db.run("UPDATE coupons SET code=?,type=?,value=?,min_total=?,minimum_order=?,maximum_discount=?,expiry_date=?,usage_limit=?,active=? WHERE code=?", code, type, value, minimumOrder, minimumOrder, maximumDiscount, expiryDate || null, usageLimit, data.active ? 1 : 0, originalCode); if (!result.changes) return app.redirect(res, "/admin/coupons?notice=Coupon+not+found."), true; } else await app.db.run("INSERT INTO coupons (code,type,value,min_total,minimum_order,maximum_discount,expiry_date,usage_limit,active) VALUES (?,?,?,?,?,?,?,?,?)", code, type, value, minimumOrder, minimumOrder, maximumDiscount, expiryDate || null, usageLimit, data.active ? 1 : 0); } catch (error) { if (error.code === "23505") return app.redirect(res, "/admin/coupons?notice=That+coupon+code+already+exists."), true; throw error; }
    app.redirect(res, "/admin/coupons?notice=Coupon+saved."); return true;
  }
  if (url.pathname === "/admin/coupons/toggle") { await app.db.run("UPDATE coupons SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE code = ?", String(data.code || "").trim().toUpperCase()); app.redirect(res, "/admin/coupons?notice=Coupon+status+updated."); return true; }
  if (url.pathname === "/admin/coupons/delete") { await app.db.run("DELETE FROM coupons WHERE code = ?", String(data.code || "").trim().toUpperCase()); app.redirect(res, "/admin/coupons?notice=Coupon+deleted."); return true; }
  if (url.pathname === "/admin/orders/status") {
    const status = String(data.status || ""), orderId = Number(data.order_id), note = String(data.note || "").trim().slice(0, 400), tracking = String(data.tracking_number || "").trim().slice(0, 80), courier = String(data.courier_name || "").trim().slice(0, 80), trackingUrl = String(data.tracking_url || "").trim().slice(0, 500), estimatedDelivery = String(data.estimated_delivery || "").trim().slice(0, 40);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return app.redirect(res, "/admin/orders?notice=Order+not+found."), true;
    if (!app.ORDER_STATUSES.includes(status)) return app.redirect(res, "/admin/orders?notice=Select+a+valid+order+status."), true;
    if (status === "Cancelled") {
      try {
        const result = await app.cancelOrder(orderId, { actor: { actorType: "admin", actorId: session.user.id } });
        const message = result.status === "completed" ? "Order cancelled; required refund and inventory actions are complete." : result.status === "failed" ? "Refund was rejected. The order remains open for support review." : "Refund is being confirmed. The order remains open until it succeeds.";
        app.redirect(res, `/admin/orders?notice=${encodeURIComponent(message)}`);
      } catch (error) {
        const message = error.code === "ORDER_CANCELLATION_NOT_ALLOWED" ? error.message : "The order could not be cancelled safely.";
        app.redirect(res, `/admin/orders?notice=${encodeURIComponent(message)}`);
      }
      return true;
    }
    try {
      const transition = await app.transitionOrderStatus(orderId, status, { note, trackingNumber: tracking, courierName: courier, trackingUrl, estimatedDelivery }, { actorType: "admin", actorId: session.user.id });
      if (transition.changed) { const event = status === "Shipped" ? "shipping_update" : status === "Delivered" ? "delivered" : "status_update"; await app.notifyOrder(orderId, event, note); if (status === "Delivered") await app.notifyOrder(orderId, "review_reminder"); }
    } catch (error) {
      const message = error.code === "ORDER_NOT_FOUND" ? "Order not found." : error.code === "ORDER_PAYMENT_NOT_SETTLED" ? error.message : "That order status transition is not allowed.";
      return app.redirect(res, `/admin/orders?notice=${encodeURIComponent(message)}`), true;
    }
    app.redirect(res, "/admin/orders?notice=Order+status+updated."); return true;
  }
  if (url.pathname === "/admin/orders/refund") {
    const orderId = Number(data.order_id), amountText = String(data.amount || "").trim(), reason = String(data.reason || "").trim().slice(0, 240);
    if (!Number.isSafeInteger(orderId) || !/^\d{1,8}(?:\.\d{1,2})?$/.test(amountText)) return app.redirect(res, "/admin/orders?notice=Enter+a+valid+refund+amount."), true;
    const amountMinor = Math.round(Number(amountText) * 100);
    const order = await app.db.get("SELECT payment_record_id FROM orders WHERE id=?", orderId);
    if (!order?.payment_record_id || amountMinor <= 0) return app.redirect(res, "/admin/orders?notice=This+order+has+no+refundable+online+payment."), true;
    try {
      const refund = await app.requestPaymentRefund({
        paymentRecordId: order.payment_record_id, orderId, amountMinor, reason,
        operationKey: `admin-order-refund:${orderId}:${amountMinor}:${reason}`
      });
      const message = refund.status === "succeeded" ? "Refund completed." : refund.status === "failed" ? "Refund was rejected; no automatic retry was made." : "Refund status is uncertain or pending; reconcile before retrying.";
      app.redirect(res, `/admin/orders?notice=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error.code?.startsWith("REFUND_") ? error.message : "The refund could not be processed safely.";
      app.redirect(res, `/admin/orders?notice=${encodeURIComponent(message)}`);
    }
    return true;
  }
  return false;
};
