module.exports = async function cartRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/cart") return app.send(res, 200, app.cartPage(url, session, cart)), true;
  if (req.method !== "POST") return false;
  if (url.pathname === "/cart/add") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const product = app.db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(Number(data.product_id));
    if (!product) return app.send(res, 404, "Product not found", "text/plain"), true;
    const artwork = app.saveArtwork(data.files?.artwork_file);
    const quantity = Math.max(product.min_qty, Number(data.quantity) || product.min_qty);
    app.db.prepare(`INSERT INTO cart_items (session_id,product_id,quantity,size,material,print_option,artwork_note,artwork_original_name,artwork_stored_name,artwork_mime,artwork_size,unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(session.id, product.id, quantity, data.size, data.material, data.print_option, (data.artwork_note || "").slice(0, 500), artwork?.original || null, artwork?.stored || null, artwork?.mime || null, artwork?.size || null, product.price / product.min_qty);
    app.redirect(res, "/cart?notice=Product+added+to+your+cart.");
    return true;
  }
  if (url.pathname === "/cart/update") {
    if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
    const quantity = Number(data.quantity);
    if (quantity <= 0) app.db.prepare("DELETE FROM cart_items WHERE id = ? AND session_id = ?").run(Number(data.item_id), session.id);
    else app.db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?").run(quantity, Number(data.item_id), session.id);
    app.redirect(res, "/cart");
    return true;
  }
  return false;
};
