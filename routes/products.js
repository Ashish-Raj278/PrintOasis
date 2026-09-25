module.exports = async function productRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/api/search-suggestions") {
    const q = (url.searchParams.get("q") || "").trim();
    const suggestions = q ? (await app.db.all(`SELECT name FROM products WHERE ${app.visibleProductCondition()} AND (name ILIKE ? OR description ILIKE ?) ORDER BY rating DESC LIMIT 8`, `%${q}%`, `%${q}%`)).map(row => row.name) : ["Business Cards", "Flyers", "Stickers", "Posters", "T-shirts", "Photo Mugs"];
    app.sendJson(res, 200, { suggestions }); return true;
  }
  if (req.method === "GET" && url.pathname === "/") return app.send(res, 200, await app.homePage(session, cart)), true;
  if (req.method === "GET" && url.pathname === "/products") return app.send(res, 200, await app.productsPage(url, session, cart)), true;
  if (req.method === "GET" && url.pathname.startsWith("/product/")) {
    const product = await app.db.get(`SELECT * FROM products WHERE slug = ? AND ${app.visibleProductCondition()}`, url.pathname.split("/").pop());
    app.send(res, product ? 200 : 404, product ? await app.productPage(product, session, cart, url) : await app.layout("Not found", `<div class="empty section"><h1>Product not found</h1><a href="/products">Browse products</a></div>`, session, cart)); return true;
  }
  if (req.method === "POST" && url.pathname === "/wishlist/toggle") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const product = await app.db.get(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`, Number(data.product_id));
    if (!product) return app.redirect(res, "/products?notice=Product+not+found."), true;
    const existing = await app.db.get("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?", session.user.id, product.id);
    if (existing) await app.db.run("DELETE FROM wishlist_items WHERE id = ?", existing.id);
    else await app.db.run("INSERT INTO wishlist_items (user_id, product_id, saved_price) VALUES (?, ?, ?) ON CONFLICT (user_id, product_id) DO NOTHING", session.user.id, product.id, product.price);
    const next = data.next === "/wishlist" ? "/wishlist" : `/product/${product.slug}`;
    app.redirect(res, `${next}?notice=${existing ? "Removed+from+wishlist." : "Added+to+wishlist."}`); return true;
  }
  if (req.method === "POST" && url.pathname === "/wishlist/move-to-cart") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    try {
      await app.db.transaction(async tx => {
        const product = await tx.get(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()} FOR UPDATE`, Number(data.product_id));
        if (!product) throw new Error("This saved product is no longer available.");
        await app.addCartItem(session.id, product, product.min_qty, { size: String(product.sizes || "").split("|")[0], material: String(product.materials || "").split("|")[0], printOption: String(product.print_options || "").split("|")[0] }, tx);
        await tx.run("DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?", session.user.id, product.id);
      });
      app.redirect(res, "/cart?notice=Wishlist+item+moved+to+your+cart.");
    } catch (error) { app.redirect(res, `/wishlist?notice=${encodeURIComponent(error.message)}`); }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/reviews/add") {
    if (!app.requireAuth(session, res, "/login")) return true;
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const product = await app.db.get(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`, Number(data.product_id));
    if (!product) return app.redirect(res, "/products?notice=Product+not+found."), true;
    const rating = Math.max(1, Math.min(5, Number(data.rating) || 5)); const comment = String(data.comment || "").trim().slice(0, 600);
    if (!await app.hasDeliveredPurchase(session.user.id, product.id)) { app.redirect(res, `/product/${product.slug}?notice=Only+customers+with+a+delivered+order+can+review+this+product.`); return true; }
    const existing = await app.db.get("SELECT id FROM reviews WHERE user_id = ? AND product_id = ? LIMIT 1", session.user.id, product.id);
    if (comment.length < 8) { app.redirect(res, `/product/${product.slug}?notice=Review+must+contain+at+least+8+characters.`); return true; }
    if (existing) { app.redirect(res, "/account/orders?notice=Manage+your+existing+review+from+the+delivered+order."); return true; }
    await app.db.run("INSERT INTO reviews (product_id,user_id,name,rating,comment,verified_purchase) VALUES (?,?,?,?,?,1)", product.id, session.user.id, session.user.name, rating, comment);
    app.redirect(res, `/product/${product.slug}?notice=Review+submitted.`); return true;
  }
  return false;
};