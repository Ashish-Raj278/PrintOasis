const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function counter() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); }
  };
}

async function assertOrderFinalizationBehavior({ app, prefix }) {
  const c = counter();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const sessions = [], products = [], intents = [], paymentIds = [], couponCodes = [], orders = [];
  const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id",
    "Order Finalization Regression", `${suffix}@example.test`, "unused-test-hash");

  async function addSession(label, product, quantity = 1, unitPrice = "150.00") {
    const id = crypto.randomBytes(24).toString("hex");
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)",
      id, user.id, crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    await app.db.run(`INSERT INTO cart_items
      (session_id,product_id,quantity,size,material,print_option,artwork_note,artwork_original_name,artwork_stored_name,artwork_mime,artwork_size,unit_price)
      VALUES (?,?,?,'Standard','Matte','Full color',NULL,NULL,NULL,NULL,NULL,?)`, id, product.id, quantity, unitPrice);
    sessions.push(id);
    return { id, user: { id: user.id }, label };
  }

  async function product(label, stock = 1) {
    const row = await app.db.get(`INSERT INTO products
      (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',150,1,4.8,'Order finalization fixture','Standard','Matte','Full color','navy',?,0) RETURNING id,name`,
    `${suffix}-${label}`, `Snapshot ${label}`, stock);
    products.push(row.id);
    return row;
  }

  async function checkout(label, opts = {}) {
    const p = opts.product || await product(label, opts.stock || 1);
    const session = await addSession(label, p, opts.quantity || 1, opts.unitPrice || "150.00");
    await app.db.run("UPDATE products SET reserved=reserved+? WHERE id=?", opts.quantity || 1, p.id);
    const couponCode = opts.couponCode || "";
    const form = {
      postal_code: "560001", coupon_code: couponCode,
      customer_name: `Buyer ${label}`, phone: "9876500000",
      address: `42 ${label} Road`, city: "Bengaluru", gst_number: ""
    };
    const intent = await app.createCheckoutIntent(session, form);
    intents.push(intent.id);
    const providerOrder = await app.createProviderOrder(session, form,
      async (amount, currency, receipt) => ({ id: `test_order_${suffix}_${label}`, amount, currency, receipt }));
    const paymentId = `pay_finalize_${suffix}_${label}`;
    paymentIds.push(paymentId);
    const signature = app.crypto.createHmac("sha256", app.RAZORPAY_KEY_SECRET)
      .update(`${providerOrder.provider_order_id}|${paymentId}`).digest("hex");
    const payment = await app.verifyProviderPayment(session, {
      razorpay_order_id: providerOrder.provider_order_id,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature
    }, async id => ({ id, order_id: providerOrder.provider_order_id, amount: Number(intent.amount_minor),
      currency: intent.currency, status: opts.paymentStatus || "captured", captured: opts.paymentCaptured !== false }));
    return { product: p, session, form, intent, providerOrder, payment, paymentId };
  }

  async function expectCode(work, code, message) {
    let error;
    try { await work(); } catch (caught) { error = caught; }
    c.equal(error?.code, code, message);
  }
  const orderByIntent = intentId => app.db.get("SELECT * FROM orders WHERE checkout_intent_id=?", intentId);

  try {
    c.equal(app.inrToMinor("4.99"), 499, "Decimal INR converts to paise without floating-point rounding.");
    c.equal(app.minorToInr(499), "4.99", "Paise convert to a fixed two-decimal INR value.");
    c.equal(app.productUnitPriceMinor({ price: 499, min_qty: 100 }), 499, "Catalog minimum-quantity price yields an exact paise unit rate.");
    c.equal(app.productUnitPriceMinor({ price: 749, min_qty: 50 }), 1498, "Catalog divisor produces a whole-paise unit rate.");
    let unsupportedCatalogRate = false;
    try { app.productUnitPriceMinor({ price: 100, min_qty: 3 }); } catch { unsupportedCatalogRate = true; }
    c.ok(unsupportedCatalogRate, "Catalog price/minimum-quantity rates that cannot be represented in paise are rejected.");
    const fractionalCatalogProduct = await app.db.get(`INSERT INTO products
      (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',499,100,4.8,'Fractional catalog fixture','Standard','Matte','Full color','navy',1,0)
      RETURNING *`, `${suffix}-fractional-catalog`, "Fractional catalog fixture");
    products.push(Number(fractionalCatalogProduct.id));
    const fractionalCatalogSessionId = crypto.randomBytes(24).toString("hex");
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)",
      fractionalCatalogSessionId, user.id, crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    sessions.push(fractionalCatalogSessionId);
    await app.addCartItem(fractionalCatalogSessionId, fractionalCatalogProduct, 1,
      { size: "Standard", material: "Matte", printOption: "Full color" });
    const catalogCart = await app.cartData(fractionalCatalogSessionId);
    c.equal(String(catalogCart.items[0].unit_price), "4.99", "Cart insertion stores the exact catalog-derived paise unit price.");
    c.equal(catalogCart.subtotal_minor, 499, "Cart subtotal sums the catalog-derived price in integer paise.");

    const normal = await checkout("normal");
    const orderNumber = await app.finalizeCapturedCheckout(normal.session, normal.paymentId, { notify: false });
    const order = await app.db.get("SELECT * FROM orders WHERE order_number=?", orderNumber);
    orders.push(order.id);
    c.ok(order, "Captured payment creates a local order.");
    c.equal(Number(order.checkout_intent_id), Number(normal.intent.id), "Order links to its checkout intent.");
    c.equal(Number(order.payment_record_id), Number(normal.payment.id), "Order links to normalized captured payment.");
    c.equal(order.payment_id, normal.paymentId, "Legacy payment ID remains populated for compatibility.");
    c.equal(order.payment_method, "razorpay", "Finalized online order retains existing payment method semantics.");
    c.equal(Number(order.total), Number(normal.intent.amount_minor) / 100, "Order total comes from durable intent amount.");
    c.equal((await app.db.get("SELECT status FROM checkout_intents WHERE id=?", normal.intent.id)).status, "completed", "Intent becomes completed atomically.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", normal.product.id)).stock), 0, "Reserved unit is deducted from physical stock.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", normal.product.id)).reserved), 0, "Finalization releases only the consumed reservation.");
    const itemCount = Number((await app.db.get("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?", order.id)).count);
    c.equal(itemCount, 1, "One immutable order item is created from the intent snapshot.");
    c.equal(await app.finalizeCapturedCheckout(normal.session, normal.paymentId, { notify: false }), orderNumber,
      "Repeated finalization returns the existing order.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM orders WHERE checkout_intent_id=?", normal.intent.id)).count), 1,
      "Intent uniqueness prevents a second order.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?", order.id)).count), itemCount,
      "Repeated finalization does not duplicate order items or inventory consumption.");

    const concurrent = await checkout("concurrent");
    const concurrentNumbers = await Promise.all([
      app.finalizeCapturedCheckout(concurrent.session, concurrent.paymentId, { notify: false }),
      app.finalizeCapturedCheckout(concurrent.session, concurrent.paymentId, { notify: false })
    ]);
    c.equal(concurrentNumbers[0], concurrentNumbers[1], "Concurrent finalizers converge on the same order.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM orders WHERE checkout_intent_id=?", concurrent.intent.id)).count), 1,
      "Concurrent requests create at most one order.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", concurrent.product.id)).stock), 0,
      "Concurrent requests consume inventory exactly once.");
    orders.push(Number((await orderByIntent(concurrent.intent.id)).id));

    const authorized = await checkout("not-captured", { paymentStatus: "authorized", paymentCaptured: false });
    await expectCode(() => app.finalizeCapturedCheckout(authorized.session, authorized.paymentId, { notify: false }),
      "ORDER_FINALIZATION_PAYMENT_INVALID", "Authorized/non-captured payment cannot create an order.");
    c.equal(await orderByIntent(authorized.intent.id), undefined, "Non-captured payment leaves no order.");

    const ownerA = await checkout("owner-a");
    const ownerB = await checkout("owner-b");
    await expectCode(() => app.finalizeCapturedCheckout(ownerA.session, ownerB.paymentId, { notify: false }),
      "ORDER_FINALIZATION_INTENT_NOT_FOUND", "Payment from another session/intent cannot finalize this buyer's checkout.");
    c.equal(await orderByIntent(ownerA.intent.id), undefined, "Mismatched payment relationship creates no order.");

    const changedCart = await checkout("cart-changed", { stock: 2 });
    await app.db.run("UPDATE cart_items SET quantity=quantity+1 WHERE session_id=? AND product_id=?",
      changedCart.session.id, changedCart.product.id);
    await app.db.run("UPDATE products SET reserved=reserved+1 WHERE id=?", changedCart.product.id);
    const changedOrderNumber = await app.finalizeCapturedCheckout(changedCart.session, changedCart.paymentId, { notify: false });
    const changedOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", changedOrderNumber);
    orders.push(changedOrder.id);
    c.equal(Number((await app.db.get("SELECT quantity FROM order_items WHERE order_id=?", changedOrder.id)).quantity), 1,
      "Cart quantity changes after payment do not change snapshot order quantity.");
    c.equal(Number((await app.db.get("SELECT quantity FROM cart_items WHERE session_id=?", changedCart.session.id)).quantity), 1,
      "Only the intent-owned quantity is consumed; later cart quantity remains reserved.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", changedCart.product.id)).reserved), 1,
      "Unconsumed session reservation remains intact.");

    const changedPrice = await checkout("price-changed");
    await app.db.run("UPDATE products SET price=999 WHERE id=?", changedPrice.product.id);
    const priceOrderNumber = await app.finalizeCapturedCheckout(changedPrice.session, changedPrice.paymentId, { notify: false });
    const priceOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", priceOrderNumber);
    orders.push(priceOrder.id);
    c.equal(Number((await app.db.get("SELECT unit_price FROM order_items WHERE order_id=?", priceOrder.id)).unit_price), 150,
      "Product price changes after payment do not alter snapshot unit price.");
    c.equal(Number(priceOrder.total), Number(changedPrice.intent.amount_minor) / 100, "Paid intent amount remains authoritative after catalog price changes.");

    const couponCode = `FINAL${crypto.randomBytes(5).toString("hex")}`.toUpperCase();
    couponCodes.push(couponCode);
    await app.db.run("INSERT INTO coupons (code,type,value,minimum_order,active) VALUES (?,'fixed',10,0,1)", couponCode);
    const couponFixture = await checkout("coupon-changed", { couponCode });
    await app.db.run("UPDATE coupons SET value=99,active=0,expiry_date='2000-01-01' WHERE code=?", couponCode);
    const couponOrderNumber = await app.finalizeCapturedCheckout(couponFixture.session, couponFixture.paymentId, { notify: false });
    const couponOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", couponOrderNumber);
    orders.push(couponOrder.id);
    const couponSnapshot = await app.db.get("SELECT shipping_input FROM checkout_intents WHERE id=?", couponFixture.intent.id);
    c.equal(Number(couponOrder.discount), Number(couponSnapshot.shipping_input.discount_minor) / 100,
      "Coupon changes/expiry after payment do not change the checkout snapshot discount.");
    c.equal(Number(couponOrder.total), Number(couponFixture.intent.amount_minor) / 100, "Coupon recalculation is not performed during finalization.");

    const sharedProduct = await product("competing-sessions", 2);
    const buyerOne = await checkout("competing-one", { product: sharedProduct });
    const buyerTwo = await checkout("competing-two", { product: sharedProduct });
    const buyerOneOrder = await app.finalizeCapturedCheckout(buyerOne.session, buyerOne.paymentId, { notify: false });
    const sharedOrder = await app.db.get("SELECT id FROM orders WHERE order_number=?", buyerOneOrder);
    orders.push(sharedOrder.id);
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM cart_items WHERE session_id=?", buyerTwo.session.id)).count), 1,
      "Finalizing one checkout does not consume another session's reservation.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", sharedProduct.id)).stock), 1,
      "Only the first buyer's unit is deducted.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", sharedProduct.id)).reserved), 1,
      "Other buyer's reservation remains reserved.");

    const lastUnit = await checkout("last-unit", { stock: 1 });
    const competitorSessionId = crypto.randomBytes(24).toString("hex");
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)", competitorSessionId,
      user.id, crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    sessions.push(competitorSessionId);
    let competingReservationError;
    try {
      await app.addCartItem(competitorSessionId, await app.db.get("SELECT * FROM products WHERE id=?", lastUnit.product.id), 1,
        { size: "Standard", material: "Matte", printOption: "Full color" });
    } catch (error) { competingReservationError = error; }
    c.ok(competingReservationError, "A competing session cannot reserve the already-reserved final unit.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", lastUnit.product.id)).reserved), 1,
      "Final-unit contention preserves the stock/reserved invariant.");

    const expired = await checkout("expired-intent");
    await app.db.run("UPDATE checkout_intents SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours', expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=?", expired.intent.id);
    await expectCode(() => app.finalizeCapturedCheckout(expired.session, expired.paymentId, { notify: false }),
      "ORDER_FINALIZATION_INTENT_EXPIRED", "Expired checkout intent cannot create a new order.");
    c.equal(await orderByIntent(expired.intent.id), undefined, "Expired intent leaves no order.");

    const inconsistent = await checkout("inconsistent-stock");
    await app.db.run("UPDATE products SET reserved=0 WHERE id=?", inconsistent.product.id);
    await expectCode(() => app.finalizeCapturedCheckout(inconsistent.session, inconsistent.paymentId, { notify: false }),
      "ORDER_FINALIZATION_INVENTORY_CONFLICT", "Insufficient inventory fails safely.");
    c.equal(await orderByIntent(inconsistent.intent.id), undefined, "Inventory conflict creates no partial order.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", inconsistent.product.id)).reserved), 0,
      "Inventory conflict leaves the inconsistent reservation state untouched.");
    await app.db.run("UPDATE products SET reserved=1 WHERE id=?", inconsistent.product.id);
    c.ok(await app.finalizeCapturedCheckout(inconsistent.session, inconsistent.paymentId, { notify: false }),
      "Retry succeeds after the inventory inconsistency is repaired.");
    const retriedOrder = await orderByIntent(inconsistent.intent.id);
    orders.push(retriedOrder.id);

    const missingReservation = await checkout("missing-reservation");
    await app.db.run("DELETE FROM cart_items WHERE session_id=?", missingReservation.session.id);
    await app.db.run("UPDATE products SET reserved=0 WHERE id=?", missingReservation.product.id);
    await expectCode(() => app.finalizeCapturedCheckout(missingReservation.session, missingReservation.paymentId, { notify: false }),
      "ORDER_FINALIZATION_RESERVATION_MISSING", "Missing intent-owned reservation cannot be substituted from another session.");
    c.equal(await orderByIntent(missingReservation.intent.id), undefined, "Missing reservation leaves no order.");

    const rollback = await checkout("transaction-retry");
    const originalTransaction = app.db.transaction.bind(app.db);
    app.db.transaction = work => originalTransaction(tx => work(new Proxy(tx, {
      get(target, property) {
        if (property === "run") return (sql, ...params) => {
          if (/^\s*INSERT\s+INTO\s+order_items/i.test(sql)) throw new Error("isolated injected order-item write failure");
          return target.run(sql, ...params);
        };
        return target[property].bind(target);
      }
    })));
    let injectedFailure;
    try { await app.finalizeCapturedCheckout(rollback.session, rollback.paymentId, { notify: false }); }
    catch (error) { injectedFailure = error; }
    finally { app.db.transaction = originalTransaction; }
    c.ok(injectedFailure, "Injected database write failure aborts finalization.");
    c.equal(await orderByIntent(rollback.intent.id), undefined, "Failed transaction leaves no order row.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", rollback.product.id)).stock), 1,
      "Failed transaction does not deduct stock.");
    c.equal(Number((await app.db.get("SELECT reserved FROM products WHERE id=?", rollback.product.id)).reserved), 1,
      "Failed transaction preserves the reservation for retry.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE provider_payment_id=?", rollback.paymentId)).status, "captured",
      "Order-write failure does not fabricate payment failure.");
    c.ok(await app.finalizeCapturedCheckout(rollback.session, rollback.paymentId, { notify: false }),
      "Retry after a rolled-back order transaction succeeds.");
    const rollbackOrder = await orderByIntent(rollback.intent.id);
    orders.push(rollbackOrder.id);

    const completed = await checkout("already-finalized");
    const completedNumber = await app.finalizeCapturedCheckout(completed.session, completed.paymentId, { notify: false });
    const completedId = Number((await orderByIntent(completed.intent.id)).id);
    orders.push(completedId);
    c.equal(await app.finalizeCapturedCheckout(completed.session, completed.paymentId, { notify: false }), completedNumber,
      "Completed intent reuses its one existing order.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?", completedId)).count), 1,
      "Already-finalized intent has no duplicate order items.");

    const fractional = await checkout("fractional-online", { unitPrice: "4.99" });
    c.equal(Number(fractional.intent.amount_minor), 10399, "Fractional item price plus delivery produces an exact paise checkout amount.");
    const fractionalNumber = await app.finalizeCapturedCheckout(fractional.session, fractional.paymentId, { notify: false });
    const fractionalOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", fractionalNumber);
    orders.push(fractionalOrder.id);
    const fractionalLine = await app.db.get("SELECT unit_price,quantity FROM order_items WHERE order_id=?", fractionalOrder.id);
    c.equal(String(fractionalOrder.total), "103.99", "Captured order stores the exact two-decimal INR total.");
    c.equal(String(fractionalLine.unit_price), "4.99", "Captured order item preserves the paise unit rate.");
    c.equal(Number(fractionalOrder.invoice_snapshot.total_minor), 10399, "Fractional captured order invoice retains exact total paise.");

    const fractionalCodProduct = await product("fractional-cod");
    const fractionalCodSession = await addSession("fractional-cod", fractionalCodProduct, 1, "4.99");
    await app.db.run("UPDATE products SET reserved=reserved+1 WHERE id=?", fractionalCodProduct.id);
    const fractionalCodCart = await app.cartData(fractionalCodSession.id);
    const fractionalCodNumber = await app.createLocalOrder(fractionalCodSession, fractionalCodCart, {
      postal_code: "560001", customer_name: "Fractional COD", phone: "9876500000",
      address: "4 Fractional Road", city: "Bengaluru", gst_number: ""
    }, "cod", null, { notify: false });
    const fractionalCodOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", fractionalCodNumber);
    orders.push(fractionalCodOrder.id);
    const fractionalCodLine = await app.db.get("SELECT unit_price FROM order_items WHERE order_id=?", fractionalCodOrder.id);
    c.equal(String(fractionalCodOrder.total), "103.99", "COD order stores the same exact decimal INR total.");
    c.equal(String(fractionalCodLine.unit_price), "4.99", "COD order item preserves the paise unit rate.");
    c.equal(Number(fractionalCodOrder.invoice_snapshot.total_minor), 10399, "COD invoice snapshot retains exact total paise.");

    const codFixture = await checkout("cod-compatible");
    const codOrderNumber = await app.createLocalOrder(codFixture.session, await app.cartData(codFixture.session.id),
      codFixture.form, "cod", null, { notify: false });
    const codOrder = await app.db.get("SELECT * FROM orders WHERE order_number=?", codOrderNumber);
    orders.push(codOrder.id);
    c.ok(codOrder && codOrder.payment_method === "cod" && codOrder.checkout_intent_id == null && codOrder.payment_record_id == null,
      "Legacy COD order creation remains independent of online payment state.");
    return c.count;
  } finally {
    await app.db.transaction(async tx => {
      if (orders.length) {
        await tx.run(`DELETE FROM notifications WHERE order_id IN (${orders.map(() => "?").join(",")})`, ...orders);
        await tx.run(`DELETE FROM order_status_events WHERE order_id IN (${orders.map(() => "?").join(",")})`, ...orders);
        await tx.run(`DELETE FROM order_items WHERE order_id IN (${orders.map(() => "?").join(",")})`, ...orders);
        await tx.run(`DELETE FROM orders WHERE id IN (${orders.map(() => "?").join(",")})`, ...orders);
      }
      if (intents.length) await tx.run(`DELETE FROM payments WHERE checkout_intent_id IN (${intents.map(() => "?").join(",")})`, ...intents);
      if (paymentIds.length) await tx.run(`DELETE FROM payment_webhook_events WHERE provider_payment_id IN (${paymentIds.map(() => "?").join(",")})`, ...paymentIds);
      if (couponCodes.length) await tx.run(`DELETE FROM coupons WHERE code IN (${couponCodes.map(() => "?").join(",")})`, ...couponCodes);
      if (intents.length) await tx.run(`DELETE FROM provider_orders WHERE checkout_intent_id IN (${intents.map(() => "?").join(",")})`, ...intents);
      for (const sessionId of sessions) {
        await tx.run("DELETE FROM checkout_intents WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM cart_items WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM sessions WHERE id=?", sessionId);
      }
      for (const productId of new Set(products.map(Number))) await tx.run("DELETE FROM products WHERE id=?", productId);
      await tx.run("DELETE FROM users WHERE id=?", user.id);
    });
  }
}

module.exports = { assertOrderFinalizationBehavior };
