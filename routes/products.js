module.exports = async function productRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;

  if (req.method === "GET" && url.pathname === "/api/search-suggestions") {
    const q = (url.searchParams.get("q") || "").trim();
    const suggestions = q
      ? app.db.prepare(`SELECT name FROM products WHERE ${app.visibleProductCondition()} AND (name LIKE ? OR description LIKE ?) ORDER BY rating DESC LIMIT 8`).all(`%${q}%`, `%${q}%`).map(row => row.name)
      : ["Business Cards", "Flyers", "Stickers", "Posters", "T-shirts", "Photo Mugs"];

    app.sendJson(res, 200, { suggestions });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/")
    return app.send(res, 200, app.homePage(session, cart)), true;

  if (req.method === "GET" && url.pathname === "/products")
    return app.send(res, 200, app.productsPage(url, session, cart)), true;

  if (req.method === "GET" && url.pathname.startsWith("/product/")) {
    const product = app.db
      .prepare(`SELECT * FROM products WHERE slug = ? AND ${app.visibleProductCondition()}`)
      .get(url.pathname.split("/").pop());

    app.send(
      res,
      product ? 200 : 404,
      product
        ? app.productPage(product, session, cart, url)
        : app.layout(
            "Not found",
            `<div class="empty section"><h1>Product not found</h1><a href="/products">Browse products</a></div>`,
            session,
            cart
          )
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/wishlist/toggle") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    if (!app.validCsrf(data, session))
      return app.send(res, 403, "Invalid form token", "text/plain"), true;

    const product = app.db
      .prepare(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`)
      .get(Number(data.product_id));

    if (!product)
      return app.redirect(res, "/products?notice=Product+not+found."), true;

    const existing = app.db
      .prepare("SELECT id FROM wishlist_items WHERE user_id = ? AND product_id = ?")
      .get(session.user.id, product.id);

    if (existing)
      app.db.prepare("DELETE FROM wishlist_items WHERE id = ?").run(existing.id);
    else
      app.db
        .prepare("INSERT OR IGNORE INTO wishlist_items (user_id, product_id, saved_price) VALUES (?, ?, ?)")
        .run(session.user.id, product.id, product.price);

    const next = data.next === "/wishlist" ? "/wishlist" : `/product/${product.slug}`;
    app.redirect(
      res,
      `${next}?notice=${
        existing ? "Removed+from+wishlist." : "Added+to+wishlist."
      }`
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/wishlist/move-to-cart") {
    if (!app.requireAuth(session, res, "/wishlist")) return true;
    if (!app.validCsrf(data, session))
      return app.send(res, 403, "Invalid form token", "text/plain"), true;

    app.db.exec("BEGIN IMMEDIATE");
    try {
      const product = app.db.prepare(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`).get(Number(data.product_id));
      if (!product) throw new Error("This saved product is no longer available.");
      app.addCartItem(session.id, product, product.min_qty, {
        size: String(product.sizes || "").split("|")[0],
        material: String(product.materials || "").split("|")[0],
        printOption: String(product.print_options || "").split("|")[0]
      });
      app.db.prepare("DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?").run(session.user.id, product.id);
      app.db.exec("COMMIT");
      app.redirect(res, "/cart?notice=Wishlist+item+moved+to+your+cart.");
    } catch (error) {
      app.db.exec("ROLLBACK");
      app.redirect(res, `/wishlist?notice=${encodeURIComponent(error.message)}`);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/reviews/add") {
    if (!app.requireAuth(session, res, "/login")) return true;
    if (!app.validCsrf(data, session))
      return app.send(res, 403, "Invalid form token", "text/plain"), true;

    const product = app.db
      .prepare(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`)
      .get(Number(data.product_id));

    if (!product)
      return app.redirect(res, "/products?notice=Product+not+found."), true;

    
    const rating = Math.max(1, Math.min(5, Number(data.rating) || 5));
const comment = String(data.comment || "").trim().slice(0, 600);

if (!app.hasDeliveredPurchase(session.user.id, product.id)) {
  app.redirect(
    res,
    `/product/${product.slug}?notice=Only+customers+with+a+delivered+order+can+review+this+product.`
  );
  return true;
}

const existingReview = app.db.prepare(`
  SELECT id
  FROM reviews
  WHERE user_id = ? AND product_id = ?
  LIMIT 1
`).get(session.user.id, product.id);

if (comment.length < 8) {
  app.redirect(
    res,
    `/product/${product.slug}?notice=Review+must+contain+at+least+8+characters.`
  );
  return true;
}

if (existingReview) {
  app.redirect(
    res,
    `/account/orders?notice=Manage+your+existing+review+from+the+delivered+order.`
  );
  return true;
}

app.db.prepare(`
  INSERT INTO reviews
  (product_id,user_id,name,rating,comment,verified_purchase)
  VALUES (?,?,?,?,?,1)
`).run(
  product.id,
  session.user.id,
  session.user.name,
  rating,
  comment
);

app.redirect(
  res,
  `/product/${product.slug}?notice=Review+submitted.`
);
return true;
  }

  return false;
};
