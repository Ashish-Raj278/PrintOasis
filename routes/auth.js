module.exports = async function authRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  if (req.method === "GET" && url.pathname === "/login") { if (session.user) return app.redirect(res, "/account"); app.send(res, 200, await app.authPage("login", url, session, cart, app.requestOrigin(req))); return true; }
  if (req.method === "GET" && url.pathname === "/register") { if (session.user) return app.redirect(res, "/account"); app.send(res, 200, await app.authPage("register", url, session, cart, app.requestOrigin(req))); return true; }
  if (req.method === "GET" && url.pathname === "/admin/login") { if (session.user && app.isAdmin(session)) return app.redirect(res, "/admin"); app.send(res, 200, await app.authPage("login", new URL("/login?next=/admin", app.requestOrigin(req)), session, cart, app.requestOrigin(req))); return true; }
  if (req.method !== "POST") return false;
  if (url.pathname === "/auth/google") {
    const cookies = app.parseCookies(req);
    if (!data.g_csrf_token || !cookies.g_csrf_token || data.g_csrf_token !== cookies.g_csrf_token || !app.GOOGLE_CLIENT_ID) { app.redirect(res, `/login?notice=${encodeURIComponent("Google sign-in could not be verified.")}`); return true; }
    const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(data.credential || "")}`);
    const profile = await verification.json();
    if (!verification.ok || profile.aud !== app.GOOGLE_CLIENT_ID || profile.email_verified !== "true") { app.redirect(res, `/login?notice=${encodeURIComponent("Google account verification failed.")}`); return true; }
    let user = await app.db.get("SELECT * FROM users WHERE google_sub = ? OR email = ?", profile.sub, profile.email.toLowerCase());
    if (user) await app.db.run("UPDATE users SET google_sub = COALESCE(google_sub, ?) WHERE id = ?", profile.sub, user.id);
    else user = (await app.db.run("INSERT INTO users (name,email,password_hash,google_sub) VALUES (?,?,?,?) RETURNING id", profile.name || profile.email.split("@")[0], profile.email.toLowerCase(), app.hashPassword(app.crypto.randomBytes(32).toString("hex")), profile.sub)).rows[0];
    await app.updateSessionUser(session.id, user.id);
    app.redirect(res, "/account?notice=Signed+in+with+Google."); return true;
  }
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain"), true;
  if (url.pathname === "/register") {
    const name = (data.name || "").trim(), email = (data.email || "").trim().toLowerCase(), password = data.password || "";
    if (name.length < 2 || !email.includes("@") || password.length < 8) { app.redirect(res, `/register?notice=${encodeURIComponent("Please enter valid details. Password must be at least 8 characters.")}`); return true; }
    try {
      const result = await app.db.run("INSERT INTO users (name,email,password_hash) VALUES (?,?,?) RETURNING id", name, email, app.hashPassword(password));
      await app.updateSessionUser(session.id, result.rows[0].id);
      const next = data.next || "/account"; app.redirect(res, `${next}${next.includes("?") ? "&" : "?"}notice=${encodeURIComponent("Account created successfully.")}`);
    } catch (error) { if (error.code === "23505") app.redirect(res, `/login?notice=${encodeURIComponent("An account with that email already exists.")}`); else throw error; }
    return true;
  }
  if (url.pathname === "/login") { const user = await app.db.get("SELECT * FROM users WHERE email = ?", (data.email || "").trim().toLowerCase()); if (!user || !app.verifyPassword(data.password || "", user.password_hash)) { app.redirect(res, `/login?notice=${encodeURIComponent("Email or password is incorrect.")}&next=${encodeURIComponent(data.next || "/account")}`); return true; } await app.updateSessionUser(session.id, user.id); const next = data.next || "/account"; app.redirect(res, `${next}${next.includes("?") ? "&" : "?"}notice=${encodeURIComponent("Welcome back.")}`); return true; }
  if (url.pathname === "/logout") { await app.releaseSessionReservations(session.id); await app.updateSessionUser(session.id, null); app.redirect(res, `/?notice=${encodeURIComponent("You have been logged out.")}`); return true; }
  return false;
};
