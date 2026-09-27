const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function counter() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); },
    deepEqual(actual, expected, message) { count += 1; assert.deepEqual(actual, expected, message); }
  };
}

async function assertRefundRecoveryBehavior({ app, prefix }) {
  const c = counter();
  const suffix = `${prefix}-${crypto.randomUUID()}`;
  const user = await app.db.get("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id",
    "Refund Recovery Regression", `${suffix}@example.test`, "unused-test-hash");
  const fixtures = [], productIds = [], intentIds = [], providerOrderIds = [], paymentIds = [], orderIds = [], refundIds = [];
  let serial = 0;

  async function fixture({ amount = 5000, status = "captured", orderStatus = "Pending", method = "razorpay", withOrder = true } = {}) {
    const label = ++serial;
    const intent = await app.db.get(`INSERT INTO checkout_intents
      (idempotency_key,session_id,user_id,cart_snapshot,amount_minor,currency,shipping_input,status,expires_at)
      VALUES (?, ?, ?, '[]'::jsonb, ?, 'INR', '{}'::jsonb, 'completed', CURRENT_TIMESTAMP + INTERVAL '1 hour') RETURNING id`,
    `${suffix}-intent-${label}`, `${suffix}-session-${label}`, user.id, amount);
    intentIds.push(intent.id);
    const providerOrder = await app.db.get(`INSERT INTO provider_orders
      (checkout_intent_id,provider,provider_order_id,expected_amount_minor,currency,status,provider_amount_minor,provider_currency)
      VALUES (?,'razorpay',?,?, 'INR','created',?,'INR') RETURNING id`, intent.id, `${suffix}-po-${label}`, amount, amount);
    providerOrderIds.push(providerOrder.id);
    const providerPaymentId = `pay_${suffix.replace(/[^A-Za-z0-9]/g, "")}_${label}`;
    paymentIds.push(providerPaymentId);
    const payment = await app.db.get(`INSERT INTO payments
      (checkout_intent_id,provider_order_record_id,provider,provider_payment_id,expected_amount_minor,verified_amount_minor,currency,status,captured_at)
      VALUES (? ,?,'razorpay',?,?,?,'INR',?,CURRENT_TIMESTAMP) RETURNING id`,
    intent.id, providerOrder.id, providerPaymentId, amount, amount, status);
    let order = null, product = null;
    if (withOrder) {
      product = await app.db.get(`INSERT INTO products
        (slug,name,category,price,min_qty,rating,description,sizes,materials,print_options,color,stock,reserved)
        VALUES (?,?,'business-cards',50,1,5,'Refund regression fixture','Standard','Matte','Full color','navy',0,0) RETURNING id,name`,
      `${suffix}-product-${label}`, `Refund fixture ${label}`);
      productIds.push(product.id);
      order = await app.db.get(`INSERT INTO orders
        (order_number,user_id,total,status,customer_name,phone,address,city,postal_code,payment_method,payment_id,checkout_intent_id,payment_record_id)
        VALUES (?,?,? ,?,'Refund customer','9876500000','1 Test Lane','Bengaluru','560001',?,?,?,?) RETURNING id`,
      `PO-REF-${suffix}-${label}`, user.id, amount / 100, orderStatus, method, providerPaymentId, intent.id, payment.id);
      orderIds.push(order.id);
      await app.db.run("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,configuration) VALUES (?,?,?,1,50,'Standard · Matte · Full color')",
        order.id, product.id, product.name);
    }
    const result = { intent, providerOrder, payment: { id: payment.id, provider_payment_id: providerPaymentId }, order, product };
    fixtures.push(result);
    return result;
  }

  const providerSuccess = async (paymentId, amount, currency, key, extra = {}) => ({
    id: `rfnd_${crypto.randomUUID().replace(/-/g, "")}`, payment_id: paymentId, amount, currency,
    status: "processed", notes: { printoasis_refund_key: key }, ...extra
  });
  const request = (f, amount, operationKey, providerCreate = providerSuccess, orderId = f.order?.id ?? null) => app.requestPaymentRefund({
    paymentRecordId: f.payment.id, orderId, amountMinor: amount, reason: "isolated regression", operationKey, providerCreate
  });
  async function expectCode(work, code, message) {
    let error;
    try { await work(); } catch (caught) { error = caught; }
    c.equal(error?.code, code, message);
  }

  try {
    const refundColumns = new Set((await app.db.all("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='refunds'")).map(row => row.column_name));
    c.ok(["checkout_intent_id", "attempt_count", "provider_status", "last_error"].every(name => refundColumns.has(name)), "Refund schema includes durable recovery metadata.");
    const orderColumns = new Set((await app.db.all("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='orders'")).map(row => row.column_name));
    c.ok(orderColumns.has("cancellation_status") && orderColumns.has("inventory_restocked"), "Order schema tracks cancellation and one-time inventory restoration.");
    const intentColumns = new Set((await app.db.all("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='checkout_intents'")).map(row => row.column_name));
    c.ok(intentColumns.has("recovery_status") && intentColumns.has("recovery_error"), "Checkout intents track captured-payment recovery state.");

    const full = await fixture();
    await expectCode(() => app.db.run(`INSERT INTO refunds
      (order_id,checkout_intent_id,payment_record_id,provider,idempotency_key,amount_minor,currency,status)
      VALUES (?,?,?,'razorpay',?,1,'INR','invalid')`, full.order.id, full.intent.id, full.payment.id, `${suffix}-invalid-state`),
    "23514", "Database refund state constraint rejects unsupported values.");
    let providerCalls = 0;
    const fullRefund = await request(full, 5000, `full:${full.order.id}`, async (...args) => {
      providerCalls += 1;
      const saved = await app.db.get("SELECT status FROM refunds WHERE idempotency_key=?", `po_refund_${crypto.createHash("sha256").update(`full:${full.order.id}`).digest("hex")}`);
      c.equal(saved.status, "pending", "Refund claim is durable before the provider call begins.");
      return providerSuccess(...args);
    });
    refundIds.push(fullRefund.id);
    c.equal(fullRefund.status, "succeeded", "Full provider-confirmed refund is persisted as succeeded.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", full.payment.id)).status, "refunded", "Full cumulative refund moves payment to refunded.");
    const replay = await request(full, 5000, `full:${full.order.id}`, async (...args) => { providerCalls += 1; return providerSuccess(...args); });
    c.equal(Number(replay.id), Number(fullRefund.id), "Repeated refund request reuses its durable record.");
    c.equal(providerCalls, 1, "Repeated refund never calls the provider twice.");

    const partial = await fixture();
    const partialOne = await request(partial, 2000, `partial-one:${partial.order.id}`);
    refundIds.push(partialOne.id);
    c.equal(partialOne.status, "succeeded", "First partial refund succeeds.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", partial.payment.id)).status, "partially_refunded", "Partial refund updates normalized payment state.");
    const partialTwo = await request(partial, 3000, `partial-two:${partial.order.id}`);
    refundIds.push(partialTwo.id);
    c.equal(partialTwo.status, "succeeded", "Second partial refund completes the captured amount.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", partial.payment.id)).status, "refunded", "Cumulative partial refunds transition to refunded.");
    const excess = await fixture();
    await expectCode(() => request(excess, 5001, "excess-refund"), "REFUND_AMOUNT_EXCEEDS_CAPTURE", "A refund cannot exceed captured amount.");

    const duplicate = await fixture();
    let startProvider;
    const waiting = new Promise(resolve => { startProvider = resolve; });
    let releaseProvider;
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    let concurrentProviderCalls = 0;
    const delayedProvider = async (...args) => { concurrentProviderCalls += 1; startProvider(); await providerGate; return providerSuccess(...args); };
    const firstConcurrent = request(duplicate, 1800, `concurrent-duplicate:${duplicate.order.id}`, delayedProvider);
    await waiting;
    const secondConcurrent = await request(duplicate, 1800, `concurrent-duplicate:${duplicate.order.id}`, delayedProvider);
    releaseProvider();
    const firstConcurrentResult = await firstConcurrent;
    refundIds.push(firstConcurrentResult.id);
    c.equal(Number(secondConcurrent.id), Number(firstConcurrentResult.id), "Concurrent duplicate refund requests converge on one row.");
    c.equal(concurrentProviderCalls, 1, "Concurrent duplicate requests make one provider call.");

    const contention = await fixture();
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const holdPending = async (...args) => { firstStarted(); await firstGate; return { ...(await providerSuccess(...args)), status: "pending" }; };
    const held = request(contention, 3000, `separate-a:${contention.order.id}`, holdPending);
    await started;
    await expectCode(() => request(contention, 2500, `separate-b:${contention.order.id}`), "REFUND_AMOUNT_EXCEEDS_CAPTURE", "Concurrent separate refunds cannot reserve more than the captured amount.");
    releaseFirst();
    const heldRefund = await held;
    refundIds.push(heldRefund.id);
    c.equal(heldRefund.status, "pending", "Provider-pending refund remains reserved against the capture.");

    const rejected = await fixture();
    const rejection = await request(rejected, 5000, `rejected:${rejected.order.id}`, async () => {
      const error = Object.assign(new Error("definitive isolated rejection"), { code: "REFUND_PROVIDER_REJECTED", definitive: true }); throw error;
    });
    refundIds.push(rejection.id);
    c.equal(rejection.status, "failed", "Definite provider rejection is recorded as failed.");
    const failedReplay = await request(rejected, 5000, `rejected:${rejected.order.id}`, async () => { throw new Error("must not retry"); });
    c.equal(failedReplay.status, "failed", "Repeated failed operation is not blindly resubmitted.");

    const timeout = await fixture();
    const timedOut = await request(timeout, 1000, `timeout:${timeout.order.id}`, async () => { throw new Error("network timeout after send"); });
    refundIds.push(timedOut.id);
    c.equal(timedOut.status, "unknown", "Provider timeout is stored as an ambiguous outcome.");
    c.equal((await request(timeout, 1000, `timeout:${timeout.order.id}`, async () => { throw new Error("must not resend"); })).id,
    timedOut.id, "Ambiguous operation reuses the same record without resubmission.");

    const dbFailure = await fixture();
    const originalTransaction = app.db.transaction.bind(app.db);
    let transactionCalls = 0, postProviderFailureCalls = 0;
    app.db.transaction = work => {
      transactionCalls += 1;
      if (transactionCalls === 3) throw new Error("isolated refund-persist failure");
      return originalTransaction(work);
    };
    try {
      await expectCode(() => request(dbFailure, 1200, `persist-failure:${dbFailure.order.id}`, async (...args) => {
        postProviderFailureCalls += 1;
        return providerSuccess(...args);
      }), undefined, "Provider success with a local persistence failure remains recoverable.");
    } finally { app.db.transaction = originalTransaction; }
    const lostResponseRefund = await app.db.get("SELECT * FROM refunds WHERE order_id=?", dbFailure.order.id);
    refundIds.push(lostResponseRefund.id);
    c.equal(lostResponseRefund.status, "pending", "Failed local persistence leaves a durable in-progress claim.");
    await request(dbFailure, 1200, `persist-failure:${dbFailure.order.id}`, async () => { postProviderFailureCalls += 1; throw new Error("must reconcile, not resend"); });
    c.equal(postProviderFailureCalls, 1, "Retry after a provider-success/local-DB failure does not repeat the external refund.");
    const recoveredPersist = await app.reconcileRefund(lostResponseRefund.id, { lookup: async () => null, list: async paymentId => [{
      id: "rfnd_persist_recovered", payment_id: paymentId, amount: 1200, currency: "INR", status: "processed",
      notes: { printoasis_refund_key: lostResponseRefund.idempotency_key }
    }] });
    c.equal(recoveredPersist.status, "succeeded", "Reconciliation recovers a provider success not persisted by the original request.");

    const malformed = await fixture();
    const missingId = await request(malformed, 1000, `wrong-id:${malformed.order.id}`, async (paymentId, amount, currency, key) => ({ payment_id: paymentId, amount, currency, status: "processed", notes: { printoasis_refund_key: key } }));
    refundIds.push(missingId.id);
    c.equal(missingId.status, "unknown", "Missing/invalid provider refund identity is quarantined.");
    const wrongAmount = await fixture();
    const wrongAmountRefund = await request(wrongAmount, 1000, `wrong-amount:${wrongAmount.order.id}`, async (paymentId, amount, currency, key) => providerSuccess(paymentId, amount + 1, currency, key));
    refundIds.push(wrongAmountRefund.id);
    c.equal(wrongAmountRefund.status, "unknown", "Provider amount mismatch is not treated as a success.");
    const wrongCurrency = await fixture();
    const wrongCurrencyRefund = await request(wrongCurrency, 1000, `wrong-currency:${wrongCurrency.order.id}`, async (paymentId, amount, currency, key) => providerSuccess(paymentId, amount, "USD", key));
    refundIds.push(wrongCurrencyRefund.id);
    c.equal(wrongCurrencyRefund.status, "unknown", "Provider currency mismatch is not treated as a success.");
    const wrongPayment = await fixture();
    const wrongPaymentRefund = await request(wrongPayment, 1000, `wrong-payment:${wrongPayment.order.id}`, async (_paymentId, amount, currency, key) => providerSuccess("pay_wrong_payment", amount, currency, key));
    refundIds.push(wrongPaymentRefund.id);
    c.equal(wrongPaymentRefund.status, "unknown", "Provider refund bound to another payment is quarantined.");

    const recoverFailed = await fixture();
    const definiteFailed = await request(recoverFailed, 1000, `failed-reconcile:${recoverFailed.order.id}`, async () => { throw Object.assign(new Error("rejected"), { definitive: true }); });
    refundIds.push(definiteFailed.id);
    const reconciledFailed = await app.reconcileRefund(definiteFailed.id, { lookup: async () => null, list: async paymentId => [{
      id: "rfnd_authoritative_success", payment_id: paymentId, amount: 1000, currency: "INR", status: "processed",
      notes: { printoasis_refund_key: definiteFailed.idempotency_key }
    }] });
    c.equal(reconciledFailed.status, "succeeded", "Fresh authoritative reconciliation can confirm a previously failed attempt.");

    const replayState = await fixture();
    const replayed = await request(replayState, 1000, `replay-state:${replayState.order.id}`);
    refundIds.push(replayed.id);
    const stale = await app.reconcileRefund(replayed.id, { lookup: async () => ({ id: replayed.provider_refund_id,
      payment_id: replayState.payment.provider_payment_id, amount: 1000, currency: "INR", status: "pending" }) });
    c.equal(stale.status, "succeeded", "Stale provider pending state cannot downgrade a successful refund.");

    const mismatchOrder = await fixture();
    const another = await fixture();
    await expectCode(() => request(mismatchOrder, 1000, `wrong-order:${mismatchOrder.order.id}`, providerSuccess, another.order.id),
      "REFUND_ORDER_PAYMENT_MISMATCH", "Refund cannot be associated with another order.");

    const cancelPaid = await fixture();
    const cancelled = await app.cancelOrder(cancelPaid.order.id, { providerCreate: providerSuccess });
    c.equal(cancelled.status, "completed", "Captured paid order is cancelled only after full refund succeeds.");
    c.equal((await app.db.get("SELECT status FROM orders WHERE id=?", cancelPaid.order.id)).status, "Cancelled", "Paid cancellation updates order after refund.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", cancelPaid.payment.id)).status, "refunded", "Cancellation persists full refund payment state.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", cancelPaid.product.id)).stock), 1, "Paid cancellation restores inventory after refund.");
    const cancelRepeat = await app.cancelOrder(cancelPaid.order.id, { providerCreate: async () => { throw new Error("must not issue another refund"); } });
    c.equal(cancelRepeat.status, "completed", "Repeated cancellation is idempotent.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", cancelPaid.product.id)).stock), 1, "Repeated cancellation never restores inventory twice.");

    const pendingCancel = await fixture();
    const pendingResult = await app.cancelOrder(pendingCancel.order.id, { providerCreate: async (...args) => ({ ...(await providerSuccess(...args)), status: "pending" }) });
    c.equal(pendingResult.status, "pending", "Pending provider refund leaves order uncancelled and recoverable.");
    c.equal((await app.db.get("SELECT status FROM orders WHERE id=?", pendingCancel.order.id)).status, "Pending", "Order is not marked cancelled before refund settlement.");
    const pendingRow = await app.db.get("SELECT id,provider_refund_id FROM refunds WHERE order_id=?", pendingCancel.order.id);
    refundIds.push(pendingRow.id);
    const reconciledCancel = await app.reconcileRefund(pendingRow.id, { lookup: async id => ({ id,
      payment_id: pendingCancel.payment.provider_payment_id, amount: 5000, currency: "INR", status: "processed" }) });
    c.equal(reconciledCancel.status, "succeeded", "Refund reconciliation completes pending paid cancellation.");
    c.equal((await app.db.get("SELECT status FROM orders WHERE id=?", pendingCancel.order.id)).status, "Cancelled", "Reconciled full refund completes order cancellation.");
    c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", pendingCancel.product.id)).stock), 1, "Reconciliation restores paid order inventory exactly once.");

    const unpaid = await fixture({ status: "pending" });
    const unpaidCancelled = await app.cancelOrder(unpaid.order.id, { providerCreate: async () => { throw new Error("unpaid cancellation must not refund"); } });
    c.equal(unpaidCancelled.status, "completed", "Unpaid order follows direct cancellation semantics.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM refunds WHERE order_id=?", unpaid.order.id)).count), 0, "Unpaid cancellation does not create a refund.");
    const cod = await fixture({ status: "pending", method: "cod" });
    const codCancelled = await app.cancelOrder(cod.order.id, { providerCreate: async () => { throw new Error("COD never uses Razorpay refunds"); } });
    c.equal(codCancelled.status, "completed", "COD order cancellation succeeds without online refund.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM refunds WHERE order_id=?", cod.order.id)).count), 0, "COD cancellation never creates an online refund.");

    for (const status of ["Shipped", "Delivered"]) {
      const late = await fixture({ orderStatus: status });
      await expectCode(() => app.cancelOrder(late.order.id), "ORDER_CANCELLATION_NOT_ALLOWED", `${status} order cancellation is rejected.`);
      c.equal(Number((await app.db.get("SELECT stock FROM products WHERE id=?", late.product.id)).stock), 0, `${status} rejection leaves inventory unchanged.`);
    }

    const noOrder = await fixture({ withOrder: false });
    let recoveryAttempts = 0;
    const failingFinalize = async () => { recoveryAttempts += 1; throw Object.assign(new Error("temporary db fault"), { code: "DB_TRANSIENT" }); };
    await expectCode(() => app.recoverCapturedCheckout(noOrder.payment.provider_payment_id, { finalize: failingFinalize }), "DB_TRANSIENT",
      "Transient order-creation failure is surfaced for safe retry.");
    const retryResult = await app.recoverCapturedCheckout(noOrder.payment.provider_payment_id, { finalize: async () => {
      recoveryAttempts += 1;
      return "PO-RECOVERED";
    } });
    c.equal(retryResult.status, "order_created", "Captured checkout recovery can retry a transient order-creation failure.");
    c.equal((await app.db.get("SELECT recovery_status FROM checkout_intents WHERE id=?", noOrder.intent.id)).recovery_status, "order_retry", "Transient failure remains explicitly marked for order retry.");
    c.equal(Number((await app.db.get("SELECT COUNT(*) AS count FROM refunds WHERE checkout_intent_id=?", noOrder.intent.id)).count), 0, "Transient order-creation failure does not trigger an unsafe refund.");

    const unrecoverable = await fixture({ withOrder: false });
    const recovery = await app.recoverCapturedCheckout(unrecoverable.payment.provider_payment_id, {
      finalize: async () => { throw Object.assign(new Error("reservation released"), { code: "ORDER_FINALIZATION_RESERVATION_MISSING" }); },
      providerCreate: providerSuccess
    });
    c.equal(recovery.status, "refunded", "Unfulfillable captured checkout follows the deterministic full-refund recovery path.");
    const orphanRecovery = await app.db.get("SELECT order_id,checkout_intent_id,status FROM refunds WHERE checkout_intent_id=?", unrecoverable.intent.id);
    refundIds.push(Number((await app.db.get("SELECT id FROM refunds WHERE checkout_intent_id=?", unrecoverable.intent.id)).id));
    c.equal(orphanRecovery.order_id, null, "Recovery refund retains payment/intent relationship without inventing a local order.");
    c.equal(Number(orphanRecovery.checkout_intent_id), Number(unrecoverable.intent.id), "Recovery refund remains linked to its durable checkout intent.");
    c.equal((await app.db.get("SELECT status FROM payments WHERE id=?", unrecoverable.payment.id)).status, "refunded", "Recovery refund updates the normalized payment state.");

    const recoverReconcile = await fixture({ withOrder: false });
    const uncertainRecovery = await app.recoverCapturedCheckout(recoverReconcile.payment.provider_payment_id, {
      finalize: async () => { throw Object.assign(new Error("reservation gone"), { code: "ORDER_FINALIZATION_INTENT_EXPIRED" }); },
      providerCreate: async () => { throw new Error("network timeout"); }
    });
    c.equal(uncertainRecovery.status, "refund_pending", "Ambiguous recovery refund remains explicitly pending reconciliation.");
    const uncertainRow = await app.db.get("SELECT id FROM refunds WHERE checkout_intent_id=?", recoverReconcile.intent.id);
    refundIds.push(Number(uncertainRow.id));
    const recoveredRefund = await app.reconcileRefund(uncertainRow.id, { lookup: async () => null, list: async paymentId => {
      const row = await app.db.get("SELECT idempotency_key,amount_minor,currency FROM refunds WHERE id=?", uncertainRow.id);
      return [{ id: "rfnd_recovered_after_timeout", payment_id: paymentId, amount: Number(row.amount_minor), currency: row.currency,
        status: "processed", notes: { printoasis_refund_key: row.idempotency_key } }];
    } });
    c.equal(recoveredRefund.status, "succeeded", "Refund without an initial provider ID is recovered by idempotency note lookup.");
    c.equal((await app.db.get("SELECT recovery_status FROM checkout_intents WHERE id=?", recoverReconcile.intent.id)).recovery_status,
      "refunded", "Refund reconciliation completes the explicit captured-checkout recovery state.");
    const repeatedRefundReconcile = await app.reconcileRefund(uncertainRow.id, { lookup: async () => ({ id: "rfnd_recovered_after_timeout",
      payment_id: recoverReconcile.payment.provider_payment_id, amount: 5000, currency: "INR", status: "processed" }) });
    c.equal(repeatedRefundReconcile.status, "succeeded", "Repeated refund reconciliation remains idempotent.");

    const mismatchState = await fixture();
    const conflicting = await request(mismatchState, 1000, `wrong-id-state:${mismatchState.order.id}`, async (...args) => ({
      ...(await providerSuccess(...args)), status: "pending"
    }));
    refundIds.push(conflicting.id);
    const changedId = await app.reconcileRefund(conflicting.id, { lookup: async () => ({ id: "rfnd_different", payment_id: mismatchState.payment.provider_payment_id,
      amount: 1000, currency: "INR", status: "processed" }) });
    c.equal(changedId.status, "unknown", "Reconciliation cannot replace an already-bound provider refund ID.");

    const duplicateProviderOne = await fixture();
    const duplicateProviderTwo = await fixture();
    const fixedRefundId = "rfnd_duplicate_identifier";
    const fixedProvider = async (paymentId, amount, currency, key) => ({ id: fixedRefundId, payment_id: paymentId, amount, currency,
      status: "processed", notes: { printoasis_refund_key: key } });
    const providerIdOwner = await request(duplicateProviderOne, 1000, `provider-id-owner:${duplicateProviderOne.order.id}`, fixedProvider);
    refundIds.push(providerIdOwner.id);
    const providerIdConflict = await request(duplicateProviderTwo, 1000, `provider-id-conflict:${duplicateProviderTwo.order.id}`, fixedProvider);
    refundIds.push(providerIdConflict.id);
    c.equal(providerIdOwner.status, "succeeded", "First provider refund ID remains associated with its refund.");
    c.equal(providerIdConflict.status, "unknown", "A duplicate provider refund ID is quarantined without moving its association.");

    return c.count;
  } finally {
    await app.db.transaction(async tx => {
      if (refundIds.length) await tx.run(`DELETE FROM refunds WHERE id IN (${refundIds.map(() => "?").join(",")})`, ...refundIds);
      if (paymentIds.length) await tx.run(`DELETE FROM refunds WHERE payment_record_id IN (SELECT id FROM payments WHERE provider_payment_id IN (${paymentIds.map(() => "?").join(",")}))`, ...paymentIds);
      if (orderIds.length) {
        await tx.run(`DELETE FROM notifications WHERE order_id IN (${orderIds.map(() => "?").join(",")})`, ...orderIds);
        await tx.run(`DELETE FROM order_status_events WHERE order_id IN (${orderIds.map(() => "?").join(",")})`, ...orderIds);
        await tx.run(`DELETE FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")})`, ...orderIds);
        await tx.run(`DELETE FROM orders WHERE id IN (${orderIds.map(() => "?").join(",")})`, ...orderIds);
      }
      if (paymentIds.length) await tx.run(`DELETE FROM payments WHERE provider_payment_id IN (${paymentIds.map(() => "?").join(",")})`, ...paymentIds);
      if (providerOrderIds.length) await tx.run(`DELETE FROM provider_orders WHERE id IN (${providerOrderIds.map(() => "?").join(",")})`, ...providerOrderIds);
      if (intentIds.length) await tx.run(`DELETE FROM checkout_intents WHERE id IN (${intentIds.map(() => "?").join(",")})`, ...intentIds);
      for (const id of productIds) await tx.run("DELETE FROM products WHERE id=?", id);
      await tx.run("DELETE FROM users WHERE id=?", user.id);
    });
  }
}

module.exports = { assertRefundRecoveryBehavior };
