const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createEmailService, orderEmailTemplate } = require("../services/email");
const { assertWebhookReconciliationBehavior } = require("./webhook-reconciliation-regression");
const { assertOrderFinalizationBehavior } = require("./order-finalization-regression");
const { assertRefundRecoveryBehavior } = require("./refund-recovery-regression");
const { assertAuthSecurityBehavior } = require("./auth-security-regression");
const { assertUploadAccessBehavior } = require("./upload-security-regression");

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

async function assertPaymentSchema({ app, prefix, customer, sessionId }) {
  const c = checks();
  const migrationName = "002-checkout-payment-foundation.sql";
  c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name=?", migrationName), "Payment foundation migration is recorded.");
  c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name=?", "005-auth-security.sql"), "Auth/security migration is recorded.");
  c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name=?", "006-private-artwork-access.sql"), "Private artwork-access migration is recorded.");
  for (const column of ["artwork_original_name", "artwork_stored_name", "artwork_mime", "artwork_size"]) {
    c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name=?", column), `order_items.${column} preserves artwork references after checkout.`);
  }
  c.ok(await app.db.get("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_order_items_artwork_stored_name'"), "Order artwork reference lookup index exists.");
  c.ok(await app.db.get("SELECT to_regclass('public.account_tokens') AS name"), "Durable account token table exists.");
  c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='email_verified'"), "Email verification state exists for users.");
  c.ok(await app.db.get("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_account_tokens_expiry'"), "Account-token expiry lookup index exists.");
  c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name=?", "003-provider-order-lifecycle.sql"), "Provider-order lifecycle migration is recorded.");
  c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_id'"), "Legacy order payment_id remains available.");
  c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cart_items' AND column_name='session_id'"), "Existing session-backed cart schema remains intact.");
  for (const table of ["checkout_intents", "provider_orders", "payments", "payment_webhook_events", "refunds"]) {
    c.ok(await app.db.get("SELECT to_regclass(?) AS name", `public.${table}`), `${table} exists.`);
  }
  for (const index of ["idx_checkout_intents_session_created", "idx_checkout_intents_user_created", "idx_provider_orders_intent_created", "idx_provider_orders_intent_provider_unique", "idx_provider_orders_status_lease", "idx_payments_intent_created", "idx_payment_webhooks_processing", "idx_refunds_order_created", "idx_refunds_payment_created", "idx_orders_checkout_intent_unique", "idx_orders_payment_record_unique"]) {
    c.ok(await app.db.get("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=?", index), `${index} exists.`);
  }
  for (const column of ["status", "provider_amount_minor", "provider_currency", "attempt_count", "claim_token", "lease_expires_at", "last_error", "updated_at", "completed_at"]) {
    c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='provider_orders' AND column_name=?", column), `provider_orders.${column} exists.`);
  }

  const rollbackMarker = `payment-schema-assertions-${prefix}`;
  try {
    await app.db.transaction(async tx => {
      const session = await tx.get("SELECT user_id FROM sessions WHERE id=?", sessionId(customer));
      c.ok(session?.user_id, "Regression customer session has a database user owner.");
      const userId = session.user_id;
      const token = `${prefix}-${require("node:crypto").randomUUID()}`;
      const createIntent = async (key, status = "pending") => tx.get(
        `INSERT INTO checkout_intents
          (idempotency_key,session_id,user_id,cart_snapshot,amount_minor,currency,coupon_code,shipping_input,status,expires_at)
         VALUES (?,?,?,?::jsonb,1299,'INR','SCHEMA-COUPON',?::jsonb,?,CURRENT_TIMESTAMP + INTERVAL '1 hour')
         RETURNING id`,
        key, sessionId(customer), userId, JSON.stringify([{ product: "snapshot-item", quantity: 1, unit_amount_minor: 1299 }]), "{}", status
      );
      const expectCode = async (code, message, operation) => {
        await tx.query("SAVEPOINT payment_schema_expected_error");
        let error;
        try { await operation(); } catch (caught) { error = caught; }
        await tx.query("ROLLBACK TO SAVEPOINT payment_schema_expected_error");
        await tx.query("RELEASE SAVEPOINT payment_schema_expected_error");
        c.equal(error?.code, code, message);
      };

      const intent = await createIntent(`${token}-intent`);
      c.ok(intent?.id, "Checkout intent stores its immutable purchase snapshot and amount.");
      await expectCode("23505", "Checkout idempotency key is unique.", () => createIntent(`${token}-intent`));
      await expectCode("23514", "Invalid checkout intent state is rejected.", () => createIntent(`${token}-bad-state`, "not-a-state"));
      const secondIntent = await createIntent(`${token}-intent-2`);

      const providerOrder = await tx.get(
        `INSERT INTO provider_orders (checkout_intent_id,provider,provider_order_id,provider_receipt,expected_amount_minor,currency,status,provider_amount_minor,provider_currency)
         VALUES (?,'razorpay',?,?,1299,'INR','created',1299,'INR') RETURNING id`, intent.id, `${token}-provider-order`, `${token}-receipt`
      );
      c.ok(providerOrder?.id, "Provider order maps to a local checkout intent.");
      await expectCode("23505", "Provider order ID is unique per provider.", () => tx.run(
        "INSERT INTO provider_orders (checkout_intent_id,provider,provider_order_id,expected_amount_minor,currency,status,provider_amount_minor,provider_currency) VALUES (?,'razorpay',?,1299,'INR','created',1299,'INR')",
        intent.id, `${token}-provider-order`
      ));
      await expectCode("23503", "Provider order rejects a missing checkout intent.", () => tx.run(
        "INSERT INTO provider_orders (checkout_intent_id,provider,provider_order_id,expected_amount_minor,currency,status,provider_amount_minor,provider_currency) VALUES (999999999999,'razorpay',?,1299,'INR','created',1299,'INR')",
        `${token}-orphan-provider-order`
      ));

      const paymentRows = {};
      for (const status of ["pending", "authorized", "captured", "failed", "refunded", "partially_refunded"]) {
        const payment = await tx.get(
          `INSERT INTO payments
            (checkout_intent_id,provider_order_record_id,provider,provider_payment_id,expected_amount_minor,verified_amount_minor,currency,status,provider_reference,verified_at,captured_at)
           VALUES (?,?, 'razorpay', ?,1299,1299,'INR',?,'safe-test-reference',CURRENT_TIMESTAMP,?) RETURNING id`,
          intent.id, providerOrder.id, `${token}-payment-${status}`, status, status === "captured" ? new Date() : null
        );
        paymentRows[status] = payment.id;
        c.ok(payment?.id, `Payment state ${status} is accepted.`);
      }
      await expectCode("23505", "Provider payment ID is unique per provider.", () => tx.run(
        `INSERT INTO payments (checkout_intent_id,provider_order_record_id,provider,provider_payment_id,expected_amount_minor,currency,status)
         VALUES (?,?,'razorpay',?,1299,'INR','pending')`, intent.id, providerOrder.id, `${token}-payment-pending`
      ));
      await expectCode("23514", "Invalid payment state is rejected.", () => tx.run(
        `INSERT INTO payments (checkout_intent_id,provider_order_record_id,provider,provider_payment_id,expected_amount_minor,currency,status)
         VALUES (?,?,'razorpay',?,1299,'INR','not-a-state')`, intent.id, providerOrder.id, `${token}-bad-payment`
      ));

      const webhook = await tx.get(
        `INSERT INTO payment_webhook_events (provider,provider_event_id,event_type,provider_order_id,provider_payment_id,safe_metadata)
         VALUES ('razorpay',?,'payment.captured',?,?,?::jsonb) RETURNING id`,
        `${token}-event`, `${token}-provider-order`, `${token}-payment-captured`, JSON.stringify({ source: "schema-test" })
      );
      c.ok(webhook?.id, "Webhook inbox accepts a safe event record.");
      await expectCode("23505", "Webhook event ID is unique per provider.", () => tx.run(
        "INSERT INTO payment_webhook_events (provider,provider_event_id,event_type) VALUES ('razorpay',?,'payment.captured')",
        `${token}-event`
      ));
      await expectCode("23514", "Invalid webhook processing state is rejected.", () => tx.run(
        "INSERT INTO payment_webhook_events (provider,provider_event_id,event_type,processing_status) VALUES ('razorpay',?,'payment.captured','not-a-state')",
        `${token}-bad-event`
      ));

      const codOrder = await tx.get(
        `INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method)
         VALUES (?,? ,1299,'Pending','COD Compatibility','9876500000','1 Test Road','Bengaluru','560001','cod') RETURNING id,checkout_intent_id,payment_record_id`,
        `${token}-cod-order`, userId
      );
      c.ok(codOrder && codOrder.checkout_intent_id === null && codOrder.payment_record_id === null, "Existing COD order shape remains valid without payment records.");

      const paidOrder = await tx.get(
        `INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method,checkout_intent_id,payment_record_id)
         VALUES (?,? ,1299,'Pending','Linked Payment','9876500000','2 Test Road','Bengaluru','560001','razorpay',?,?) RETURNING id`,
        `${token}-linked-order`, userId, intent.id, paymentRows.captured
      );
      c.ok(paidOrder?.id, "Order can link to its checkout intent and payment state.");
      const thirdIntent = await createIntent(`${token}-intent-3`);
      const secondProviderOrder = await tx.get(
        `INSERT INTO provider_orders (checkout_intent_id,provider,provider_order_id,expected_amount_minor,currency,status,provider_amount_minor,provider_currency)
         VALUES (?,'razorpay',?,1299,'INR','created',1299,'INR') RETURNING id`, secondIntent.id, `${token}-second-provider-order`
      );
      const secondPayment = await tx.get(
        `INSERT INTO payments (checkout_intent_id,provider_order_record_id,provider,provider_payment_id,expected_amount_minor,currency,status)
         VALUES (?,?,'razorpay',?,1299,'INR','captured') RETURNING id`,
        secondIntent.id, secondProviderOrder.id, `${token}-second-payment`
      );
      await expectCode("23505", "Only one order can be linked to a checkout intent.", () => tx.run(
        `INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method,checkout_intent_id)
         VALUES (?,? ,1299,'Pending','Duplicate Intent','9876500000','3 Test Road','Bengaluru','560001','razorpay',?)`,
        `${token}-duplicate-intent-order`, userId, intent.id
      ));
      await expectCode("23503", "Order payment must belong to the same checkout intent.", () => tx.run(
        `INSERT INTO orders (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method,checkout_intent_id,payment_record_id)
         VALUES (?,? ,1299,'Pending','Mismatched Payment','9876500000','4 Test Road','Bengaluru','560001','razorpay',?,?)`,
        `${token}-mismatched-order`, userId, thirdIntent.id, secondPayment.id
      ));

      const refund = await tx.get(
        `INSERT INTO refunds (order_id,checkout_intent_id,payment_record_id,provider,provider_refund_id,idempotency_key,amount_minor,currency,reason)
         VALUES (?,?,?,'razorpay',?,?,1299,'INR','schema test') RETURNING id`,
        paidOrder.id, intent.id, paymentRows.captured, `${token}-provider-refund`, `${token}-refund-key`
      );
      c.ok(refund?.id, "Refund references its order and payment.");
      await expectCode("23505", "Refund idempotency key is unique.", () => tx.run(
        `INSERT INTO refunds (order_id,checkout_intent_id,payment_record_id,provider,idempotency_key,amount_minor,currency)
         VALUES (?,?,?,'razorpay',?,1299,'INR')`, paidOrder.id, intent.id, paymentRows.captured, `${token}-refund-key`
      ));
      await expectCode("23505", "Provider refund ID is unique per provider.", () => tx.run(
        `INSERT INTO refunds (order_id,checkout_intent_id,payment_record_id,provider,provider_refund_id,idempotency_key,amount_minor,currency)
         VALUES (?,?,?,'razorpay',?,?,1299,'INR')`, paidOrder.id, intent.id, paymentRows.captured, `${token}-provider-refund`, `${token}-refund-key-2`
      ));
      await expectCode("23514", "Invalid refund state is rejected.", () => tx.run(
        `INSERT INTO refunds (order_id,checkout_intent_id,payment_record_id,provider,idempotency_key,amount_minor,currency,status)
         VALUES (?,?,?,'razorpay',?,1299,'INR','not-a-state')`, paidOrder.id, intent.id, paymentRows.captured, `${token}-bad-refund`
      ));
      throw new Error(rollbackMarker);
    });
  } catch (error) {
    if (error.message !== rollbackMarker) throw error;
  }
  return c.count;
}

async function assertCheckoutIntentBehavior({ app, prefix }) {
  const c = checks();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const sessions = [];
  const products = [];
  const couponStem = `S2A${crypto.randomBytes(6).toString("hex")}`.toUpperCase();
  const coupons = [`${couponStem}V`, `${couponStem}E`];
  let userId;
  const addSession = async (ownerId = null) => {
    const id = crypto.randomBytes(24).toString("hex");
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)", id, ownerId, crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    sessions.push(id);
    return id;
  };
  const addProduct = async (label, stock, reserved, price = 120) => {
    const product = await app.db.get(`
      INSERT INTO products (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?, 'business-cards', ?,1,4.8,'Intent regression fixture','Standard','Matte','Full color','cobalt',?,?) RETURNING id`,
    `${suffix}-${label}`, `Intent test ${label}`, price, stock, reserved);
    products.push(product.id);
    return product;
  };
  const addCart = async (session, productId, quantity, unitPrice = 120) => app.db.run(
    `INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price)
     VALUES (?,?,?,'Standard','Matte','Full color',?)`, session, productId, quantity, unitPrice
  );
  const expectFailure = async (work, pattern, message) => {
    let failure;
    try { await work(); } catch (error) { failure = error; }
    c.match(failure?.message || "", pattern, message);
  };

  try {
    const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id", "Intent Test Customer", `${suffix}@example.test`, "unused-test-hash");
    userId = user.id;
    const authenticatedSession = await addSession(userId);
    const anonymousSession = await addSession();
    const competingSession = await addSession();
    const concurrentSession = await addSession();
    const finalOwnerSession = await addSession();

    const sharedProduct = await addProduct("shared", 10, 3);
    await addCart(authenticatedSession, sharedProduct.id, 2);
    await addCart(anonymousSession, sharedProduct.id, 1);
    const finalProduct = await addProduct("final-unit", 1, 1);
    await addCart(finalOwnerSession, finalProduct.id, 1);
    const concurrentProduct = await addProduct("concurrent", 2, 1);
    await addCart(concurrentSession, concurrentProduct.id, 1);

    await app.db.run("INSERT INTO coupons (code,type,value,minimum_order,active) VALUES (?,'fixed',10,0,1)", coupons[0]);
    await app.db.run("INSERT INTO coupons (code,type,value,minimum_order,expiry_date,active) VALUES (?,'fixed',10,0,'2000-01-01',1)", coupons[1]);
    const schemaAssertions = await assertPaymentSchema({
      app,
      prefix: suffix,
      customer: `sid=${authenticatedSession}`,
      sessionId: cookie => cookie.slice(4)
    });

    const request = { postal_code: "560001", coupon_code: "", amount: "1", total: "1", expected_amount: "1" };
    const first = await app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, request);
    c.equal(first.reused, false, "First checkout request creates an intent.");
    c.match(first.idempotency_key, /^[a-f0-9]{64}$/, "Intent idempotency key is cryptographically random and server-generated.");
    c.equal(Number(first.amount_minor), 33900, "Expected minor-unit amount is server-calculated, not client-submitted.");
    c.equal(first.currency, "INR", "Intent records the explicit currency.");
    const firstRow = await app.db.get("SELECT * FROM checkout_intents WHERE id=?", first.id);
    c.equal(firstRow.user_id, userId, "Authenticated intent is bound to its user.");
    c.equal(firstRow.session_id, authenticatedSession, "Intent is bound to its exact session.");
    c.equal(Number(firstRow.cart_snapshot[0].quantity), 2, "Authenticated snapshot contains only its own cart quantity.");
    c.equal(Number(firstRow.cart_snapshot[0].product_id), Number(sharedProduct.id), "Snapshot product identity comes from the session cart.");

    const repeated = await app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, request);
    c.equal(repeated.id, first.id, "Same checkout request reuses its existing intent.");
    c.equal(repeated.idempotency_key, first.idempotency_key, "Retry returns the same idempotency key.");
    c.equal(repeated.reused, true, "Retry is reported as reuse.");
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, request)));
    c.ok(duplicates.every(intent => String(intent.id) === String(first.id) && intent.idempotency_key === first.idempotency_key), "Concurrent duplicate requests converge on one intent.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM checkout_intents WHERE session_id=? AND status='pending'", authenticatedSession)).count), 1, "Concurrent duplicate requests create no additional intent.");

    const anonymousIntent = await app.createCheckoutIntent({ id: anonymousSession, user: null }, request);
    const anonymousRow = await app.db.get("SELECT * FROM checkout_intents WHERE id=?", anonymousIntent.id);
    c.equal(anonymousRow.user_id, null, "Anonymous checkout intent permits nullable user ownership.");
    c.equal(anonymousRow.session_id, anonymousSession, "Anonymous intent remains bound to its session.");
    c.equal(Number(anonymousRow.cart_snapshot[0].quantity), 1, "Different session receives only its own cart snapshot.");
    c.ok(Number(anonymousRow.cart_snapshot[0].product_id) === Number(sharedProduct.id), "Competing session uses its own reserved product row.");

    const couponIntent = await app.createCheckoutIntent({ id: anonymousSession, user: null }, { ...request, coupon_code: coupons[0] });
    const couponRow = await app.db.get("SELECT coupon_code,shipping_input,amount_minor FROM checkout_intents WHERE id=?", couponIntent.id);
    c.equal(couponRow.coupon_code, coupons[0], "Coupon input is captured in the intent.");
    c.equal(couponRow.shipping_input.coupon.code, coupons[0], "Coupon calculation inputs are snapshotted for reproduction.");
    c.equal(Number(couponRow.amount_minor), 20900, "Coupon discount is included in the expected amount.");
    c.equal(Number(couponRow.shipping_input.shipping_minor), 9900, "Shipping input and computed fee are snapshotted.");

    await expectFailure(() => app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, { ...request, coupon_code: `${suffix}-MISSING` }), /Coupon code is invalid\./, "Invalid coupon is rejected before creating a payable intent.");
    await expectFailure(() => app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, { ...request, coupon_code: coupons[1] }), /This coupon has expired\./, "Expired coupon is rejected before creating a payable intent.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM checkout_intents WHERE session_id=?", authenticatedSession)).count), 1, "Invalid coupons create no checkout intent.");

    await expectFailure(() => app.createCheckoutIntent({ id: competingSession, user: null }, request), /cart is empty/i, "Another session cannot use the first session's reservation to create an intent.");
    const finalOwnerIntent = await app.createCheckoutIntent({ id: finalOwnerSession, user: null }, request);
    c.ok(finalOwnerIntent.id, "Session owning the final-unit cart reservation can create its intent.");
    await expectFailure(() => app.createCheckoutIntent({ id: competingSession, user: null }, request), /cart is empty/i, "Final-unit contention does not let a non-owner consume another session's reservation.");

    const concurrent = await Promise.all(Array.from({ length: 4 }, () => app.createCheckoutIntent({ id: concurrentSession, user: null }, request)));
    c.ok(concurrent.every(intent => String(intent.id) === String(concurrent[0].id) && intent.idempotency_key === concurrent[0].idempotency_key), "Concurrent first-time creation converges on one intent.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM checkout_intents WHERE session_id=?", concurrentSession)).count), 1, "Concurrent first-time creation persists one intent.");

    await app.db.transaction(async tx => {
      await tx.run("UPDATE cart_items SET quantity=1 WHERE session_id=? AND product_id=?", authenticatedSession, sharedProduct.id);
      await tx.run("UPDATE products SET reserved=reserved-1 WHERE id=?", sharedProduct.id);
    });
    const changed = await app.createCheckoutIntent({ id: authenticatedSession, user: { id: userId } }, request);
    c.ok(String(changed.id) !== String(first.id), "Cart mutation creates a new intent for the changed purchase.");
    c.ok(changed.idempotency_key !== first.idempotency_key, "Changed purchase receives a new server idempotency key.");
    c.equal(Number((await app.db.get("SELECT cart_snapshot->0->>'quantity' AS quantity FROM checkout_intents WHERE id=?", first.id)).quantity), 2, "Original intent snapshot remains unchanged after cart mutation.");
    c.equal(Number(changed.amount_minor), 21900, "Changed cart is independently repriced from server data.");
    return c.count + schemaAssertions;
  } finally {
    await app.db.transaction(async tx => {
      for (const session of sessions) {
        await tx.run("DELETE FROM checkout_intents WHERE session_id=?", session);
        await tx.run("DELETE FROM cart_items WHERE session_id=?", session);
        await tx.run("DELETE FROM sessions WHERE id=?", session);
      }
      for (const code of coupons) await tx.run("DELETE FROM coupons WHERE code=?", code);
      for (const productId of products) await tx.run("DELETE FROM products WHERE id=?", productId);
      if (userId) await tx.run("DELETE FROM users WHERE id=?", userId);
    });
  }
}

async function assertProviderOrderBehavior({ app, prefix }) {
  const c = checks();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const sessions = [];
  const products = [];
  const provider = "razorpay";
  const request = { postal_code: "560001", coupon_code: "" };
  let userId;

  const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id",
    "Provider Order Test", `${suffix}@example.test`, "unused-test-hash");
  userId = user.id;
  async function fixture(label) {
    const sessionId = crypto.randomBytes(24).toString("hex");
    const product = await app.db.get(`
      INSERT INTO products (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',125,1,4.8,'Provider order test fixture','Standard','Matte','Full color','navy',1,1) RETURNING id`,
    `${suffix}-${label}`, `Provider test ${label}`);
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)", sessionId, userId,
      crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    await app.db.run(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price)
      VALUES (?, ?, 1, 'Standard', 'Matte', 'Full color', 125)`, sessionId, product.id);
    sessions.push(sessionId);
    products.push(product.id);
    return { session: { id: sessionId, user: { id: userId } }, productId: product.id };
  }
  const validProviderResult = (id, amount, currency = "INR", receipt) => ({ id, amount, currency, ...(receipt === undefined ? {} : { receipt }) });
  async function expectProviderError(work, expectedCode, message) {
    let failure;
    try { await work(); } catch (error) { failure = error; }
    c.equal(failure?.code, expectedCode, message);
  }

  try {
    const schemaMigration = await app.db.get("SELECT name FROM schema_migrations WHERE name=?", "003-provider-order-lifecycle.sql");
    c.ok(schemaMigration, "Provider-order lifecycle migration is applied before provider-order operations.");

    const firstFixture = await fixture("first");
    const calls = [];
    const firstOrder = await app.createProviderOrder(firstFixture.session, request, async (...args) => {
      calls.push(args);
      return validProviderResult("test_order_first", args[0], args[1], args[2]);
    });
    c.equal(calls.length, 1, "First request creates exactly one provider order.");
    c.ok(Number.isSafeInteger(calls[0][0]) && calls[0][0] > 0, "Provider receives the durable expected amount in minor units.");
    c.equal(calls[0][1], "INR", "Provider receives the intent currency.");
    c.equal(calls[0][2], `po_${firstOrder.checkout_intent_id}`, "Provider receipt is stable and derived from the intent.");
    c.equal(firstOrder.status, "created", "Successful provider order is durably marked created.");
    c.equal(Number(firstOrder.expected_amount_minor), calls[0][0], "Mapping keeps the immutable expected amount.");
    c.equal(Number(firstOrder.provider_amount_minor), calls[0][0], "Mapping stores the exact amount returned by the provider.");
    c.equal(firstOrder.provider_currency, "INR", "Mapping stores the exact provider currency.");
    c.equal(firstOrder.provider_receipt, calls[0][2], "Mapping stores the provider receipt/reference.");

    const repeated = await app.createProviderOrder(firstFixture.session, request, async () => {
      calls.push(["unexpected-provider-call"]);
      return validProviderResult("must_not_replace", 1);
    });
    c.equal(repeated.id, firstOrder.id, "Repeated request reuses the persisted provider-order row.");
    c.equal(repeated.provider_order_id, firstOrder.provider_order_id, "Repeated request returns the original provider order ID.");
    c.equal(calls.length, 1, "Persisted provider order reuse makes no additional provider call.");

    const concurrentFixture = await fixture("concurrent");
    let enteredProvider;
    const entered = new Promise(resolve => { enteredProvider = resolve; });
    let releaseProvider;
    const gate = new Promise(resolve => { releaseProvider = resolve; });
    let concurrentCalls = 0;
    const creator = async (...args) => {
      concurrentCalls += 1;
      enteredProvider();
      await gate;
      return validProviderResult("test_order_concurrent", args[0], args[1], args[2]);
    };
    const firstConcurrent = app.createProviderOrder(concurrentFixture.session, request, creator);
    await entered;
    const secondConcurrent = app.createProviderOrder(concurrentFixture.session, request, creator);
    releaseProvider();
    const concurrentResults = await Promise.all([firstConcurrent, secondConcurrent]);
    c.equal(concurrentCalls, 1, "Concurrent duplicate requests make one provider call.");
    c.equal(concurrentResults[0].provider_order_id, concurrentResults[1].provider_order_id, "Concurrent callers converge on the same provider order.");
    c.equal(concurrentResults[0].id, concurrentResults[1].id, "Concurrent callers receive the same persisted mapping.");

    const amountFixture = await fixture("amount-mismatch");
    await expectProviderError(() => app.createProviderOrder(amountFixture.session, request, async (...args) =>
      validProviderResult("test_order_bad_amount", args[0] + 1, args[1], args[2])), "PROVIDER_ORDER_MISMATCH", "Mismatched provider amount is rejected.");
    const amountRow = await app.db.get("SELECT * FROM provider_orders WHERE checkout_intent_id=(SELECT id FROM checkout_intents WHERE session_id=?)", amountFixture.session.id);
    c.equal(amountRow.status, "rejected", "Amount mismatch is durably quarantined instead of returned as success.");
    c.equal(Number(amountRow.provider_amount_minor), Number(amountRow.expected_amount_minor) + 1, "Mismatched returned amount is retained for diagnosis.");
    c.ok(amountRow.provider_order_id, "Mismatched provider ID is retained and cannot be silently replaced.");
    await expectProviderError(() => app.createProviderOrder(amountFixture.session, request, async () => {
      throw new Error("must not call provider again");
    }), "PROVIDER_ORDER_REJECTED", "A quarantined mismatch cannot be retried into a replacement order.");

    const currencyFixture = await fixture("currency-mismatch");
    await expectProviderError(() => app.createProviderOrder(currencyFixture.session, request, async (...args) =>
      validProviderResult("test_order_bad_currency", args[0], "USD", args[2])), "PROVIDER_ORDER_MISMATCH", "Mismatched provider currency is rejected.");
    const currencyRow = await app.db.get("SELECT status,provider_currency,currency FROM provider_orders WHERE checkout_intent_id=(SELECT id FROM checkout_intents WHERE session_id=?)", currencyFixture.session.id);
    c.equal(currencyRow.status, "rejected", "Currency mismatch is durably quarantined.");
    c.equal(currencyRow.provider_currency, "USD", "Unexpected provider currency is retained for diagnosis.");
    c.equal(currencyRow.currency, "INR", "Expected currency remains immutable in the mapping.");

    const failureFixture = await fixture("provider-failure");
    const rejectedError = Object.assign(new Error("provider said no"), { code: "PROVIDER_ORDER_REJECTED" });
    await expectProviderError(() => app.createProviderOrder(failureFixture.session, request, async () => { throw rejectedError; }),
      "PROVIDER_ORDER_FAILED", "Definitive provider rejection is surfaced as a retryable failure.");
    const failedRow = await app.db.get("SELECT * FROM provider_orders WHERE checkout_intent_id=(SELECT id FROM checkout_intents WHERE session_id=?)", failureFixture.session.id);
    c.equal(failedRow.status, "failed", "Definitive provider failure does not leave a successful mapping.");
    c.equal(failedRow.provider_order_id, null, "Definitive provider failure has no provider order ID.");
    const retry = await app.createProviderOrder(failureFixture.session, request, async (...args) =>
      validProviderResult("test_order_retry", args[0], args[1], args[2]));
    c.equal(retry.status, "created", "A known rejection can be safely retried.");
    c.equal(Number(retry.attempt_count), 2, "Retry increments the durable provider attempt count.");

    const timeoutFixture = await fixture("provider-timeout");
    let timeoutCalls = 0;
    await expectProviderError(() => app.createProviderOrder(timeoutFixture.session, request, async () => {
      timeoutCalls += 1;
      throw Object.assign(new Error("network timeout"), { name: "AbortError" });
    }), "PROVIDER_ORDER_OUTCOME_UNKNOWN", "Timeout is treated as ambiguous rather than a safe-to-repeat failure.");
    await expectProviderError(() => app.createProviderOrder(timeoutFixture.session, request, async () => {
      timeoutCalls += 1;
      return validProviderResult("must_not_duplicate", 1);
    }), "PROVIDER_ORDER_OUTCOME_UNKNOWN", "Ambiguous provider outcome is not automatically retried.");
    const timeoutRow = await app.db.get("SELECT status,attempt_count FROM provider_orders WHERE checkout_intent_id=(SELECT id FROM checkout_intents WHERE session_id=?)", timeoutFixture.session.id);
    c.equal(timeoutCalls, 1, "Unknown provider outcome is never blindly retried.");
    c.equal(timeoutRow.status, "unknown", "Timeout leaves a durable unknown state for later reconciliation.");
    c.equal(Number(timeoutRow.attempt_count), 1, "Ambiguous outcome does not create another attempt.");

    const conflictFixture = await fixture("id-conflict");
    await expectProviderError(() => app.createProviderOrder(conflictFixture.session, request, async (...args) =>
      validProviderResult("test_order_first", args[0], args[1], args[2])), "PROVIDER_ORDER_ID_CONFLICT", "One provider order ID cannot be assigned to another intent.");
    const firstPersisted = await app.db.get("SELECT checkout_intent_id,status FROM provider_orders WHERE provider=? AND provider_order_id=?", provider, "test_order_first");
    const conflicting = await app.db.get("SELECT status,provider_order_id FROM provider_orders WHERE checkout_intent_id=(SELECT id FROM checkout_intents WHERE session_id=?)", conflictFixture.session.id);
    c.equal(Number(firstPersisted.checkout_intent_id), Number(firstOrder.checkout_intent_id), "Provider-ID collision does not move the original mapping.");
    c.equal(firstPersisted.status, "created", "Original provider mapping remains valid after a collision.");
    c.equal(conflicting.status, "unknown", "Conflicting intent is quarantined for investigation.");
    c.equal(conflicting.provider_order_id, null, "Conflicting ID is not stored as a false mapping.");

    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM orders WHERE order_number LIKE ?", `${suffix}%`)).count), 0,
      "Provider-order preparation does not create a local order or alter legacy COD order creation.");
    return c.count;
  } finally {
    await app.db.transaction(async tx => {
      const intentRows = sessions.length
        ? await tx.all(`SELECT id FROM checkout_intents WHERE session_id IN (${sessions.map(() => "?").join(",")})`, ...sessions)
        : [];
      if (intentRows.length) await tx.run(`DELETE FROM provider_orders WHERE checkout_intent_id IN (${intentRows.map(() => "?").join(",")})`, ...intentRows.map(row => row.id));
      for (const sessionId of sessions) {
        await tx.run("DELETE FROM checkout_intents WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM cart_items WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM sessions WHERE id=?", sessionId);
      }
      for (const productId of products) await tx.run("DELETE FROM products WHERE id=?", productId);
      if (userId) await tx.run("DELETE FROM users WHERE id=?", userId);
    });
  }
}

async function assertPaymentVerificationBehavior({ app, prefix }) {
  const c = checks();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const sessions = [];
  const products = [];
  const intents = [];
  const paymentIds = new Set();
  const request = { postal_code: "560001", coupon_code: "" };
  let userId;

  const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id",
    "Payment Verification Test", `${suffix}@example.test`, "unused-test-hash");
  userId = user.id;
  async function fixture(label, authenticated = true) {
    const sessionId = crypto.randomBytes(24).toString("hex");
    const ownerId = authenticated ? userId : null;
    const product = await app.db.get(`
      INSERT INTO products (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',150,1,4.8,'Payment verification fixture','Standard','Matte','Full color','navy',1,1) RETURNING id`,
    `${suffix}-${label}`, `Payment test ${label}`);
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)", sessionId, ownerId,
      crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    await app.db.run(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price)
      VALUES (?, ?, 1, 'Standard', 'Matte', 'Full color', 150)`, sessionId, product.id);
    sessions.push(sessionId);
    products.push(product.id);
    const session = { id: sessionId, user: authenticated ? { id: userId } : null };
    const intent = await app.createCheckoutIntent(session, request);
    intents.push(intent.id);
    const providerOrder = await app.createProviderOrder(session, request, async (amount, currency, receipt) => ({
      id: `test_pay_order_${label}`, amount, currency, receipt
    }));
    return { session, intent, providerOrder, amount: Number(intent.amount_minor) };
  }
  const paymentId = label => {
    const id = `pay_test_${label}_${crypto.randomBytes(5).toString("hex")}`;
    paymentIds.add(id);
    return id;
  };
  const signature = (orderId, id) => app.crypto.createHmac("sha256", app.RAZORPAY_KEY_SECRET).update(`${orderId}|${id}`).digest("hex");
  const providerPayment = (id, order, amount, overrides = {}) => ({
    id, order_id: order, amount, currency: "INR", status: "captured", captured: true, ...overrides
  });
  async function expectPaymentError(work, code, message) {
    let failure;
    try { await work(); } catch (error) { failure = error; }
    c.equal(failure?.code, code, message);
  }
  const verify = (fixtureValue, id, lookup, extra = {}) => app.verifyProviderPayment(fixtureValue.session, {
    razorpay_order_id: fixtureValue.providerOrder.provider_order_id,
    razorpay_payment_id: id,
    razorpay_signature: signature(fixtureValue.providerOrder.provider_order_id, id),
    ...extra
  }, lookup);
  const rowCount = async id => Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider='razorpay' AND provider_payment_id=?", id)).count);

  try {
    c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name=?", "003-provider-order-lifecycle.sql"), "Payment verification uses the migrated normalized payment schema.");

    const capturedFixture = await fixture("captured");
    const capturedId = paymentId("captured");
    let capturedLookups = 0;
    const capturedLookup = async id => {
      capturedLookups += 1;
      return providerPayment(id, capturedFixture.providerOrder.provider_order_id, capturedFixture.amount);
    };
    const captured = await verify(capturedFixture, capturedId, capturedLookup, { status: "failed", amount: "1", currency: "USD" });
    c.equal(captured.status, "captured", "Valid provider-confirmed capture is persisted despite misleading browser status/amount fields.");
    c.equal(Number(captured.checkout_intent_id), Number(capturedFixture.intent.id), "Payment is bound to the durable checkout intent.");
    c.equal(Number(captured.provider_order_record_id), Number(capturedFixture.providerOrder.id), "Payment references its normalized provider-order record.");
    c.equal(Number(captured.expected_amount_minor), capturedFixture.amount, "Expected amount comes from the checkout intent.");
    c.equal(Number(captured.verified_amount_minor), capturedFixture.amount, "Verified amount comes from the provider lookup.");
    c.equal(captured.currency, "INR", "Currency comes from the durable intent/provider verification.");
    c.ok(captured.captured_at, "Captured state records its capture timestamp.");

    const replay = await verify(capturedFixture, capturedId, capturedLookup);
    c.equal(replay.id, captured.id, "Repeated verification returns the same normalized payment.");
    c.equal(replay.status, "captured", "Repeated verification preserves captured state.");
    c.equal(await rowCount(capturedId), 1, "Repeated verification creates no duplicate payment record.");

    const concurrentFixture = await fixture("concurrent");
    const concurrentId = paymentId("concurrent");
    let enteredCount = 0;
    let allLookupsStarted;
    const bothEntered = new Promise(resolve => { allLookupsStarted = resolve; });
    let releaseLookups;
    const lookupGate = new Promise(resolve => { releaseLookups = resolve; });
    const concurrentLookup = async id => {
      enteredCount += 1;
      if (enteredCount === 2) allLookupsStarted();
      await lookupGate;
      return providerPayment(id, concurrentFixture.providerOrder.provider_order_id, concurrentFixture.amount);
    };
    const concurrentA = verify(concurrentFixture, concurrentId, concurrentLookup);
    const concurrentB = verify(concurrentFixture, concurrentId, concurrentLookup);
    await bothEntered;
    releaseLookups();
    const concurrentPayments = await Promise.all([concurrentA, concurrentB]);
    c.equal(concurrentPayments[0].id, concurrentPayments[1].id, "Concurrent verification converges on one payment row.");
    c.equal(await rowCount(concurrentId), 1, "Concurrent verification cannot duplicate a provider payment.");

    const badSignatureId = paymentId("bad-signature");
    let signatureLookupCalls = 0;
    await expectPaymentError(() => app.verifyProviderPayment(capturedFixture.session, {
      razorpay_order_id: capturedFixture.providerOrder.provider_order_id,
      razorpay_payment_id: badSignatureId,
      razorpay_signature: "0".repeat(64)
    }, async () => { signatureLookupCalls += 1; return {}; }), "PAYMENT_INVALID_SIGNATURE", "Invalid signature is rejected.");
    c.equal(signatureLookupCalls, 0, "Invalid signature is rejected before provider lookup.");
    c.equal(await rowCount(badSignatureId), 0, "Invalid signature creates no payment row.");

    const unknownId = paymentId("unknown");
    await expectPaymentError(() => verify(capturedFixture, unknownId, async () => {
      throw Object.assign(new Error("404"), { code: "PAYMENT_NOT_FOUND" });
    }), "PAYMENT_NOT_FOUND", "Unknown provider payment ID is rejected.");
    c.equal(await rowCount(unknownId), 0, "Unknown payment ID is not persisted.");

    const wrongOrderFixture = await fixture("wrong-order");
    const anotherOrderFixture = await fixture("other-order");
    const wrongOrderId = paymentId("wrong-order");
    await expectPaymentError(() => verify(wrongOrderFixture, wrongOrderId, async id =>
      providerPayment(id, anotherOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount)),
    "PAYMENT_PROVIDER_BINDING_MISMATCH", "Payment reported for another provider order is rejected.");
    c.equal(await rowCount(wrongOrderId), 0, "Wrong-order provider response creates no payment record.");

    const wrongIntentId = paymentId("wrong-intent");
    await expectPaymentError(() => verify(wrongOrderFixture, wrongIntentId, async id =>
      providerPayment(id, wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount),
    { checkout_intent_id: anotherOrderFixture.intent.id }), "PAYMENT_INTENT_MISMATCH", "A supplied different checkout intent is rejected.");

    const wrongAmountId = paymentId("wrong-amount");
    await expectPaymentError(() => verify(wrongOrderFixture, wrongAmountId, async id =>
      providerPayment(id, wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount + 1)),
    "PAYMENT_AMOUNT_MISMATCH", "Provider amount mismatch is rejected.");
    c.equal(await rowCount(wrongAmountId), 0, "Wrong amount is not persisted as a successful payment.");

    const wrongCurrencyId = paymentId("wrong-currency");
    await expectPaymentError(() => verify(wrongOrderFixture, wrongCurrencyId, async id =>
      providerPayment(id, wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount, { currency: "USD" })),
    "PAYMENT_CURRENCY_MISMATCH", "Provider currency mismatch is rejected.");
    c.equal(await rowCount(wrongCurrencyId), 0, "Wrong currency is not persisted as a successful payment.");

    const uncapturedId = paymentId("authorized");
    const authorized = await verify(wrongOrderFixture, uncapturedId, async id => providerPayment(id,
      wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount, { status: "authorized", captured: false }));
    c.equal(authorized.status, "authorized", "Provider-authorized but uncaptured payment stays authorized.");
    c.ok(authorized.status !== "captured", "Uncaptured payment cannot become captured.");

    const failedId = paymentId("failed");
    const failed = await verify(wrongOrderFixture, failedId, async id => providerPayment(id,
      wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount, { status: "failed", captured: false }));
    c.equal(failed.status, "failed", "Provider-confirmed failure is persisted as failed.");
    c.ok(failed.status !== "captured", "Failed payment cannot become captured without a new provider verification.");

    const downgradeId = paymentId("downgrade");
    const downgradeFixture = await fixture("downgrade");
    await verify(downgradeFixture, downgradeId, async id => providerPayment(id,
      downgradeFixture.providerOrder.provider_order_id, downgradeFixture.amount));
    await expectPaymentError(() => verify(downgradeFixture, downgradeId, async id => providerPayment(id,
      downgradeFixture.providerOrder.provider_order_id, downgradeFixture.amount, { status: "authorized", captured: false })),
    "PAYMENT_STATE_TRANSITION_REJECTED", "Captured payment cannot be downgraded to authorized.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE provider_payment_id=?", downgradeId)).status, "captured", "Rejected downgrade leaves captured state unchanged.");

    const refundedId = paymentId("refunded");
    const refundedFixture = await fixture("refunded");
    const initiallyCaptured = await verify(refundedFixture, refundedId, async id => providerPayment(id,
      refundedFixture.providerOrder.provider_order_id, refundedFixture.amount));
    await app.db.run("UPDATE payments SET status='refunded' WHERE id=?", initiallyCaptured.id);
    await expectPaymentError(() => verify(refundedFixture, refundedId, async id => providerPayment(id,
      refundedFixture.providerOrder.provider_order_id, refundedFixture.amount)),
    "PAYMENT_STATE_TRANSITION_REJECTED", "Refunded payment cannot transition back to captured.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", initiallyCaptured.id)).status, "refunded", "Rejected refund downgrade leaves refunded state unchanged.");

    const restoredCaptureId = paymentId("failed-then-captured");
    const restoredCaptureFixture = await fixture("failed-then-captured");
    const firstFailure = await verify(restoredCaptureFixture, restoredCaptureId, async id => providerPayment(id,
      restoredCaptureFixture.providerOrder.provider_order_id, restoredCaptureFixture.amount, { status: "failed", captured: false }));
    const confirmedCapture = await verify(restoredCaptureFixture, restoredCaptureId, async id => providerPayment(id,
      restoredCaptureFixture.providerOrder.provider_order_id, restoredCaptureFixture.amount));
    c.equal(firstFailure.status, "failed", "Initial failed state is persisted only after provider verification.");
    c.equal(confirmedCapture.status, "captured", "A fresh valid provider verification may confirm a previously failed payment as captured.");

    const duplicateId = paymentId("duplicate");
    const duplicateFirstFixture = await fixture("duplicate-first");
    const duplicateSecondFixture = await fixture("duplicate-second");
    const duplicateFirst = await verify(duplicateFirstFixture, duplicateId, async id => providerPayment(id,
      duplicateFirstFixture.providerOrder.provider_order_id, duplicateFirstFixture.amount));
    await expectPaymentError(() => verify(duplicateSecondFixture, duplicateId, async id => providerPayment(id,
      duplicateSecondFixture.providerOrder.provider_order_id, duplicateSecondFixture.amount)),
    "PAYMENT_ID_ALREADY_BOUND", "A provider payment ID cannot be associated with a second intent/order.");
    c.equal(await rowCount(duplicateId), 1, "Duplicate provider payment ID remains associated with only its original record.");
    c.equal(Number((await app.db.get("SELECT checkout_intent_id FROM payments WHERE id=?", duplicateFirst.id)).checkout_intent_id),
      Number(duplicateFirstFixture.intent.id), "Duplicate ID rejection does not alter the original intent association.");

    const unavailableId = paymentId("unavailable");
    await expectPaymentError(() => verify(wrongOrderFixture, unavailableId, async () => {
      throw Object.assign(new Error("timeout"), { code: "PAYMENT_LOOKUP_UNAVAILABLE" });
    }), "PAYMENT_LOOKUP_UNAVAILABLE", "Provider lookup timeout is retryable and does not fabricate payment state.");
    const lookupErrorId = paymentId("lookup-error");
    await expectPaymentError(() => verify(wrongOrderFixture, lookupErrorId, async () => {
      throw Object.assign(new Error("provider unavailable"), { code: "PAYMENT_LOOKUP_UNAVAILABLE" });
    }), "PAYMENT_LOOKUP_UNAVAILABLE", "Provider lookup error is retryable.");
    c.equal(await rowCount(unavailableId), 0, "Provider timeout creates no payment record.");
    c.equal(await rowCount(lookupErrorId), 0, "Provider error creates no payment record.");

    const inconsistentId = paymentId("inconsistent");
    await expectPaymentError(() => verify(wrongOrderFixture, inconsistentId, async id => ({
      ...providerPayment(id, wrongOrderFixture.providerOrder.provider_order_id, wrongOrderFixture.amount),
      id: "pay_different_id"
    })), "PAYMENT_PROVIDER_BINDING_MISMATCH", "Provider response with a different payment ID is rejected.");

    const anonymousFixture = await fixture("anonymous", false);
    const otherAnonymous = await fixture("anonymous-other", false);
    const anonymousPaymentId = paymentId("anonymous-owner");
    await expectPaymentError(() => app.verifyProviderPayment(otherAnonymous.session, {
      razorpay_order_id: anonymousFixture.providerOrder.provider_order_id,
      razorpay_payment_id: anonymousPaymentId,
      razorpay_signature: signature(anonymousFixture.providerOrder.provider_order_id, anonymousPaymentId)
    }, async id => providerPayment(id, anonymousFixture.providerOrder.provider_order_id, anonymousFixture.amount)),
    "PAYMENT_OWNERSHIP_MISMATCH", "Anonymous checkout cannot be verified from another session.");
    c.equal(await rowCount(anonymousPaymentId), 0, "Anonymous ownership mismatch creates no payment record.");

    const userMismatchId = paymentId("user-owner");
    const mismatchedUser = { id: anonymousFixture.session.id, user: { id: userId + 1 } };
    await expectPaymentError(() => app.verifyProviderPayment(mismatchedUser, {
      razorpay_order_id: anonymousFixture.providerOrder.provider_order_id,
      razorpay_payment_id: userMismatchId,
      razorpay_signature: signature(anonymousFixture.providerOrder.provider_order_id, userMismatchId)
    }, async id => providerPayment(id, anonymousFixture.providerOrder.provider_order_id, anonymousFixture.amount)),
    "PAYMENT_OWNERSHIP_MISMATCH", "Authenticated user mismatch is rejected even when a session identifier is supplied.");
    c.equal(await rowCount(userMismatchId), 0, "Authenticated ownership mismatch creates no payment record.");

    const cod = await app.db.get("SELECT checkout_intent_id,payment_record_id FROM orders WHERE payment_method='cod' ORDER BY id DESC LIMIT 1");
    c.ok(!cod || (cod.checkout_intent_id == null && cod.payment_record_id == null), "Legacy COD orders remain valid without normalized online payment records.");
    return c.count;
  } finally {
    await app.db.transaction(async tx => {
      if (paymentIds.size) await tx.run(`DELETE FROM payments WHERE provider_payment_id IN (${[...paymentIds].map(() => "?").join(",")})`, ...paymentIds);
      if (intents.length) await tx.run(`DELETE FROM provider_orders WHERE checkout_intent_id IN (${intents.map(() => "?").join(",")})`, ...intents);
      for (const sessionId of sessions) {
        await tx.run("DELETE FROM checkout_intents WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM cart_items WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM sessions WHERE id=?", sessionId);
      }
      for (const productId of products) await tx.run("DELETE FROM products WHERE id=?", productId);
      if (userId) await tx.run("DELETE FROM users WHERE id=?", userId);
    });
  }
}

async function runRegression({ app, get, post, postMultipart, csrf, prefix, admin, customer, product, deliveredOrder, register, login, addToCart, sessionId, createProduct, trackUpload }) {
  const c = checks();
  const checkoutIntentAssertions = await assertCheckoutIntentBehavior({ app, prefix });
  const providerOrderAssertions = await assertProviderOrderBehavior({ app, prefix });
  const paymentVerificationAssertions = await assertPaymentVerificationBehavior({ app, prefix });
  const webhookReconciliationAssertions = await assertWebhookReconciliationBehavior({ app, prefix });
  const orderFinalizationAssertions = await assertOrderFinalizationBehavior({ app, prefix });
  const refundRecoveryAssertions = await assertRefundRecoveryBehavior({ app, prefix });
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
  const authSecurityAssertions = await assertAuthSecurityBehavior({ app, get, post, csrf, prefix, admin, register, createProduct });
  const uploadAssertions = await assertUploadAccessBehavior({ app, get, postMultipart, csrf, prefix, admin, customer, register, createProduct, sessionId, trackUpload });
  return c.count + checkoutIntentAssertions + providerOrderAssertions + paymentVerificationAssertions + webhookReconciliationAssertions + orderFinalizationAssertions + refundRecoveryAssertions + authSecurityAssertions + uploadAssertions;
}

module.exports = { assertSequentialOversell, assertPaymentSchema, assertCheckoutIntentBehavior, assertProviderOrderBehavior, assertPaymentVerificationBehavior, assertWebhookReconciliationBehavior, assertOrderFinalizationBehavior, assertRefundRecoveryBehavior, runRegression };
