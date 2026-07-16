module.exports = async function cartRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/cart") return app.send(res, 200, app.cartPage(url, session, cart)), true;
  if (req.method !== "POST") return false;

  if (url.pathname === "/cart/add") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;

    const productId = Number(data.product_id);
    let product = null;
    app.db.exec("BEGIN IMMEDIATE");
    try {
      product = app.db.prepare(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()}`).get(productId);
      if (!product) {
        app.db.exec("ROLLBACK");
        return app.send(res, 404, "Product not found", "text/plain"), true;
      }

      const artwork = app.saveArtwork(data.files?.artwork_file);
      app.addCartItem(session.id, product, data.quantity, {
        size: data.size,
        material: data.material,
        printOption: data.print_option,
        artworkNote: (data.artwork_note || "").slice(0, 500),
        artworkOriginalName: artwork?.original,
        artworkStoredName: artwork?.stored,
        artworkMime: artwork?.mime,
        artworkSize: artwork?.size
      });
      app.db.exec("COMMIT");
      app.redirect(res, "/cart?notice=Product+added+to+your+cart.");
      return true;
    } catch (error) {
      app.db.exec("ROLLBACK");
      if (product) return app.redirect(res, `/product/${product.slug}?notice=${encodeURIComponent(error.message)}`), true;
      throw error;
    }
  }

  if (url.pathname === "/cart/update") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;

    const itemId = Number(data.item_id);
    const quantity = Math.max(0, Math.floor(Number(data.quantity) || 0));
    app.db.exec("BEGIN IMMEDIATE");
    try {
      const item = app.db.prepare(`
        SELECT ci.*, p.slug, p.name, p.stock, p.reserved, p.status, p.active
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.id = ? AND ci.session_id = ?
      `).get(itemId, session.id);

      if (!item) {
        app.db.exec("ROLLBACK");
        return app.redirect(res, "/cart?notice=Cart+item+not+found."), true;
      }

      if (quantity <= 0) {
        app.releaseReservedQuantity(item.product_id, item.quantity);
        app.db.prepare("DELETE FROM cart_items WHERE id = ? AND session_id = ?").run(itemId, session.id);
        app.db.exec("COMMIT");
        return app.redirect(res, "/cart?notice=Item+removed."), true;
      }

      const diff = quantity - item.quantity;
      if (diff > 0) {
        if (!item.active || item.status === "hidden") {
          app.db.exec("ROLLBACK");
          return app.redirect(res, "/cart?notice=That+product+is+no+longer+available."), true;
        }
        const available = app.productAvailable(item);
        if (diff > available) {
          app.db.exec("ROLLBACK");
          return app.redirect(res, `/cart?notice=${encodeURIComponent(`Only ${item.quantity + app.sellableQuantity(item)} items available.`)}`), true;
        }
        app.db.prepare("UPDATE products SET reserved = reserved + ? WHERE id = ?").run(diff, item.product_id);
      } else if (diff < 0) {
        app.releaseReservedQuantity(item.product_id, -diff);
      }

      app.db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?").run(quantity, itemId, session.id);
      app.db.exec("COMMIT");
      app.redirect(res, "/cart?notice=Cart+updated.");
      return true;
    } catch (error) {
      app.db.exec("ROLLBACK");
      throw error;
    }
  }

  return false;
};
