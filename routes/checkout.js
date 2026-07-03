module.exports = async function checkoutRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/checkout") {
    if (!cart.items.length) return app.redirect(res, "/cart?notice=Your+cart+is+empty."), true;
    if (!app.requireAuth(session, res, "/checkout")) return true;
    app.send(res, 200, app.checkoutPage(session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/invoice/")) {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    const orderNumber = decodeURIComponent(url.pathname.split("/").pop() || "");
    const order = app.isAdmin(session)
      ? app.db.prepare("SELECT * FROM orders WHERE order_number = ?").get(orderNumber)
      : app.db.prepare("SELECT * FROM orders WHERE order_number = ? AND user_id = ?").get(orderNumber, session.user.id);
    if (!order) return app.send(res, 404, app.layout("Invoice not found", `<div class="empty section"><h1>Invoice not found</h1><a href="/account/orders">Back to orders</a></div>`, session, cart)), true;
    const items = app.db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    app.send(res, 200, app.invoicePage(order, items, session, cart));
    return true;
  }
  if (req.method !== "POST") return false;
  if (["/payment/create", "/payment/verify", "/checkout"].includes(url.pathname) && !app.validCsrf(data, session)) {
    return app.send(res, 403, "Invalid form token", "text/plain"), true;
  }
  if (url.pathname === "/payment/create") {
    if (!app.requireAuth(session, res, "/checkout")) return true;
    if (!app.RAZORPAY_KEY_ID || !app.RAZORPAY_KEY_SECRET) return app.sendJson(res, 503, { error: "Online payment is not configured." }), true;
    const freshCart = app.cartData(session.id);
    if (!freshCart.items.length) return app.sendJson(res, 400, { error: "Your cart is empty." }), true;
    const totals = app.cartTotals(freshCart, data.postal_code, data.coupon_code);
    const razorpayOrder = await app.createRazorpayOrder(totals.total, `po_${Date.now()}`);
    app.sendJson(res, 200, { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, keyId: app.RAZORPAY_KEY_ID });
    return true;
  }
  if (url.pathname === "/payment/verify") {
    if (!app.requireAuth(session, res, "/checkout")) return true;
    const signature = app.crypto.createHmac("sha256", app.RAZORPAY_KEY_SECRET).update(`${data.razorpay_order_id}|${data.razorpay_payment_id}`).digest("hex");
    const receivedSignature = data.razorpay_signature || "";
    if (receivedSignature.length !== signature.length || !app.crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(receivedSignature))) {
      return app.redirect(res, `/checkout?notice=${encodeURIComponent("Payment verification failed. No order was created.")}`), true;
    }
    const orderNumber = app.createLocalOrder(session, app.cartData(session.id), data, "razorpay", data.razorpay_payment_id);
    app.redirect(res, `/account?notice=${encodeURIComponent(`Payment received. Order ${orderNumber} placed successfully.`)}`);
    return true;
  }
  if (url.pathname === "/checkout") {
    if (!app.requireAuth(session, res, "/checkout")) return true;
    const freshCart = app.cartData(session.id);
    if (!freshCart.items.length) return app.redirect(res, "/cart"), true;
    if (data.payment_method !== "cod") return app.redirect(res, `/checkout?notice=${encodeURIComponent("Please complete the secure online payment window.")}`), true;
    const orderNumber = app.createLocalOrder(session, freshCart, data, "cod");
    app.redirect(res, `/account?notice=${encodeURIComponent(`Order ${orderNumber} placed successfully.`)}`);
    return true;
  }
  return false;
};
