module.exports = async function authRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;

  if (req.method === "GET" && url.pathname === "/login") {
    if (session.user) return app.redirect(res, "/account");
    app.send(res, 200, app.authPage("login", url, session, cart, app.requestOrigin(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/register") {
    if (session.user) return app.redirect(res, "/account");
    app.send(res, 200, app.authPage("register", url, session, cart, app.requestOrigin(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/login") {
    if (session.user && app.isAdmin(session)) return app.redirect(res, "/admin");
    app.send(res, 200, app.authPage("login", new URL("/login?next=/admin", app.requestOrigin(req)), session, cart, app.requestOrigin(req)));
    return true;
  }

  if (req.method !== "POST") return false;

  if (url.pathname === "/auth/google") {
    const cookies = app.parseCookies(req);
    if (!data.g_csrf_token || !cookies.g_csrf_token || data.g_csrf_token !== cookies.g_csrf_token || !app.GOOGLE_CLIENT_ID) {
      app.redirect(res, `/login?notice=${encodeURIComponent("Google sign-in could not be verified.")}`);
      return true;
    }
    const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(data.credential || "")}`);
    const profile = await verification.json();
    if (!verification.ok || profile.aud !== app.GOOGLE_CLIENT_ID || profile.email_verified !== "true") {
      app.redirect(res, `/login?notice=${encodeURIComponent("Google account verification failed.")}`);
      return true;
    }
    let user = app.db.prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?").get(profile.sub, profile.email.toLowerCase());
    if (user) {
      app.db.prepare("UPDATE users SET google_sub = COALESCE(google_sub, ?) WHERE id = ?").run(profile.sub, user.id);
    } else {
      const result = app.db.prepare("INSERT INTO users (name,email,password_hash,google_sub) VALUES (?,?,?,?)")
        .run(profile.name || profile.email.split("@")[0], profile.email.toLowerCase(), app.hashPassword(app.crypto.randomBytes(32).toString("hex")), profile.sub);
      user = { id: Number(result.lastInsertRowid) };
    }
    app.db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(user.id, session.id);
    app.redirect(res, "/account?notice=Signed+in+with+Google.");
    return true;
  }

  if (!app.validCsrf(data, session)) {
    app.send(res, 403, "Invalid form token", "text/plain");
    return true;
  }
  if (url.pathname === "/register") {
    const name = (data.name || "").trim(), email = (data.email || "").trim().toLowerCase(), password = data.password || "";
    if (name.length < 2 || !email.includes("@") || password.length < 8) {
      app.redirect(res, `/register?notice=${encodeURIComponent("Please enter valid details. Password must be at least 8 characters.")}`);
      return true;
    }
    try {
      const result = app.db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run(name, email, app.hashPassword(password));
      app.db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(Number(result.lastInsertRowid), session.id);
      app.redirect(res, data.next || "/account");
    } catch (error) {
      if (String(error).includes("UNIQUE")) app.redirect(res, `/login?notice=${encodeURIComponent("An account with that email already exists.")}`);
      else throw error;
    }
    return true;
  }
  if (url.pathname === "/login") {
    const user = app.db.prepare("SELECT * FROM users WHERE email = ?").get((data.email || "").trim().toLowerCase());
    if (!user || !app.verifyPassword(data.password || "", user.password_hash)) {
      app.redirect(res, `/login?notice=${encodeURIComponent("Email or password is incorrect.")}&next=${encodeURIComponent(data.next || "/account")}`);
      return true;
    }
    app.db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(user.id, session.id);
    app.redirect(res, data.next || "/account");
    return true;
  }
  if (url.pathname === "/logout") {
    app.db.prepare("UPDATE sessions SET user_id = NULL WHERE id = ?").run(session.id);
    app.redirect(res, "/");
    return true;
  }
  return false;
};
