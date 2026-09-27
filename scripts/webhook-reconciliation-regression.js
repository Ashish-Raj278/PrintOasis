const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const webhookRoute = require("../routes/webhooks");

function counter() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); }
  };
}

async function assertWebhookReconciliationBehavior({ app, prefix }) {
  const c = counter();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const sessions = [], products = [], intents = [], events = new Set(), paymentIds = [];
  const secret = `webhook-test-${crypto.randomBytes(24).toString("hex")}`;
  const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id",
    "Webhook Regression", `${suffix}@example.test`, "unused-test-hash");

  async function fixture(label) {
    const sessionId = crypto.randomBytes(24).toString("hex");
    const product = await app.db.get(`INSERT INTO products
      (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
      VALUES (?,?,'business-cards',150,1,4.8,'Webhook test','Standard','Matte','Full color','navy',1,1) RETURNING id`,
    `${suffix}-${label}`, `Webhook ${label}`);
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)",
      sessionId, user.id, crypto.randomBytes(18).toString("hex"), Date.now() + 3600000);
    await app.db.run(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,unit_price)
      VALUES (?, ?, 1, 'Standard', 'Matte', 'Full color', 150)`, sessionId, product.id);
    sessions.push(sessionId); products.push(product.id);
    const session = { id: sessionId, user: { id: user.id } };
    const intent = await app.createCheckoutIntent(session, { postal_code: "560001", coupon_code: "" });
    intents.push(intent.id);
    const order = await app.createProviderOrder(session, { postal_code: "560001", coupon_code: "" },
      async (amount, currency, receipt) => ({ id: `test_webhook_${suffix}_${label}`, amount, currency, receipt }));
    return { session, intent, order, amount: Number(intent.amount_minor) };
  }

  const paymentId = label => {
    const value = `pay_webhook_${label}_${crypto.randomBytes(5).toString("hex")}`;
    paymentIds.push(value);
    return value;
  };
  const eventId = label => {
    const value = `${suffix}:evt:${label}:${crypto.randomUUID()}`;
    events.add(value);
    return value;
  };
  const payload = (type, f, id, overrides = {}) => Buffer.from(JSON.stringify({
    event: type,
    payload: { payment: { entity: {
      id, order_id: f.order.provider_order_id, amount: f.amount, currency: "INR",
      status: type === "payment.captured" ? "captured" : type === "payment.authorized" ? "authorized" : "failed",
      captured: type === "payment.captured", ...overrides
    } } }
  }));
  const sign = raw => app.crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const send = (eid, type, f, id, overrides) => {
    const raw = payload(type, f, id, overrides);
    return app.receiveRazorpayWebhook(raw, sign(raw), eid, { secret });
  };
  const payment = id => app.db.get("SELECT * FROM payments WHERE provider='razorpay' AND provider_payment_id=?", id);
  const eventCount = id => app.db.get("SELECT COUNT(*) AS count FROM payment_webhook_events WHERE provider='razorpay' AND provider_event_id=?", id);
  const providerPayment = (f, id, overrides = {}) => ({
    id, order_id: f.order.provider_order_id, amount: f.amount, currency: "INR", status: "captured", captured: true, ...overrides
  });
  const browserVerify = (f, id, lookup) => app.verifyProviderPayment(f.session, {
    razorpay_order_id: f.order.provider_order_id, razorpay_payment_id: id,
    razorpay_signature: app.crypto.createHmac("sha256", app.RAZORPAY_KEY_SECRET)
      .update(`${f.order.provider_order_id}|${id}`).digest("hex")
  }, lookup);

  try {
    const valid = await fixture("valid");
    const validId = paymentId("valid"), validEvent = eventId("valid");
    c.equal((await send(validEvent, "payment.captured", valid, validId)).status, "processed", "Valid signed capture is processed.");
    c.equal((await payment(validId)).status, "captured", "Capture is persisted as normalized payment state.");
    c.equal((await app.db.get("SELECT processing_status FROM payment_webhook_events WHERE provider_event_id=?", validEvent)).processing_status,
      "processed", "Inbox records processed timestamp/state.");

    const badSignatureId = eventId("bad-signature");
    const badSignatureBody = payload("payment.captured", valid, paymentId("bad-signature"));
    let signatureError;
    try { await app.receiveRazorpayWebhook(badSignatureBody, "0".repeat(64), badSignatureId, { secret }); }
    catch (error) { signatureError = error; }
    c.equal(signatureError?.code, "WEBHOOK_INVALID_SIGNATURE", "Invalid signature is rejected.");
    c.equal(await app.db.get("SELECT id FROM payment_webhook_events WHERE provider_event_id=?", badSignatureId), undefined,
      "Invalid signature is not persisted.");

    const malformedEvent = eventId("malformed"), malformedBody = Buffer.from("{");
    let malformedError;
    try { await app.receiveRazorpayWebhook(malformedBody, sign(malformedBody), malformedEvent, { secret }); }
    catch (error) { malformedError = error; }
    c.equal(malformedError?.code, "WEBHOOK_MALFORMED", "Malformed signed payload is rejected.");

    const duplicate = await send(validEvent, "payment.captured", valid, validId);
    c.ok(duplicate.duplicate, "Duplicate event delivery is acknowledged idempotently.");
    c.equal(Number((await eventCount(validEvent)).count), 1, "Duplicate event ID creates one inbox row.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider_payment_id=?", validId)).count), 1,
      "Duplicate delivery creates no duplicate payment.");

    const concurrent = await fixture("concurrent"), concurrentId = paymentId("concurrent"), concurrentEvent = eventId("concurrent");
    const concurrentResults = await Promise.all([
      send(concurrentEvent, "payment.captured", concurrent, concurrentId),
      send(concurrentEvent, "payment.captured", concurrent, concurrentId)
    ]);
    c.equal(concurrentResults.every(result => result.status === "processed"), true, "Concurrent duplicate deliveries are both acknowledged.");
    c.equal(Number((await eventCount(concurrentEvent)).count), 1, "Concurrent duplicate event is inserted once.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider_payment_id=?", concurrentId)).count), 1,
      "Concurrent duplicate processing creates one payment row.");

    const webhookFirst = await fixture("webhook-first"), webhookFirstId = paymentId("webhook-first");
    await send(eventId("webhook-first"), "payment.captured", webhookFirst, webhookFirstId);
    c.equal((await browserVerify(webhookFirst, webhookFirstId, async id => providerPayment(webhookFirst, id))).status, "captured",
      "Webhook-first then browser verification converges on captured state.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider_payment_id=?", webhookFirstId)).count), 1,
      "Webhook-first convergence creates one payment.");

    const browserFirst = await fixture("browser-first"), browserFirstId = paymentId("browser-first");
    await browserVerify(browserFirst, browserFirstId, async id => providerPayment(browserFirst, id));
    c.equal((await send(eventId("browser-first"), "payment.captured", browserFirst, browserFirstId)).status, "processed",
      "Browser-first then webhook converges successfully.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider_payment_id=?", browserFirstId)).count), 1,
      "Browser-first convergence creates one payment.");

    const race = await fixture("race"), raceId = paymentId("race"), raceEvent = eventId("race");
    const [browserRace, webhookRace] = await Promise.all([
      browserVerify(race, raceId, async id => providerPayment(race, id)),
      send(raceEvent, "payment.captured", race, raceId)
    ]);
    c.equal(browserRace.status, "captured", "Concurrent browser verification confirms capture.");
    c.equal(webhookRace.status, "processed", "Concurrent webhook processing completes.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM payments WHERE provider_payment_id=?", raceId)).count), 1,
      "Concurrent browser/webhook race converges on one row.");

    const transitions = await fixture("transitions"), transitionId = paymentId("transitions");
    await send(eventId("authorized"), "payment.authorized", transitions, transitionId);
    c.equal((await payment(transitionId)).status, "authorized", "Authorized event records authorized state.");
    await send(eventId("captured-after-authorized"), "payment.captured", transitions, transitionId);
    c.equal((await payment(transitionId)).status, "captured", "Authorized transitions to captured.");
    c.equal((await send(eventId("stale-authorized"), "payment.authorized", transitions, transitionId)).status, "failed",
      "Stale authorization after capture is rejected.");
    c.equal((await send(eventId("stale-failed"), "payment.failed", transitions, transitionId)).status, "failed",
      "Failure after capture is rejected.");
    c.equal((await payment(transitionId)).status, "captured", "Out-of-order events do not downgrade captured state.");

    const recovery = await fixture("failed-recovery"), recoveryId = paymentId("failed-recovery");
    await send(eventId("failed-first"), "payment.failed", recovery, recoveryId);
    c.equal((await payment(recoveryId)).status, "failed", "Provider failure is persisted as failed.");
    await send(eventId("capture-after-failure"), "payment.captured", recovery, recoveryId);
    c.equal((await payment(recoveryId)).status, "captured", "Later valid capture advances prior failed state.");

    const unknownOrder = await fixture("unknown-order"), unknownOrderPayment = paymentId("unknown-order");
    const unknownOrderEvent = eventId("unknown-order"), unknownOrderBody = payload("payment.captured", unknownOrder,
      unknownOrderPayment, { order_id: `${unknownOrder.order.provider_order_id}-unknown` });
    c.equal((await app.receiveRazorpayWebhook(unknownOrderBody, sign(unknownOrderBody), unknownOrderEvent, { secret })).status, "failed",
      "Unknown provider order is stored but not applied.");
    c.equal(await payment(unknownOrderPayment), undefined, "Unknown order creates no payment.");

    const firstOwner = await fixture("payment-id-owner"), sharedId = paymentId("shared");
    await send(eventId("payment-id-owner"), "payment.captured", firstOwner, sharedId);
    const secondOwner = await fixture("payment-id-other"), secondEvent = eventId("payment-id-other");
    c.equal((await send(secondEvent, "payment.captured", secondOwner, sharedId)).status, "failed",
      "Payment ID bound to another checkout is rejected.");
    c.equal(Number((await payment(sharedId)).checkout_intent_id), Number(firstOwner.intent.id), "Rejected event cannot rebind payment identity.");

    const amountMismatch = await fixture("amount-mismatch"), amountId = paymentId("amount-mismatch");
    c.equal((await send(eventId("amount-mismatch"), "payment.captured", amountMismatch, amountId,
      { amount: amountMismatch.amount + 1 })).status, "failed", "Wrong amount event is rejected.");
    const currencyId = paymentId("currency-mismatch");
    c.equal((await send(eventId("currency-mismatch"), "payment.captured", amountMismatch, currencyId,
      { currency: "USD" })).status, "failed", "Wrong currency event is rejected.");
    c.equal(await payment(amountId), undefined, "Amount mismatch creates no payment row.");
    c.equal(await payment(currencyId), undefined, "Currency mismatch creates no payment row.");

    const eventMismatch = await fixture("event-status-mismatch"), eventMismatchId = paymentId("event-status-mismatch");
    c.equal((await send(eventId("event-status-mismatch"), "payment.captured", eventMismatch, eventMismatchId,
      { status: "authorized", captured: false })).status, "failed", "Event type inconsistent with payment status is rejected.");
    c.equal(await payment(eventMismatchId), undefined, "Status-mismatched event creates no payment.");

    const refundEvent = eventId("refund-recognized");
    const refundBody = Buffer.from(JSON.stringify({ event: "refund.processed", payload: { refund: { entity: {
      id: "rf_test_recognized", payment_id: validId, order_id: valid.order.provider_order_id,
      amount: valid.amount, currency: "INR", status: "processed"
    } } } }));
    c.equal((await app.receiveRazorpayWebhook(refundBody, sign(refundBody), refundEvent, { secret })).status, "ignored",
      "Refund event is recognized/stored without orchestration.");
    c.equal((await app.db.get("SELECT event_type FROM payment_webhook_events WHERE provider_event_id=?", refundEvent)).event_type,
      "refund.processed", "Refund event type remains diagnosable in inbox.");

    const recon = await fixture("reconciliation"), reconId = paymentId("reconciliation");
    await send(eventId("reconciliation-authorized"), "payment.authorized", recon, reconId);
    const successLookup = async id => providerPayment(recon, id);
    const reconciliation = await app.reconcileProviderPayments({ providerLookup: successLookup, checkoutIntentIds: [recon.intent.id] });
    c.equal(reconciliation.checked, 1, "Reconciliation queries the scoped persisted payment once.");
    c.equal((await payment(reconId)).status, "captured", "Reconciliation advances confirmed authorization to capture.");
    const replay = await app.reconcileProviderPayments({ providerLookup: successLookup, checkoutIntentIds: [recon.intent.id] });
    c.equal(replay.checked, 0, "Repeated reconciliation skips the now-terminal captured payment.");
    c.equal((await payment(reconId)).status, "captured", "Repeated reconciliation leaves the captured state unchanged.");

    const undiscovered = await fixture("order-payment-discovery"), discoveredId = paymentId("order-payment-discovery");
    const discovered = await app.reconcileProviderPayments({ checkoutIntentIds: [undiscovered.intent.id],
      providerLookup: async () => { throw new Error("No payment ID is known before order lookup."); },
      providerOrderPaymentsLookup: async orderId => [providerPayment(undiscovered, discoveredId)] });
    c.equal(discovered.orders_checked, 1, "Reconciliation queries a persisted provider order with no local payment row.");
    c.equal((await payment(discoveredId)).status, "captured", "Provider-order payment discovery persists independently verified state.");
    const discoveredReplay = await app.reconcileProviderPayments({ checkoutIntentIds: [undiscovered.intent.id],
      providerOrderPaymentsLookup: async () => { throw new Error("Completed order should not be queried again."); } });
    c.equal(discoveredReplay.orders_checked, 0, "Repeated order reconciliation skips an order after its payment is persisted.");

    const undiscoveredFailure = await fixture("order-lookup-failure");
    const failedOrderLookup = await app.reconcileProviderPayments({ checkoutIntentIds: [undiscoveredFailure.intent.id],
      providerOrderPaymentsLookup: async () => { throw Object.assign(new Error("fake provider timeout"), { code: "PAYMENT_LOOKUP_UNAVAILABLE" }); } });
    c.equal(failedOrderLookup.failed, 1, "Provider-order lookup timeout is reported without state fabrication.");

    const lookupFailure = await fixture("lookup-failure"), lookupFailureId = paymentId("lookup-failure");
    await send(eventId("lookup-failure-authorized"), "payment.authorized", lookupFailure, lookupFailureId);
    const priorState = (await payment(lookupFailureId)).status;
    const unavailable = await app.reconcileProviderPayments({ checkoutIntentIds: [lookupFailure.intent.id],
      providerLookup: async () => { throw Object.assign(new Error("fake timeout"), { code: "PAYMENT_LOOKUP_UNAVAILABLE" }); } });
    c.equal(unavailable.failed, 1, "Provider timeout is reported as unresolved reconciliation.");
    c.equal((await payment(lookupFailureId)).status, priorState, "Provider timeout does not fabricate or change payment state.");
    const providerError = await app.reconcileProviderPayments({ checkoutIntentIds: [lookupFailure.intent.id],
      providerLookup: async () => { throw new Error("fake lookup error"); } });
    c.equal(providerError.failed, 1, "Provider lookup error remains retryable and reported.");

    for (const [label, mismatch] of [
      ["payment-id", payment => ({ ...payment, id: "pay_unrelated" })],
      ["provider-order", payment => ({ ...payment, order_id: "order_unrelated" })],
      ["amount", payment => ({ ...payment, amount: payment.amount + 1 })],
      ["currency", payment => ({ ...payment, currency: "USD" })]
    ]) {
      const mismatchFixture = await fixture(`reconcile-${label}`);
      const mismatchId = paymentId(`reconcile-${label}`);
      await send(eventId(`reconcile-${label}-authorized`), "payment.authorized", mismatchFixture, mismatchId);
      const unchangedState = (await payment(mismatchId)).status;
      const mismatchResult = await app.reconcileProviderPayments({ checkoutIntentIds: [mismatchFixture.intent.id],
        providerLookup: async id => mismatch(providerPayment(mismatchFixture, id)) });
      c.equal(mismatchResult.failed, 1, `Reconciliation rejects mismatched provider ${label}.`);
      c.equal((await payment(mismatchId)).status, unchangedState, `Reconciliation preserves state after ${label} mismatch.`);
    }

    const capturedReconcileFixture = await fixture("reconcile-captured-terminal");
    const capturedReconcileId = paymentId("reconcile-captured-terminal");
    await send(eventId("reconcile-captured-terminal-event"), "payment.captured", capturedReconcileFixture, capturedReconcileId);
    const capturedReconcile = await app.reconcileProviderPayments({ checkoutIntentIds: [capturedReconcileFixture.intent.id],
      providerLookup: async id => providerPayment(capturedReconcileFixture, id, { status: "failed", captured: false }) });
    c.equal(capturedReconcile.checked, 0, "Reconciliation does not query or downgrade captured terminal state.");
    c.equal((await payment(capturedReconcileId)).status, "captured", "Captured state remains authoritative during reconciliation.");

    await app.db.run("UPDATE payments SET status='refunded' WHERE provider_payment_id=?", validId);
    const noDowngrade = await app.reconcileProviderPayments({ checkoutIntentIds: [valid.intent.id],
      providerLookup: async id => providerPayment(valid, id) });
    c.equal(noDowngrade.checked, 0, "Captured/refunded terminal state is excluded from reconciliation downgrade candidates.");
    c.equal((await payment(validId)).status, "refunded", "Reconciliation preserves refunded payment state.");

    const inboxRetry = await fixture("inbox-retry"), inboxRetryId = paymentId("inbox-retry"), inboxRetryEvent = eventId("inbox-retry");
    await app.db.run(`INSERT INTO payment_webhook_events
      (provider,provider_event_id,event_type,provider_order_id,provider_payment_id,safe_metadata,processing_status)
      VALUES ('razorpay',?,?,?,?,?::jsonb,'received')`, inboxRetryEvent, "payment.captured", inboxRetry.order.provider_order_id,
    inboxRetryId, JSON.stringify({ payment_id: inboxRetryId, order_id: inboxRetry.order.provider_order_id,
      amount_minor: inboxRetry.amount, currency: "INR", status: "captured", captured: true }));
    const retriedInbox = await app.reconcileProviderPayments({ checkoutIntentIds: [inboxRetry.intent.id],
      providerLookup: async () => { throw new Error("Inbox retry does not need a provider lookup."); } });
    c.equal(retriedInbox.webhook_events, 1, "Reconciliation drains a durable received webhook event.");
    c.equal((await payment(inboxRetryId)).status, "captured", "Inbox retry applies the event transactionally.");

    const cod = await app.db.get("SELECT checkout_intent_id,payment_record_id FROM orders WHERE payment_method='cod' ORDER BY id DESC LIMIT 1");
    c.ok(!cod || (cod.checkout_intent_id == null && cod.payment_record_id == null), "Legacy COD order remains compatible.");

    // Exercise the actual raw-body route adapter without browser/session authentication.
    const { Readable } = require("node:stream");
    const rawBody = payload("payment.captured", valid, paymentId("route-adapter"));
    const response = { statusCode: 0, body: null };
    const routeApp = {
      receiveRazorpayWebhook: async (body, signature, id) => {
        c.equal(Buffer.compare(body, rawBody), 0, "Webhook route passes the exact raw bytes to signature verification.");
        c.equal(signature, "test-signature", "Webhook route forwards provider signature header.");
        c.equal(id, "evt-route-adapter", "Webhook route forwards event ID header.");
        return { duplicate: false, status: "processed" };
      },
      sendJson: (res, status, body) => { res.statusCode = status; res.body = body; }
    };
    await webhookRoute({
      req: Object.assign(Readable.from([rawBody]), { method: "POST", headers: {
        "content-type": "application/json", "x-razorpay-signature": "test-signature", "x-razorpay-event-id": "evt-route-adapter"
      } }),
      res: response,
      url: new URL("http://localhost/webhooks/razorpay"),
      app: routeApp
    });
    c.equal(response.statusCode, 200, "Dedicated webhook route acknowledges a valid processor result.");
    return c.count;
  } finally {
    await app.db.transaction(async tx => {
      if (intents.length) await tx.run(`DELETE FROM payments WHERE checkout_intent_id IN (${intents.map(() => "?").join(",")})`, ...intents);
      if (events.size) await tx.run(`DELETE FROM payment_webhook_events WHERE provider='razorpay' AND provider_event_id IN (${[...events].map(() => "?").join(",")})`, ...events);
      if (intents.length) await tx.run(`DELETE FROM provider_orders WHERE checkout_intent_id IN (${intents.map(() => "?").join(",")})`, ...intents);
      for (const sessionId of sessions) {
        await tx.run("DELETE FROM checkout_intents WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM cart_items WHERE session_id=?", sessionId);
        await tx.run("DELETE FROM sessions WHERE id=?", sessionId);
      }
      for (const productId of products) await tx.run("DELETE FROM products WHERE id=?", productId);
      await tx.run("DELETE FROM users WHERE id=?", user.id);
    });
  }
}

module.exports = { assertWebhookReconciliationBehavior };
