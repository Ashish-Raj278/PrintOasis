module.exports = async function accountRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/orders")) {
    if (!app.requireAuth(session, res, url.pathname)) return true;
    app.send(res, 200, url.pathname.endsWith("orders") ? app.ordersPage(session, cart) : app.accountPage(url, session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/wishlist") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    app.send(res, 200, app.wishlistPage(session, cart));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/track") return app.send(res, 200, app.trackPage(url, session, cart)), true;
  if (req.method === "POST" && url.pathname === "/track") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const order = app.db.prepare("SELECT * FROM orders WHERE order_number = ? AND phone = ?").get((data.order_number || "").trim().toUpperCase(), (data.phone || "").trim());
    app.send(res, 200, order ? app.trackPage(url, session, cart, order) : app.trackPage(new URL("/track?notice=Order+not+found.", app.requestOrigin(req)), session, cart));
    return true;
  }
  if (req.method === "GET" && ["/help", "/contact", "/business"].includes(url.pathname)) {
    app.send(res, 200, app.infoPage(url.pathname.slice(1), session, cart));
    return true;
  }
  return false;
};
