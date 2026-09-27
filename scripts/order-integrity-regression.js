const assert = require("node:assert/strict");

function checks() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); },
    async rejects(work, predicate, message) { count += 1; await assert.rejects(work, predicate, message); }
  };
}

async function assertOrderIntegrityBehavior({ app, get, post, csrf, prefix, admin, customer, product, deliveredOrder, sessionId }) {
  const c = checks();
  const orderIds = [];
  const productIds = [];
  const originalProduct = await app.db.get("SELECT name,price,status,active FROM products WHERE id=?", product.id);

  try {
    c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name='007-invoice-order-integrity.sql'"), "Invoice/order integrity migration is recorded.");
    c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='invoice_snapshot'"), "Orders persist an immutable invoice snapshot.");
    c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_status_events' AND column_name='previous_status'"), "Status history stores the prior state.");
    c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_status_events' AND column_name='actor_type'"), "Status history stores the actor type.");

    const standard = app.createInvoiceSnapshot({ subtotalMinor: 11800, discountMinor: 0, shippingMinor: 0, totalMinor: 11800 });
    c.equal(standard.taxable_minor, 10000, "18% inclusive tax extraction produces the exact taxable paise amount.");
    c.equal(standard.tax_minor, 1800, "Inclusive tax is the exact remainder in paise.");
    c.equal(standard.taxable_minor + standard.tax_minor, standard.total_minor, "Taxable value and tax reconcile to the gross total.");
    const discountedShipping = app.createInvoiceSnapshot({ subtotalMinor: 12000, discountMinor: 1000, shippingMinor: 500, totalMinor: 11500 });
    c.equal(discountedShipping.taxable_minor, 9746, "Discounted order with shipping uses the authoritative gross order amount.");
    c.equal(discountedShipping.tax_minor, 1754, "Discount and shipping tax extraction rounds deterministically.");
    c.equal(discountedShipping.subtotal_minor - discountedShipping.discount_minor + discountedShipping.shipping_minor, discountedShipping.total_minor, "Subtotal, discount and shipping reconcile to grand total.");
    c.equal(app.createInvoiceSnapshot({ subtotalMinor: 1, discountMinor: 0, shippingMinor: 0, totalMinor: 1 }).tax_minor, 0, "One-paise edge case rounds without creating fractional minor units.");
    c.equal(app.createInvoiceSnapshot({ subtotalMinor: 100, discountMinor: 0, shippingMinor: 0, totalMinor: 100, taxRateBps: 0 }).tax_minor, 0, "Configured zero-tax case has no extracted tax.");
    c.equal(app.createInvoiceSnapshot({ subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, totalMinor: 0, taxRateBps: 0 }).taxable_minor, 0, "Zero-total edge case remains valid.");
    c.equal(app.createInvoiceSnapshot({ subtotalMinor: 10000, discountMinor: 0, shippingMinor: 0, totalMinor: 10000, taxRateBps: 10000 }).tax_minor, 5000, "Tax rates are applied with integer rounding at a second supported rate.");
    await c.rejects(async () => app.createInvoiceSnapshot({ subtotalMinor: 1, discountMinor: 0, shippingMinor: 0, totalMinor: 2 }), error => /reconcile/.test(error.message), "Inconsistent invoice totals are rejected.");
    await c.rejects(async () => app.createInvoiceSnapshot({ subtotalMinor: 100, discountMinor: 0, shippingMinor: 0, totalMinor: 100, taxRateBps: -1 }), error => /GST rate/.test(error.message), "Invalid tax rate is rejected.");
    const legacyRounding = app.orderInvoiceSnapshot({ total: 1, shipping_fee: 0, discount: 0, invoice_snapshot: null });
    c.equal(legacyRounding.taxable_minor, 100, "Legacy fallback preserves the former whole-rupee taxable rounding.");
    c.equal(legacyRounding.tax_minor, 0, "Legacy invoice fallback preserves its historical remainder.");

    const order = await app.db.get("SELECT * FROM orders WHERE id=?", deliveredOrder.id);
    const snapshot = app.orderInvoiceSnapshot(order);
    c.equal(snapshot.currency, "INR", "Persisted invoice snapshot has an explicit currency.");
    c.equal(snapshot.tax_inclusive, true, "Persisted invoice snapshot states that checkout prices are tax inclusive.");
    c.equal(Number(snapshot.total_minor), Number(order.total) * 100, "Invoice grand total is snapshotted from the order total.");
    c.equal(Number(snapshot.shipping_minor), Number(order.shipping_fee) * 100, "Invoice shipping charge is snapshotted.");
    c.equal(Number(snapshot.discount_minor), Number(order.discount) * 100, "Invoice discount is snapshotted.");
    c.equal(Number(snapshot.taxable_minor) + Number(snapshot.tax_minor), Number(snapshot.total_minor), "Persisted tax and taxable values reconcile.");
    c.equal(order.payment_method, "cod", "COD order retains its legacy payment method without an online payment association.");
    c.ok(snapshot.seller && Object.hasOwn(snapshot.seller, "legal_name") && Object.hasOwn(snapshot.seller, "registered_address"), "Seller identity fields are snapshotted without fabricated values.");

    const savedItem = await app.db.get("SELECT product_name FROM order_items WHERE order_id=? ORDER BY id LIMIT 1", order.id);
    await app.db.run("UPDATE products SET name=?,price=?,status='hidden',active=0 WHERE id=?", "Stage5 Catalog Mutation", 98765, product.id);
    try {
      const page = await get(`/invoice/${encodeURIComponent(order.order_number)}`, customer);
      c.equal(page.response.status, 200, "Historical invoice remains accessible after catalog changes.");
      c.ok(page.html.includes(savedItem.product_name), "Historical invoice uses the order-item product-name snapshot.");
      c.equal(page.html.includes("Stage5 Catalog Mutation"), false, "Invoice does not read the current product name.");
      c.ok(page.html.includes("Taxable value") && page.html.includes("GST included"), "Invoice renders its saved tax breakdown.");
      c.ok(page.html.includes("Payment") && page.html.includes("cod"), "Invoice shows payment method/status information.");
      c.ok(page.html.includes("Shipping") && page.html.includes("Discount"), "Invoice shows shipping and discount separately.");
      if (order.coupon_code) c.ok(page.html.includes(order.coupon_code), "Historical invoice retains its coupon reference after expiry.");
    } finally {
      await app.db.run("UPDATE products SET name=?,price=?,status=?,active=? WHERE id=?", originalProduct.name, originalProduct.price, originalProduct.status, originalProduct.active, product.id);
    }

    const deletedProduct = await app.db.get(`INSERT INTO products
      (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',200,1,5,'Historical invoice regression','Standard','Matte','Full color','navy',0,0) RETURNING id`,
    `${prefix}-deleted-invoice-product`, "Deleted Product Snapshot");
    productIds.push(Number(deletedProduct.id));
    const userId = Number((await app.db.get("SELECT user_id FROM sessions WHERE id=?", sessionId(customer))).user_id);
    const historical = await app.db.get(`INSERT INTO orders
      (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method,invoice_snapshot)
      VALUES (?, ?, 200,'Pending','Stage Five','9876500000','1 Test Road','Bengaluru','560001','cod',?::jsonb) RETURNING id,order_number`,
    `${prefix}-historical-invoice`, userId, JSON.stringify(app.createInvoiceSnapshot({ subtotalMinor: 20000, discountMinor: 0, shippingMinor: 0, totalMinor: 20000 })));
    orderIds.push(Number(historical.id));
    await app.db.run("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,1,200,'Standard · Matte · Full color')", historical.id, deletedProduct.id, "Deleted Product Snapshot");
    await app.db.run("DELETE FROM products WHERE id=?", deletedProduct.id);
    const orphanedCatalogLink = await app.db.get("SELECT product_id,product_name FROM order_items WHERE order_id=?", historical.id);
    c.equal(orphanedCatalogLink.product_id, null, "Historical order line survives product deletion with its catalog FK cleared.");
    const historicalPage = await get(`/invoice/${encodeURIComponent(historical.order_number)}`, customer);
    c.equal(historicalPage.response.status, 200, "Historical invoice remains available after its product is deleted.");
    c.ok(historicalPage.html.includes("Deleted Product Snapshot"), "Historical invoice retains the product description after product deletion.");

    async function makeOrder(label, paymentMethod = "cod") {
      const created = await app.db.get(`INSERT INTO orders
        (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method)
        VALUES (?,?,100,'Pending','Stage Five','9876500000','1 Test Road','Bengaluru','560001',?) RETURNING id`,
      `${prefix}-stage5-${label}`, userId, paymentMethod);
      orderIds.push(Number(created.id));
      await app.db.run("INSERT INTO order_status_events (order_id,status,previous_status,actor_type,actor_id,note) VALUES (?,'Pending',NULL,'customer',?,'Created for status regression')", created.id, userId);
      return Number(created.id);
    }

    const lifecycleOrder = await makeOrder("lifecycle");
    for (const [from, to] of [["Pending", "Printing"], ["Printing", "Packed"], ["Packed", "Shipped"], ["Shipped", "Delivered"]]) {
      const shipment = to === "Shipped" ? { trackingNumber: `${prefix}-tracking`, courierName: "Stage Five Courier", note: `Advance ${to}` } : { note: `Advance ${to}` };
      const changed = await app.transitionOrderStatus(lifecycleOrder, to, shipment, { actorType: "admin", actorId: userId });
      c.equal(changed.previousStatus, from, `${from} to ${to} transition is permitted.`);
    }
    const eventCount = Number((await app.db.get("SELECT COUNT(*) AS count FROM order_status_events WHERE order_id=?", lifecycleOrder)).count);
    const repeated = await app.transitionOrderStatus(lifecycleOrder, "Delivered", { note: "Repeated delivery request" }, { actorType: "admin", actorId: userId });
    c.equal(repeated.changed, false, "Repeated identical status is idempotent.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM order_status_events WHERE order_id=?", lifecycleOrder)).count), eventCount, "Repeated status does not create a duplicate audit event.");
    c.equal((await app.db.get("SELECT tracking_number FROM orders WHERE id=?", lifecycleOrder)).tracking_number, `${prefix}-tracking`, "Repeated status without shipment fields preserves existing tracking details.");
    const deliveredEvent = await app.db.get("SELECT previous_status,actor_type,actor_id,created_at FROM order_status_events WHERE order_id=? AND status='Delivered' ORDER BY id DESC LIMIT 1", lifecycleOrder);
    c.equal(deliveredEvent.previous_status, "Shipped", "Audit event stores previous status.");
    c.equal(deliveredEvent.actor_type, "admin", "Audit event records the initiating admin.");
    c.equal(Number(deliveredEvent.actor_id), userId, "Audit event records the initiating user ID.");
    c.ok(deliveredEvent.created_at, "Audit event has a database timestamp.");
    await c.rejects(() => app.transitionOrderStatus(lifecycleOrder, "Shipped"), error => error.code === "ORDER_TRANSITION_INVALID", "Delivered order cannot move back to Shipped.");
    await c.rejects(() => app.transitionOrderStatus(lifecycleOrder, "Pending"), error => error.code === "ORDER_TRANSITION_INVALID", "Delivered order cannot return to active earlier fulfillment.");
    await c.rejects(() => app.cancelOrder(lifecycleOrder), error => error.code === "ORDER_CANCELLATION_NOT_ALLOWED", "Delivered order cannot be cancelled through ordinary cancellation.");

    const cancelOrderId = await makeOrder("cancel");
    const cancelResult = await app.cancelOrder(cancelOrderId, { actor: { actorType: "admin", actorId: userId } });
    c.equal(cancelResult.status, "completed", "Eligible COD order cancellation completes without an online refund.");
    c.equal((await app.db.get("SELECT status FROM orders WHERE id=?", cancelOrderId)).status, "Cancelled", "COD cancellation persists the terminal cancelled state.");
    const cancelEvents = Number((await app.db.get("SELECT COUNT(*) AS count FROM order_status_events WHERE order_id=? AND status='Cancelled'", cancelOrderId)).count);
    c.equal(cancelEvents, 1, "Cancellation writes one status audit event.");
    const cancelEvent = await app.db.get("SELECT previous_status,actor_type,actor_id,created_at FROM order_status_events WHERE order_id=? AND status='Cancelled'", cancelOrderId);
    c.equal(cancelEvent.previous_status, "Pending", "Cancellation audit stores its prior state.");
    c.equal(cancelEvent.actor_type, "admin", "Cancellation audit records the initiating actor.");
    c.equal(Number(cancelEvent.actor_id), userId, "Cancellation audit records the initiating user ID.");
    c.ok(cancelEvent.created_at, "Cancellation audit event has a timestamp.");
    c.equal((await app.cancelOrder(cancelOrderId)).reused, true, "Duplicate cancellation reuses the completed result.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM order_status_events WHERE order_id=? AND status='Cancelled'", cancelOrderId)).count), cancelEvents, "Duplicate cancellation does not duplicate audit history.");
    await c.rejects(() => app.transitionOrderStatus(cancelOrderId, "Printing"), error => error.code === "ORDER_TRANSITION_INVALID", "Cancelled order cannot return to active fulfillment.");

    const unpaidOnlineId = await makeOrder("unpaid-online", "razorpay");
    await c.rejects(() => app.transitionOrderStatus(unpaidOnlineId, "Printing"), error => error.code === "ORDER_PAYMENT_NOT_SETTLED", "Unpaid/unlinked online order cannot enter fulfillment.");
    const adminOrders = await get("/admin/orders", admin);
    const invalidInput = await post("/admin/orders/status", { csrf: csrf(adminOrders.html), order_id: lifecycleOrder, status: "Bogus" }, adminOrders.cookie);
    c.equal(invalidInput.response.status, 303, "Invalid admin status input returns safely to order management.");
    c.equal((await app.db.get("SELECT status FROM orders WHERE id=?", lifecycleOrder)).status, "Delivered", "Invalid admin status is rejected instead of silently mapping to Pending.");
    const immutableEvent = await app.db.get("SELECT id FROM order_status_events WHERE order_id=? AND status='Delivered' ORDER BY id DESC LIMIT 1", lifecycleOrder);
    await c.rejects(() => app.db.run("UPDATE order_status_events SET note='overwritten' WHERE id=?", immutableEvent.id), error => error.message.includes("append-only"), "Status audit events cannot be silently overwritten.");

    return c.count;
  } finally {
    if (orderIds.length) await app.db.run(`DELETE FROM orders WHERE id IN (${orderIds.map(() => "?").join(",")})`, ...orderIds);
    if (productIds.length) await app.db.run(`DELETE FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`, ...productIds);
    await app.db.run("UPDATE products SET name=?,price=?,status=?,active=? WHERE id=?", originalProduct.name, originalProduct.price, originalProduct.status, originalProduct.active, product.id);
  }
}

module.exports = { assertOrderIntegrityBehavior };
