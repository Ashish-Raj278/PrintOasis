module.exports = async function staticRoutes(ctx) {
  const { req, res, url, app } = ctx;
  if (url.pathname.startsWith("/public/")) return app.servePublic(req, res, url);
  if (url.pathname.startsWith("/uploads/product-images/")) return app.serveProductImage(req, res, url);
  if (req.method === "GET" && url.pathname === "/healthz") {
    try { const healthy = await app.databaseHealth(app.db); app.send(res, healthy ? 200 : 503, healthy ? "ok" : "database unavailable", "text/plain; charset=utf-8"); }
    catch { app.send(res, 503, "database unavailable", "text/plain; charset=utf-8"); }
    return true;
  }
  return false;
};