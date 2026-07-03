module.exports = async function staticRoutes(ctx) {
  const { req, res, url, app } = ctx;
  if (url.pathname.startsWith("/public/")) return app.servePublic(req, res, url);
  if (url.pathname.startsWith("/uploads/product-images/")) return app.serveProductImage(req, res, url);
  if (req.method === "GET" && url.pathname === "/healthz") {
    app.send(res, 200, "ok", "text/plain; charset=utf-8");
    return true;
  }
  return false;
};
