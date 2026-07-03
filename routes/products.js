module.exports = async function productRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/api/search-suggestions") {
    const q = (url.searchParams.get("q") || "").trim();
    const suggestions = q
      ? app.db.prepare("SELECT name FROM products WHERE active = 1 AND (name LIKE ? OR description LIKE ?) ORDER BY rating DESC LIMIT 8").all(`%${q}%`, `%${q}%`).map(row => row.name)
      : ["Business Cards", "Flyers", "Stickers", "Posters", "T-shirts", "Photo Mugs"];
    app.sendJson(res, 200, { suggestions });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/") return app.send(res, 200, app.homePage(session, cart)), true;
  if (req.method === "GET" && url.pathname === "/products") return app.send(res, 200, app.productsPage(url, session, cart)), true;
  if (req.method === "GET" && url.pathname.startsWith("/product/")) {
    const product = app.db.prepare("SELECT * FROM products WHERE slug = ? AND active = 1").get(url.pathname.split("/").pop());
    app.send(res, product ? 200 : 404, product ? app.productPage(product, session, cart) : app.layout("Not found", `<div class="empty section"><h1>Product not found</h1><a href="/products">Browse products</a></div>`, session, cart));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/wishlist/toggle") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const product = app.db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
    if (!product) return app.redirect(res, "/products?notice=Product+not+found."), true;
    const existing = app.db.prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?").get(session.user.id, product.id);
    if (existing) app.db.prepare("DELETE FROM wishlist_items WHERE id = ?").run(existing.id);
    else app.db.prepare("INSERT OR IGNORE INTO wishlist_items (user_id, product_id) VALUES (?, ?)").run(session.user.id, product.id);
    app.redirect(res, `/product/${product.slug}?notice=${existing ? "Removed+from+wishlist." : "Added+to+wishlist."}`);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/reviews/add") {
    if (!app.requireAuth(session, res, "/login")) return true;
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const product = app.db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
    if (!product) return app.redirect(res, "/products?notice=Product+not+found."), true;
    const rating = Math.max(1, Math.min(5, Number(data.rating) || 5));
    const comment = String(data.comment || "").trim().slice(0, 600);
    if (comment.length >= 8) app.db.prepare("INSERT INTO reviews (product_id,user_id,name,rating,comment) VALUES (?,?,?,?,?)").run(product.id, session.user.id, session.user.name, rating, comment);
    app.redirect(res, `/product/${product.slug}?notice=Review+submitted.`);
    return true;
  }
  return false;
};
