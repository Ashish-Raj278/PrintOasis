const { logger } = require("../services/logger");

module.exports = async function authRoutes(ctx) {
  const { req, res, url, data, session, cart, app } = ctx;
  const nextPath = app.safeLocalPath(url.searchParams.get("next"), "/account");
  if (req.method === "GET" && url.pathname === "/login") {
    if (session.user) return app.redirect(res, "/account");
    const safeUrl = new URL(`/login?next=${encodeURIComponent(nextPath)}`, app.PUBLIC_BASE_URL);
    app.send(res, 200, await app.authPage("login", safeUrl, session, cart, app.requestOrigin(req))); return true;
  }
  if (req.method === "GET" && url.pathname === "/register") {
    if (session.user) return app.redirect(res, "/account");
    app.send(res, 200, await app.authPage("register", url, session, cart, app.requestOrigin(req))); return true;
  }
  if (req.method === "GET" && url.pathname === "/admin/login") {
    if (session.user && app.isAdmin(session)) return app.redirect(res, "/admin");
    app.send(res, 200, await app.authPage("login", new URL("/login?next=%2Fadmin", app.PUBLIC_BASE_URL), session, cart, app.requestOrigin(req))); return true;
  }
  if (req.method === "GET" && url.pathname === "/password/reset/request") {
    app.send(res, 200, await app.layout("Reset password", `<section class="auth-section"><div class="auth-card"><h1>Reset your password</h1><p>Enter your account email. If it matches an account, we will send a reset link.</p><form method="post" action="/password/reset/request"><input type="hidden" name="csrf" value="${app.esc(session.csrf)}"><label>Email address<input type="email" name="email" autocomplete="email" required></label><button class="button primary" type="submit">Send reset link</button></form></div></section>`, session, cart)); return true;
  }
  if (req.method === "GET" && url.pathname === "/password/reset") {
    const token = String(url.searchParams.get("token") || "");
    app.send(res, 200, await app.layout("Choose a new password", `<section class="auth-section"><div class="auth-card"><h1>Choose a new password</h1><form method="post" action="/password/reset"><input type="hidden" name="csrf" value="${app.esc(session.csrf)}"><input type="hidden" name="token" value="${app.esc(token)}"><label>New password<input type="password" name="password" minlength="8" autocomplete="new-password" required></label><label>Confirm new password<input type="password" name="confirm_password" minlength="8" autocomplete="new-password" required></label><button class="button primary" type="submit">Update password</button></form></div></section>`, session, cart)); return true;
  }
  if (req.method === "GET" && url.pathname === "/account/verify-email") {
    const token = String(url.searchParams.get("token") || "");
    app.send(res, 200, await app.layout("Verify email", `<section class="auth-section"><div class="auth-card"><h1>Verify your email</h1><p>Confirm the email address associated with your PrintOasis account.</p><form method="post" action="/account/verify-email"><input type="hidden" name="csrf" value="${app.esc(session.csrf)}"><input type="hidden" name="token" value="${app.esc(token)}"><button class="button primary" type="submit">Verify email</button></form></div></section>`, session, cart)); return true;
  }
  if (req.method !== "POST") return false;
  if (url.pathname === "/auth/google") {
    const cookies = app.parseCookies(req);
    if (!data.g_csrf_token || !cookies.g_csrf_token || data.g_csrf_token !== cookies.g_csrf_token || !app.GOOGLE_CLIENT_ID) { app.redirect(res, "/login?notice=Google+sign-in+could+not+be+verified."); return true; }
    const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(data.credential || "")}`);
    const profile = await verification.json();
    if (!verification.ok || profile.aud !== app.GOOGLE_CLIENT_ID || profile.email_verified !== "true" || !profile.sub || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(profile.email || ""))) { app.redirect(res, "/login?notice=Google+account+verification+failed."); return true; }
    const email = profile.email.toLowerCase();
    let user = await app.db.get("SELECT * FROM users WHERE google_sub = ? OR email = ?", profile.sub, email);
    if (user) {
      await app.db.run("UPDATE users SET google_sub=COALESCE(google_sub,?),email_verified=1 WHERE id=?", profile.sub, user.id);
    } else {
      user = (await app.db.run("INSERT INTO users (name,email,password_hash,google_sub,email_verified) VALUES (?,?,?,?,1) RETURNING id,is_admin", profile.name || email.split("@")[0], email, app.hashPassword(app.crypto.randomBytes(32).toString("hex")), profile.sub)).rows[0];
    }
    await app.rotateSession(req, res, session, user.id);
    app.redirect(res, "/account?notice=Signed+in+with+Google."); return true;
  }
  if (!app.validCsrf(data, session)) return app.send(res, 403, "Invalid form token", "text/plain; charset=utf-8"), true;

  if (url.pathname === "/password/reset/request") {
    const email = String(data.email || "").trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const user = await app.db.get("SELECT id,email FROM users WHERE email=?", email);
      if (user) await app.issueAccountToken(user, "password_reset");
    }
    app.redirect(res, "/login?notice=If+an+account+matches+that+email%2C+a+reset+link+will+be+sent."); return true;
  }

  if (url.pathname === "/password/reset") {
    const password = String(data.password || "");
    if (password.length < 8 || password !== String(data.confirm_password || "")) { app.redirect(res, "/password/reset?notice=Passwords+must+match+and+contain+at+least+8+characters."); return true; }
    const reset = await app.resetPasswordWithToken(String(data.token || ""), password);
    app.redirect(res, reset ? "/login?notice=Password+updated.+Please+sign+in." : "/login?notice=This+reset+link+is+invalid+or+expired."); return true;
  }

  if (url.pathname === "/account/verify-email") {
    const verified = await app.consumeEmailVerification(String(data.token || ""));
    app.redirect(res, verified ? "/login?notice=Email+verified.+You+can+sign+in." : "/login?notice=This+verification+link+is+invalid+or+expired."); return true;
  }

  if (url.pathname === "/register") {
    const name = String(data.name || "").trim(), email = String(data.email || "").trim().toLowerCase(), password = String(data.password || "");
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) { app.redirect(res, "/register?notice=Please+enter+valid+details.+Password+must+be+at+least+8+characters."); return true; }
    try {
      const result = await app.db.run("INSERT INTO users (name,email,password_hash,email_verified) VALUES (?,?,?,0) RETURNING id", name, email, app.hashPassword(password));
      const userId = result.rows[0].id;
      await app.issueAccountToken({ id: userId, email }, "email_verification");
      await app.rotateSession(req, res, session, userId);
      app.redirect(res, app.withNotice(app.safeLocalPath(data.next, "/account"), "Account created. Check your email to verify the address."));
    } catch (error) {
      if (error.code === "23505") app.redirect(res, "/login?notice=Please+sign+in+or+use+password+recovery+to+continue.");
      else throw error;
    }
    return true;
  }

  if (url.pathname === "/login") {
    const email = String(data.email || "").trim().toLowerCase();
    const user = await app.db.get("SELECT * FROM users WHERE email=?", email);
    if (!user || !app.verifyPassword(String(data.password || ""), user.password_hash)) {
      logger.warn("auth.login_rejected", { request_id: req.requestId });
      const safeNext = app.safeLocalPath(data.next, "/account");
      app.redirect(res, `/login?notice=${encodeURIComponent("Email or password is incorrect.")}&next=${encodeURIComponent(safeNext)}`); return true;
    }
    await app.rotateSession(req, res, session, user.id);
    app.redirect(res, app.withNotice(app.safeLocalPath(data.next, "/account"), "Welcome back.")); return true;
  }

  if (url.pathname === "/logout") {
    await app.revokeSession(session.id);
    app.clearSessionCookie(res);
    app.redirect(res, `/?notice=${encodeURIComponent("You have been logged out.")}`); return true;
  }
  return false;
};
