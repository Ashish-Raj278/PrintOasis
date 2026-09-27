module.exports = async function checkoutRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/checkout") { if (!cart.items.length) return app.redirect(res, "/cart?notice=Your+cart+is+empty."), true; if (!app.requireAuth(session, res, "/checkout")) return true; app.send(res, 200, await app.checkoutPage(session, cart, url)); return true; }
  if (req.method === "GET" && url.pathname.startsWith("/invoice/")) {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    const orderNumber = decodeURIComponent(url.pathname.split("/").pop() || "");
    const order = app.isAdmin(session) ? await app.db.get("SELECT * FROM orders WHERE order_number = ?", orderNumber) : await app.db.get("SELECT * FROM orders WHERE order_number = ? AND user_id = ?", orderNumber, session.user.id);
    if (!order) return app.send(res, 404, await app.layout("Invoice not found", `<div class="empty section"><h1>Invoice not found</h1><a href="/account/orders">Back to orders</a></div>`, session, cart)), true;
    const items = await app.db.all("SELECT * FROM order_items WHERE order_id = ?", order.id);
    app.send(res, 200, await app.invoicePage(order, items, session, cart)); return true;
  }
  if (req.method !== "POST") return false;
  if (["/payment/create", "/payment/verify", "/payment/failed", "/checkout"].includes(url.pathname) && !app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
  if (url.pathname === "/payment/create") {
    if (!app.requireAuth(session, res, "/checkout")) return true;
    if (!app.RAZORPAY_KEY_ID || !app.RAZORPAY_KEY_SECRET) return app.sendJson(res, 503, { error: "Online payment is not configured." }), true;
    let providerOrder;
    try { providerOrder = await app.createProviderOrder(session, data); }
    catch (error) {
      const clientErrors = new Set(["CHECKOUT_INVALID", "PROVIDER_ORDER_INTENT_INVALID", "PROVIDER_ORDER_INTENT_UNAVAILABLE"]);
      const retryable = new Set(["PROVIDER_ORDER_IN_PROGRESS", "PROVIDER_ORDER_FAILED"]);
      if (!clientErrors.has(error.code) && !retryable.has(error.code) && !String(error.code || "").startsWith("PROVIDER_ORDER_")) throw error;
      const status = clientErrors.has(error.code) ? 400 : retryable.has(error.code) ? 503 : 502;
      return app.sendJson(res, status, { error: error.message }), true;
    }
    app.sendJson(res, 200, { orderId: providerOrder.provider_order_id, amount: Number(providerOrder.provider_amount_minor), currency: providerOrder.provider_currency, keyId: app.RAZORPAY_KEY_ID });
    return true;
  }
  if (url.pathname === "/payment/verify") {
    if (!app.requireAuth(session, res, "/checkout")) return true;
    if (!app.RAZORPAY_KEY_ID || !app.RAZORPAY_KEY_SECRET) return app.sendJson(res, 503, { error: "Online payment verification is not configured." }), true;
    try {
      const payment = await app.verifyProviderPayment(session, data);
      if (payment.status === "failed") {
        await app.releaseSessionReservations(session.id);
        return app.redirect(res, `/cart?notice=${encodeURIComponent("The provider confirmed that payment failed. Your reservation was released and no order was created.")}`), true;
      }
      if (payment.status !== "captured") {
        return app.redirect(res, `/checkout?notice=${encodeURIComponent("The provider has not confirmed a captured payment yet. Please retry verification shortly.")}`), true;
      }
      const orderNumber = await app.finalizeCapturedCheckout(session, payment.provider_payment_id);
      app.redirect(res, `/account?notice=${encodeURIComponent(`Payment received. Order ${orderNumber} placed successfully.`)}`);
    } catch (error) {
      if (error.code === "PAYMENT_INVALID_SIGNATURE") await app.releaseSessionReservations(session.id);
      const message = error.code?.startsWith("PAYMENT_") ? error.message : "Payment verification could not be completed. Please retry.";
      app.redirect(res, `/checkout?notice=${encodeURIComponent(message)}`);
    }
    return true;
  }
  if (url.pathname === "/payment/failed") { if (!app.requireAuth(session, res, "/checkout")) return true; await app.releaseSessionReservations(session.id); app.sendJson(res, 200, { ok: true }); return true; }
  if (url.pathname === "/checkout") { if (!app.requireAuth(session, res, "/checkout")) return true; const freshCart = await app.cartData(session.id); if (!freshCart.items.length) return app.redirect(res, "/cart"), true; if (data.payment_method !== "cod") return app.redirect(res, `/checkout?notice=${encodeURIComponent("Please complete the secure online payment window.")}`), true; try { const orderNumber = await app.createLocalOrder(session, freshCart, data, "cod"); app.redirect(res, `/account?notice=${encodeURIComponent(`Order ${orderNumber} placed successfully.`)}`); } catch (error) { app.redirect(res, `/cart?notice=${encodeURIComponent(error.message)}`); } return true; }
  return false;
};
