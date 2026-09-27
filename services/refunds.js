const crypto = require("node:crypto");

function createRefundService({ db, createProviderRefund, lookupProviderRefund, listProviderRefunds, onCancelled }) {
  const refundError = (code, message) => Object.assign(new Error(message), { code });
  const keyFor = value => `po_refund_${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
  const providerStatus = value => {
    const status = String(value || "").toLowerCase();
    if (status === "processed" || status === "succeeded") return "succeeded";
    if (status === "failed") return "failed";
    if (status === "pending" || status === "created" || !status) return "pending";
    return "unknown";
  };

  async function restoreInventoryTx(tx, orderId) {
    const order = await tx.get("SELECT id, status, inventory_restocked FROM orders WHERE id=? FOR UPDATE", orderId);
    if (!order) throw refundError("ORDER_NOT_FOUND", "Order was not found.");
    if (order.inventory_restocked) return false;
    const items = await tx.all("SELECT product_id,quantity FROM order_items WHERE order_id=? AND product_id IS NOT NULL ORDER BY product_id", orderId);
    const totals = new Map();
    for (const item of items) totals.set(Number(item.product_id), (totals.get(Number(item.product_id)) || 0) + Number(item.quantity));
    const ids = [...totals.keys()].sort((a, b) => a - b);
    if (ids.length) {
      await tx.all(`SELECT id FROM products WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`, ...ids);
      for (const id of ids) await tx.run("UPDATE products SET stock=stock+? WHERE id=?", totals.get(id), id);
    }
    return true;
  }

  async function completeCancellationTx(tx, orderId, actor = {}) {
    const order = await tx.get("SELECT * FROM orders WHERE id=? FOR UPDATE", orderId);
    if (!order) throw refundError("ORDER_NOT_FOUND", "Order was not found.");
    if (order.status === "Cancelled") return false;
    if (["Shipped", "Delivered"].includes(order.status)) {
      throw refundError("ORDER_CANCELLATION_NOT_ALLOWED", "Shipped or delivered orders cannot be cancelled through this flow.");
    }
    if (order.payment_method === "razorpay") {
      const payment = order.payment_record_id && await tx.get("SELECT status FROM payments WHERE id=? FOR UPDATE", order.payment_record_id);
      if (payment && !["refunded", "failed", "pending"].includes(payment.status)) {
        throw refundError("ORDER_REFUND_INCOMPLETE", "The online payment must be fully refunded before cancellation.");
      }
    }
    await restoreInventoryTx(tx, orderId);
    await tx.run(`UPDATE orders SET status='Cancelled',inventory_restocked=1,cancellation_status='completed',
      status_updated_at=CURRENT_TIMESTAMP WHERE id=?`, orderId);
    const actorType = ["system", "customer", "admin", "payment", "refund"].includes(actor.actorType) ? actor.actorType : "system";
    const actorId = Number.isSafeInteger(Number(actor.actorId)) && Number(actor.actorId) > 0 ? Number(actor.actorId) : null;
    await tx.run(`INSERT INTO order_status_events (order_id,status,previous_status,actor_type,actor_id,note)
      VALUES (?,'Cancelled',?,?,?,?)`, orderId, order.status, actorType, actorId, "Order cancelled after the required payment/inventory checks.");
    return true;
  }

  async function updateCancellationAfterRefund(orderId) {
    if (!orderId) return false;
    const changed = await db.transaction(async tx => {
      const order = await tx.get("SELECT id,status,cancellation_status,payment_method,payment_record_id FROM orders WHERE id=? FOR UPDATE", orderId);
      if (!order || order.status === "Cancelled" || !["refund_pending", "failed"].includes(order.cancellation_status)) return false;
      if (!order.payment_record_id || order.payment_method !== "razorpay") return false;
      const payment = await tx.get("SELECT id,status,verified_amount_minor FROM payments WHERE id=? FOR UPDATE", order.payment_record_id);
      if (!payment || payment.status !== "refunded") return false;
      const pending = Number((await tx.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status IN ('requested','pending','unknown')", payment.id)).amount);
      if (pending > 0) return false;
      await tx.run("UPDATE orders SET cancellation_status='refunded' WHERE id=?", order.id);
      return completeCancellationTx(tx, order.id, { actorType: "refund" });
    });
    if (changed && onCancelled) await onCancelled(orderId);
    return changed;
  }

  async function persistProviderOutcome(refundId, raw, source = "create") {
    const refund = await db.get(`SELECT r.*,p.provider_payment_id FROM refunds r
      JOIN payments p ON p.id=r.payment_record_id WHERE r.id=?`, refundId);
    if (!refund) throw refundError("REFUND_NOT_FOUND", "Refund request was not found.");
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const paymentId = typeof raw?.payment_id === "string" ? raw.payment_id.trim() : "";
    const amount = Number(raw?.amount);
    const currency = String(raw?.currency || "").toUpperCase();
    const validIdentity = Boolean(id) && id.length <= 128 && paymentId === refund.provider_payment_id;
    const validAmount = Number.isSafeInteger(amount) && amount === Number(refund.amount_minor);
    const validCurrency = currency === refund.currency;
    const valid = validIdentity && validAmount && validCurrency;
    const nextStatus = valid ? providerStatus(raw.status) : "unknown";
    const safeProviderId = validIdentity ? id : null;
    const safeError = !validIdentity ? "provider_refund_identity_mismatch" : !validAmount ? "provider_refund_amount_mismatch" : !validCurrency ? "provider_refund_currency_mismatch" : null;

    let result;
    try {
      result = await db.transaction(async tx => {
        const current = await tx.get("SELECT * FROM refunds WHERE id=? FOR UPDATE", refundId);
        const payment = await tx.get("SELECT * FROM payments WHERE id=? FOR UPDATE", current.payment_record_id);
        if (current.status === "succeeded") return current;
        if (current.status === "failed" && !(source === "reconciliation" && nextStatus === "succeeded")) return current;
        if (safeProviderId && current.provider_refund_id && current.provider_refund_id !== safeProviderId) {
          await tx.run("UPDATE refunds SET status='unknown',last_error='provider_refund_id_changed',updated_at=CURRENT_TIMESTAMP WHERE id=?", refundId);
          return { ...current, status: "unknown" };
        }
        const status = current.status === "succeeded" ? "succeeded" : nextStatus;
        await tx.run(`UPDATE refunds SET provider_refund_id=COALESCE(provider_refund_id,?),status=?,provider_status=?,
          last_error=?,processed_at=CASE WHEN ? IN ('succeeded','failed') THEN CURRENT_TIMESTAMP ELSE processed_at END,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`, safeProviderId, status, String(raw?.status || "").slice(0, 40) || null,
        safeError, status, refundId);
        if (status === "succeeded") {
          const succeeded = Number((await tx.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status='succeeded'", payment.id)).amount);
          const captured = Number(payment.verified_amount_minor);
          if (succeeded > captured) throw refundError("REFUND_TOTAL_EXCEEDED", "Verified refunds exceed the captured payment amount.");
          const paymentStatus = succeeded === captured ? "refunded" : "partially_refunded";
          await tx.run(`UPDATE payments SET status=CASE WHEN status='refunded' THEN status ELSE ? END,
            updated_at=CURRENT_TIMESTAMP WHERE id=?`, paymentStatus, payment.id);
        }
        return await tx.get("SELECT * FROM refunds WHERE id=?", refundId);
      });
    } catch (error) {
      if (error.code !== "23505") throw error;
      await db.run("UPDATE refunds SET status='unknown',last_error='provider_refund_id_conflict',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'succeeded'", refundId);
      result = await db.get("SELECT * FROM refunds WHERE id=?", refundId);
    }
    if (result.status === "succeeded" && result.order_id) await updateCancellationAfterRefund(result.order_id);
    else if (result.status === "succeeded") await db.run("UPDATE checkout_intents SET recovery_status='refunded',recovery_error=NULL WHERE id=? AND recovery_status='refund_pending'", result.checkout_intent_id);
    return result;
  }

  async function requestPaymentRefund({ paymentRecordId, orderId = null, amountMinor, reason = "", operationKey, providerCreate = createProviderRefund }) {
    const amount = Number(amountMinor);
    const cleanReason = String(reason || "").trim().slice(0, 240);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !operationKey) throw refundError("REFUND_INVALID", "Refund amount or reference is invalid.");
    const idempotencyKey = keyFor(operationKey);
    const claim = await db.transaction(async tx => {
      if (orderId != null) await tx.get("SELECT id FROM orders WHERE id=? FOR UPDATE", orderId);
      const payment = await tx.get("SELECT * FROM payments WHERE id=? FOR UPDATE", paymentRecordId);
      if (!payment || !["captured", "partially_refunded", "refunded"].includes(payment.status) || !Number.isSafeInteger(Number(payment.verified_amount_minor))) {
        throw refundError("REFUND_PAYMENT_NOT_REFUNDABLE", "Only a captured online payment can be refunded.");
      }
      const intent = await tx.get("SELECT id FROM checkout_intents WHERE id=?", payment.checkout_intent_id);
      if (!intent) throw refundError("REFUND_PAYMENT_BINDING_INVALID", "Payment is not linked to a checkout intent.");
      if (orderId != null) {
        const order = await tx.get("SELECT id,payment_method,payment_record_id FROM orders WHERE id=?", orderId);
        if (!order || order.payment_method !== "razorpay" || Number(order.payment_record_id) !== Number(payment.id)) {
          throw refundError("REFUND_ORDER_PAYMENT_MISMATCH", "This order is not linked to the selected payment.");
        }
      }
      const existing = await tx.get(`SELECT r.*,p.provider_payment_id FROM refunds r
        JOIN payments p ON p.id=r.payment_record_id WHERE r.idempotency_key=? FOR UPDATE OF r`, idempotencyKey);
      if (existing) {
        if (Number(existing.payment_record_id) !== Number(payment.id) || Number(existing.order_id || 0) !== Number(orderId || 0) || Number(existing.amount_minor) !== amount) {
          throw refundError("REFUND_IDEMPOTENCY_CONFLICT", "This refund reference was already used for different refund details.");
        }
        return { existing, shouldCall: false };
      }
      const reserved = Number((await tx.get(`SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds
        WHERE payment_record_id=? AND status IN ('requested','pending','unknown','succeeded')`, payment.id)).amount);
      const captured = Number(payment.verified_amount_minor);
      if (!Number.isSafeInteger(captured) || reserved + amount > captured) {
        throw refundError("REFUND_AMOUNT_EXCEEDS_CAPTURE", "The requested refund exceeds the remaining captured amount.");
      }
      const refund = await tx.get(`INSERT INTO refunds
        (order_id,checkout_intent_id,payment_record_id,provider,idempotency_key,amount_minor,currency,status,reason,attempt_count)
        VALUES (?,?,?,?,?,?,?,'requested',?,1) RETURNING *`, orderId, intent.id, payment.id, payment.provider,
      idempotencyKey, amount, payment.currency, cleanReason || null);
      return { existing: { ...refund, provider_payment_id: payment.provider_payment_id }, shouldCall: true };
    });
    if (!claim.shouldCall) return claim.existing;

    const started = await db.transaction(async tx => {
      const row = await tx.get("SELECT * FROM refunds WHERE id=? FOR UPDATE", claim.existing.id);
      if (!row || row.status !== "requested") return false;
      await tx.run("UPDATE refunds SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='requested'", row.id);
      return true;
    });
    if (!started) return await db.get("SELECT * FROM refunds WHERE id=?", claim.existing.id);

    let providerRefund;
    try {
      providerRefund = await providerCreate(claim.existing.provider_payment_id, amount, claim.existing.currency, idempotencyKey);
    } catch (error) {
      const status = error?.definitive === true ? "failed" : "unknown";
      const saved = await db.transaction(async tx => {
        const row = await tx.get("SELECT * FROM refunds WHERE id=? FOR UPDATE", claim.existing.id);
        if (row.status !== "succeeded") await tx.run(`UPDATE refunds SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP,
          processed_at=CASE WHEN ?='failed' THEN CURRENT_TIMESTAMP ELSE processed_at END WHERE id=?`,
        status, error?.code === "REFUND_PROVIDER_REJECTED" ? "provider_rejected" : "provider_outcome_unknown", status, row.id);
        return tx.get("SELECT * FROM refunds WHERE id=?", row.id);
      });
      return saved;
    }
    return persistProviderOutcome(claim.existing.id, providerRefund, "create");
  }

  async function reconcileRefund(refundId, { lookup = lookupProviderRefund, list = listProviderRefunds } = {}) {
    const row = await db.get(`SELECT r.*,p.provider_payment_id FROM refunds r JOIN payments p ON p.id=r.payment_record_id WHERE r.id=?`, refundId);
    if (!row) throw refundError("REFUND_NOT_FOUND", "Refund request was not found.");
    if (row.status === "succeeded") return row;
    let providerRefund = null;
    if (row.provider_refund_id) providerRefund = await lookup(row.provider_refund_id);
    else if (list) {
      const refunds = await list(row.provider_payment_id);
      providerRefund = Array.isArray(refunds) ? refunds.find(refund => refund?.notes?.printoasis_refund_key === row.idempotency_key) : null;
    }
    if (!providerRefund) return row;
    return persistProviderOutcome(row.id, providerRefund, "reconciliation");
  }

  async function reconcileRefunds({ limit = 50, lookup = lookupProviderRefund, list = listProviderRefunds } = {}) {
    const rows = await db.all(`SELECT id FROM refunds WHERE status IN ('requested','pending','unknown','failed') ORDER BY created_at LIMIT ?`,
      Math.max(1, Math.min(200, Number(limit) || 50)));
    const result = { checked: 0, changed: 0, unresolved: 0 };
    for (const row of rows) {
      try {
        const before = await db.get("SELECT status FROM refunds WHERE id=?", row.id);
        const after = await reconcileRefund(row.id, { lookup, list });
        result.checked += 1;
        if (before.status !== after.status) result.changed += 1;
        else if (["pending", "unknown", "requested"].includes(after.status)) result.unresolved += 1;
      } catch {
        result.checked += 1;
        result.unresolved += 1;
      }
    }
    return result;
  }

  async function cancelOrder(orderId, { providerCreate = createProviderRefund, actor = {} } = {}) {
    const decision = await db.transaction(async tx => {
      const order = await tx.get("SELECT * FROM orders WHERE id=? FOR UPDATE", orderId);
      if (!order) throw refundError("ORDER_NOT_FOUND", "Order was not found.");
      if (["Shipped", "Delivered"].includes(order.status)) throw refundError("ORDER_CANCELLATION_NOT_ALLOWED", "Shipped or delivered orders cannot be cancelled through this flow.");
      if (order.status === "Cancelled") return { status: "completed", reused: true };
      const payment = order.payment_record_id ? await tx.get("SELECT * FROM payments WHERE id=? FOR UPDATE", order.payment_record_id) : null;
      if (order.payment_method !== "razorpay" || (payment && ["pending", "failed"].includes(payment.status))) {
        await completeCancellationTx(tx, orderId, actor);
        return { status: "completed", reused: false };
      }
      if (!payment) throw refundError("ORDER_CANCELLATION_PAYMENT_UNCERTAIN", "The online payment relationship must be reviewed before cancellation.");
      if (!["captured", "partially_refunded", "refunded"].includes(payment.status)) {
        throw refundError("ORDER_CANCELLATION_PAYMENT_UNCERTAIN", "The online payment state must be reconciled before cancellation.");
      }
      await tx.run("UPDATE orders SET cancellation_status='refund_pending' WHERE id=?", orderId);
      const succeeded = Number((await tx.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status='succeeded'", payment.id)).amount);
      const active = Number((await tx.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status IN ('requested','pending','unknown')", payment.id)).amount);
      if (active > 0) return { status: "pending", reused: true };
      const captured = Number(payment.verified_amount_minor);
      const remaining = captured - succeeded;
      if (remaining <= 0) {
        await tx.run("UPDATE orders SET cancellation_status='refunded' WHERE id=?", orderId);
        await completeCancellationTx(tx, orderId, actor);
        return { status: "completed", reused: false };
      }
      return { status: "refund_required", payment_record_id: payment.id, payment_id: payment.provider_payment_id,
        amount_minor: remaining, operation_key: `cancel-order:${orderId}:${payment.id}:${remaining}` };
    });
    if (decision.status !== "refund_required") {
      if (decision.status === "completed" && !decision.reused && onCancelled) await onCancelled(orderId);
      return decision;
    }
    const refund = await requestPaymentRefund({
      paymentRecordId: decision.payment_record_id, orderId, amountMinor: decision.amount_minor,
      reason: "Order cancellation", operationKey: decision.operation_key, providerCreate
    });
    if (refund.status === "succeeded") {
      const completed = await db.transaction(async tx => {
        await tx.run("UPDATE orders SET cancellation_status='refunded' WHERE id=? AND status<>'Cancelled'", orderId);
        return completeCancellationTx(tx, orderId, actor);
      });
      if (completed && onCancelled) await onCancelled(orderId);
      return { status: "completed", refund };
    }
    if (refund.status === "failed") await db.run("UPDATE orders SET cancellation_status='failed' WHERE id=? AND status<>'Cancelled'", orderId);
    return { status: refund.status === "failed" ? "failed" : "pending", refund };
  }

  async function recoverCapturedCheckout(paymentId, { finalize, providerCreate = createProviderRefund, notify = false } = {}) {
    const payment = await db.get(`SELECT p.id AS payment_record_id,p.provider_payment_id,p.status,p.verified_amount_minor,
      p.checkout_intent_id,ci.session_id,ci.user_id FROM payments p JOIN checkout_intents ci ON ci.id=p.checkout_intent_id
      WHERE p.provider='razorpay' AND p.provider_payment_id=?`, String(paymentId));
    if (!payment || payment.status !== "captured") throw refundError("CHECKOUT_RECOVERY_PAYMENT_INVALID", "A captured payment is required for checkout recovery.");
    try {
      const orderNumber = await finalize({ id: payment.session_id, user: { id: Number(payment.user_id) } }, payment.provider_payment_id,
        { recovery: true, notify });
      return { status: "order_created", order_number: orderNumber };
    } catch (error) {
      if (!new Set(["ORDER_FINALIZATION_RESERVATION_MISSING", "ORDER_FINALIZATION_INTENT_EXPIRED", "ORDER_FINALIZATION_INVENTORY_MISSING"]).has(error.code)) {
        await db.run("UPDATE checkout_intents SET recovery_status='order_retry',recovery_error=? WHERE id=?", String(error.code || "order_finalization_error").slice(0, 80), payment.checkout_intent_id);
        throw error;
      }
      const existingOrder = await db.get("SELECT id FROM orders WHERE checkout_intent_id=?", payment.checkout_intent_id);
      if (existingOrder) return { status: "order_created", order_id: existingOrder.id };
      await db.run("UPDATE checkout_intents SET recovery_status='refund_pending',recovery_error=? WHERE id=?", String(error.code).slice(0, 80), payment.checkout_intent_id);
      const captured = Number(payment.verified_amount_minor);
      const already = Number((await db.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status='succeeded'", payment.payment_record_id)).amount);
      const active = Number((await db.get("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE payment_record_id=? AND status IN ('requested','pending','unknown')", payment.payment_record_id)).amount);
      if (active > 0) return { status: "refund_pending" };
      if (captured <= already) {
        await db.run("UPDATE checkout_intents SET recovery_status='refunded' WHERE id=?", payment.checkout_intent_id);
        return { status: "refunded" };
      }
      const refund = await requestPaymentRefund({
        paymentRecordId: payment.payment_record_id, amountMinor: captured - already,
        reason: "Paid checkout could not be fulfilled", operationKey: `checkout-recovery:${payment.checkout_intent_id}:${payment.payment_record_id}:${captured - already}`,
        providerCreate
      });
      if (refund.status === "succeeded") await db.run("UPDATE checkout_intents SET recovery_status='refunded',recovery_error=NULL WHERE id=?", payment.checkout_intent_id);
      return { status: refund.status === "failed" ? "refund_failed" : refund.status === "succeeded" ? "refunded" : "refund_pending", refund };
    }
  }

  return { requestPaymentRefund, reconcileRefund, reconcileRefunds, cancelOrder, recoverCapturedCheckout };
}

module.exports = { createRefundService };
