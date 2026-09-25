module.exports = async function cartRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/cart") return app.send(res, 200, await app.cartPage(url, session, cart)), true;
  if (req.method !== "POST") return false;
  if (url.pathname === "/cart/add") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const productId = Number(data.product_id);
    let product = null;
    try {
      await app.db.transaction(async tx => {
        product = await tx.get(`SELECT * FROM products WHERE id = ? AND ${app.visibleProductCondition()} FOR UPDATE`, productId);
        if (!product) return;
        const artwork = app.saveArtwork(data.files?.artwork_file);
        await app.addCartItem(session.id, product, data.quantity, {
          size: data.size, material: data.material, printOption: data.print_option,
          artworkNote: (data.artwork_note || "").slice(0, 500), artworkOriginalName: artwork?.original,
          artworkStoredName: artwork?.stored, artworkMime: artwork?.mime, artworkSize: artwork?.size
        }, tx);
      });
      if (!product) return app.send(res, 404, "Product not found", "text/plain"), true;
      app.redirect(res, "/cart?notice=Product+added+to+your+cart.");
    } catch (error) {
      if (product) return app.redirect(res, `/product/${product.slug}?notice=${encodeURIComponent(error.message)}`), true;
      throw error;
    }
    return true;
  }
  if (url.pathname === "/cart/update") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const itemId = Number(data.item_id);
    const quantity = Math.max(0, Math.floor(Number(data.quantity) || 0));
    let outcome = "updated";
    try {
      await app.db.transaction(async tx => {
        const item = await tx.get(`SELECT ci.*, p.slug, p.name, p.stock, p.reserved, p.status, p.active FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = ? AND ci.session_id = ? FOR UPDATE OF ci, p`, itemId, session.id);
        if (!item) { outcome = "missing"; return; }
        if (quantity <= 0) {
          await app.releaseReservedQuantity(item.product_id, item.quantity, tx);
          await tx.run("DELETE FROM cart_items WHERE id = ? AND session_id = ?", itemId, session.id);
          outcome = "removed";
          return;
        }
        const diff = quantity - item.quantity;
        if (diff > 0) {
          if (!item.active || item.status === "hidden") throw new Error("That product is no longer available.");
          if (diff > app.productAvailable(item)) throw new Error(`Only ${item.quantity + app.sellableQuantity(item)} items available.`);
          const changed = await tx.run("UPDATE products SET reserved = reserved + ? WHERE id = ? AND reserved + ? <= stock", diff, item.product_id, diff);
          if (!changed.changes) throw new Error(`Only ${item.quantity + app.sellableQuantity(item)} items available.`);
        } else if (diff < 0) await app.releaseReservedQuantity(item.product_id, -diff, tx);
        await tx.run("UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?", quantity, itemId, session.id);
      });
      if (outcome === "missing") return app.redirect(res, "/cart?notice=Cart+item+not+found."), true;
      app.redirect(res, outcome === "removed" ? "/cart?notice=Item+removed." : "/cart?notice=Cart+updated.");
    } catch (error) { app.redirect(res, `/cart?notice=${encodeURIComponent(error.message)}`); }
    return true;
  }
  return false;
};