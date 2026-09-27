const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function checks() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); },
    deepEqual(actual, expected, message) { count += 1; assert.deepEqual(actual, expected, message); },
    match(value, pattern, message) { count += 1; assert.match(value, pattern, message); }
  };
}

function cookieId(cookie) { return String(cookie || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1] || ""; }

async function assertAuthSecurityBehavior({ app, get, post, csrf, prefix, admin, register: registerCustomer, createProduct }) {
  const c = checks();
  for (const [value, expected, label] of [
    ["/account", "/account", "Local redirect path is accepted."],
    ["https://external.example/path", "/", "Absolute external redirect is rejected."],
    ["//external.example/path", "/", "Protocol-relative redirect is rejected."],
    ["javascript:alert(1)", "/", "Dangerous redirect scheme is rejected."],
    ["/%zz", "/", "Malformed redirect is rejected."],
    ["/orders?q=1#latest", "/orders?q=1#latest", "Local query and fragment are preserved."]
  ]) c.equal(app.safeLocalPath(value), expected, label);
  c.equal(app.canonicalOrigin("https://shop.example"), "https://shop.example", "Explicit canonical HTTPS origin is normalized.");
  c.equal(app.requestOrigin({ headers: { host: "attacker.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } }), app.PUBLIC_BASE_URL, "Untrusted Host and forwarded headers cannot alter canonical links.");

  const landing = await get("/login?next=https%3A%2F%2Fevil.example");
  c.match(landing.html, /name="next" value="\/account"/, "Unsafe next parameter is normalized in the login form.");
  c.match(landing.response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/, "CSP prevents framing.");
  c.equal(landing.response.headers.get("x-content-type-options"), "nosniff", "MIME sniffing is disabled.");
  c.equal(landing.response.headers.get("referrer-policy"), "no-referrer", "Sensitive token URLs are not sent as referrers.");
  c.equal(landing.response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()", "Unused browser capabilities are disabled.");
  c.equal(landing.response.headers.get("strict-transport-security"), null, "HTTP/test origin does not receive HSTS.");
  const cookieFlags = landing.response.headers.get("set-cookie") || "";
  c.match(cookieFlags, /HttpOnly; SameSite=Lax/, "Session cookie remains HttpOnly and SameSite=Lax.");
  c.equal(/; Secure(?:;|$)/.test(cookieFlags), app.PUBLIC_BASE_URL.startsWith("https://"), "Secure cookie follows the configured canonical HTTPS origin, not forwarded headers.");
  c.equal((await post("/login", { email: `${prefix}-missing@example.test`, password: "Testing123!" }, landing.cookie)).response.status, 403, "Login mutation requires CSRF.");

  const product = await createProduct(admin, `${prefix}-rotation`, 5);
  const registerPage = await get("/register");
  const oldId = cookieId(registerPage.cookie);
  const productPage = await get(`/product/${product.slug}`, registerPage.cookie);
  await post("/cart/add", { csrf: csrf(productPage.html), product_id: product.id, quantity: "2", size: "A4", material: "Matte", print_option: "Full color" }, productPage.cookie);
  const before = await app.db.get("SELECT stock,reserved FROM products WHERE id=?", product.id);
  const register = await post("/register", { csrf: csrf(productPage.html), name: "Rotation Customer", email: `${prefix}-rotation@example.test`, password: "Testing123!", next: "https://evil.example" }, productPage.cookie);
  const newId = cookieId(register.cookie);
  c.equal(register.response.status, 303, "Registration establishes the account.");
  c.ok(oldId && newId && oldId !== newId, "Registration rotates the anonymous session identifier.");
  c.equal(await app.db.get("SELECT id FROM sessions WHERE id=?", oldId), undefined, "Pre-registration session anchor is revoked.");
  c.equal(Number((await app.db.get("SELECT user_id FROM sessions WHERE id=?", newId)).user_id) > 0, true, "Rotated session remains authenticated.");
  c.equal(register.response.headers.get("location")?.includes("evil.example"), false, "Registration redirect ignores external next targets.");
  c.equal(Number((await app.db.get("SELECT SUM(quantity) AS quantity FROM cart_items WHERE session_id=?", newId)).quantity), 2, "Cart rows transfer to the new authenticated session.");
  const after = await app.db.get("SELECT stock,reserved FROM products WHERE id=?", product.id);
  c.deepEqual({ stock: Number(after.stock), reserved: Number(after.reserved) }, { stock: Number(before.stock), reserved: Number(before.reserved) }, "Rotation preserves reservation exactly without re-reserving.");
  c.equal((await get("/account", registerPage.cookie)).response.status, 303, "Old session ID cannot authenticate after registration rotation.");
  const verifyToken = await app.db.get("SELECT token_hash FROM account_tokens WHERE user_id=(SELECT id FROM users WHERE email=?) AND purpose='email_verification'", `${prefix}-rotation@example.test`);
  c.ok(verifyToken?.token_hash, "Registration creates durable email-verification token hash.");

  const accountPage = await get("/account", register.cookie);
  const noCsrfLogout = await post("/logout", {}, register.cookie);
  c.equal(noCsrfLogout.response.status, 403, "Logout remains CSRF-protected.");
  const logout = await post("/logout", { csrf: csrf(accountPage.html) }, register.cookie);
  c.equal(logout.response.status, 303, "Logout succeeds with a valid CSRF token.");
  c.equal(await app.db.get("SELECT id FROM sessions WHERE id=?", newId), undefined, "Logout deletes the durable session anchor.");
  c.equal((await get("/account", register.cookie)).response.status, 303, "Revoked session cannot authenticate after logout.");
  const released = await app.db.get("SELECT reserved FROM products WHERE id=?", product.id);
  c.equal(Number(released.reserved), 0, "Logout releases the rotated session's reservation once.");

  const loginPage = await get("/login?next=%2Faccount", logout.cookie);
  const preLoginId = cookieId(loginPage.cookie);
  const loginResult = await post("/login", { csrf: csrf(loginPage.html), email: `${prefix}-rotation@example.test`, password: "Testing123!", next: "/account" }, loginPage.cookie);
  const postLoginId = cookieId(loginResult.cookie);
  c.ok(preLoginId && postLoginId && preLoginId !== postLoginId, "Successful login rotates the session identifier.");
  c.equal((await get("/account", loginResult.cookie)).response.status, 200, "Authentication survives login session rotation.");
  c.equal((await get("/account", loginPage.cookie)).response.status, 303, "Pre-login identifier cannot authenticate after rotation.");

  const expiredSession = await get("/");
  const expiredId = cookieId(expiredSession.cookie);
  await app.db.run("UPDATE sessions SET expires_at=0 WHERE id=?", expiredId);
  c.equal((await get("/account", expiredSession.cookie)).response.status, 303, "Expired session is rejected by protected account routes.");
  c.equal(await app.db.get("SELECT id FROM sessions WHERE id=?", expiredId), undefined, "Expired session anchor is removed during cleanup.");

  const tokenUser = await app.db.get("INSERT INTO users (name,email,password_hash,email_verified) VALUES (?,?,?,0) RETURNING id,email", "Recovery User", `${prefix}-recovery@example.test`, app.hashPassword("Testing123!"));
  let verificationMessage, resetMessage;
  await app.issueAccountToken(tokenUser, "email_verification", async message => { verificationMessage = message; return { delivered: true }; });
  const verificationToken = new URL(verificationMessage.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const savedVerification = await app.db.get("SELECT token_hash,expires_at FROM account_tokens WHERE user_id=? AND purpose='email_verification'", tokenUser.id);
  c.ok(savedVerification.token_hash !== verificationToken && savedVerification.token_hash.length === 64, "Verification token is stored only as a SHA-256 hash.");
  c.equal(await app.consumeEmailVerification(verificationToken), true, "Valid email-verification token is accepted.");
  c.equal(Number((await app.db.get("SELECT email_verified FROM users WHERE id=?", tokenUser.id)).email_verified), 1, "Verification marks the account verified.");
  c.equal(await app.consumeEmailVerification(verificationToken), false, "Email-verification token is single-use.");
  await app.issueAccountToken(tokenUser, "email_verification", async message => { verificationMessage = message; return { delivered: true }; });
  const expiredVerification = new URL(verificationMessage.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  await app.db.run("UPDATE account_tokens SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE token_hash=?", require("node:crypto").createHash("sha256").update(expiredVerification).digest("hex"));
  c.equal(await app.consumeEmailVerification(expiredVerification), false, "Expired verification token is rejected.");
  c.equal(await app.consumeEmailVerification("not-a-valid-token"), false, "Unknown verification token is rejected.");

  const recoverySessions = [`${prefix}-recovery-a`, `${prefix}-recovery-b`];
  for (const id of recoverySessions) {
    const session = { id, user_id: tokenUser.id, csrf: "test-csrf", expires_at: Date.now() + 3600000 };
    await app.db.run("INSERT INTO sessions (id,user_id,csrf,expires_at) VALUES (?,?,?,?)", id, tokenUser.id, session.csrf, session.expires_at);
    await app.redisService().setSession(session);
  }
  await app.issueAccountToken(tokenUser, "password_reset", async message => { resetMessage = message; return { delivered: true }; });
  const resetToken = new URL(resetMessage.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const savedReset = await app.db.get("SELECT token_hash FROM account_tokens WHERE user_id=? AND purpose='password_reset'", tokenUser.id);
  c.ok(savedReset.token_hash !== resetToken, "Password-reset token is stored only as a hash.");
  c.equal(await app.resetPasswordWithToken("unknown-token", "Testing456!"), false, "Unknown reset token is rejected.");
  c.equal(await app.resetPasswordWithToken(resetToken, "Testing456!"), true, "Valid reset token changes the password.");
  c.equal(app.verifyPassword("Testing456!", (await app.db.get("SELECT password_hash FROM users WHERE id=?", tokenUser.id)).password_hash), true, "Reset password is persisted with the existing password hashing scheme.");
  c.equal(await app.resetPasswordWithToken(resetToken, "Testing789!"), false, "Password-reset token is single-use.");
  for (const id of recoverySessions) {
    c.equal(await app.db.get("SELECT id FROM sessions WHERE id=?", id), undefined, "Password reset invalidates every authenticated session.");
    c.equal(await app.redisService().getSession(id), null, "Password reset removes Redis session payloads.");
  }

  const resetRequestPage = await get("/password/reset/request");
  c.equal((await post("/password/reset/request", { email: tokenUser.email }, resetRequestPage.cookie)).response.status, 403, "Password-reset request requires CSRF.");
  const known = await post("/password/reset/request", { csrf: csrf(resetRequestPage.html), email: tokenUser.email }, resetRequestPage.cookie);
  const unknown = await post("/password/reset/request", { csrf: csrf(resetRequestPage.html), email: `${prefix}-missing@example.test` }, resetRequestPage.cookie);
  c.equal(known.response.status, unknown.response.status, "Reset request status does not reveal account existence.");
  c.equal(known.response.headers.get("location"), unknown.response.headers.get("location"), "Reset request redirect does not reveal account existence.");
  const resetForm = await get(`/password/reset?token=${encodeURIComponent(resetToken)}`);
  c.equal((await post("/password/reset", { token: resetToken, password: "Testing789!", confirm_password: "Testing789!" }, resetForm.cookie)).response.status, 403, "Password-reset submission requires CSRF.");
  let resetSubmitLimited;
  for (let attempt = 0; attempt < 6; attempt += 1) resetSubmitLimited = await post("/password/reset", { csrf: csrf(resetForm.html), token: "rate-limited-reset-token", password: "Testing789!", confirm_password: "Testing789!" }, resetForm.cookie);
  c.equal(resetSubmitLimited.response.status, 429, "Password-reset submissions are rate limited.");
  const verifyPage = await get("/account/verify-email?token=invalid-rate-token");
  c.equal((await post("/account/verify-email", { token: "invalid-rate-token" }, verifyPage.cookie)).response.status, 403, "Email-verification mutation requires CSRF.");
  let verificationLimited;
  for (let attempt = 0; attempt < 6; attempt += 1) verificationLimited = await post("/account/verify-email", { csrf: csrf(verifyPage.html), token: "rate-limited-verify-token" }, verifyPage.cookie);
  c.equal(verificationLimited.response.status, 429, "Email-verification attempts are rate limited.");
  const rateEmail = `${prefix}-reset-rate@example.test`;
  let rateResponse;
  for (let attempt = 0; attempt < 6; attempt += 1) rateResponse = await post("/password/reset/request", { csrf: csrf(resetRequestPage.html), email: rateEmail }, resetRequestPage.cookie);
  c.equal(rateResponse.response.status, 429, "Password-reset request is rate limited by account and IP.");
  c.ok(rateResponse.response.headers.get("retry-after"), "Reset rate-limit response includes retry timing.");

  const sessionA = await registerCustomer("Password Change User", `${prefix}-password@example.test`);
  const loginPageB = await get("/login");
  const sessionBResult = await post("/login", { csrf: csrf(loginPageB.html), email: `${prefix}-password@example.test`, password: "Testing123!" }, loginPageB.cookie);
  const sessionB = sessionBResult.cookie;
  c.ok(cookieId(sessionA) !== cookieId(sessionB), "Separate login establishes a distinct authenticated session.");
  const currentPasswordPage = await get("/account/password", sessionA);
  const changed = await post("/account/password", { csrf: csrf(currentPasswordPage.html), current_password: "Testing123!", new_password: "Testing456!", confirm_password: "Testing456!" }, currentPasswordPage.cookie);
  c.equal(changed.response.status, 303, "Password change succeeds with CSRF and current password.");
  c.equal((await get("/account", sessionB)).response.status, 303, "Password change revokes other authenticated sessions.");
  c.equal((await get("/account", sessionA)).response.status, 200, "Password change preserves the current authenticated session.");
  c.ok(await app.db.get("SELECT id FROM users WHERE email=?", `${prefix}-password@example.test`), "Password-change fixture is persisted.");
  return c.count;
}

async function assertAuthTokenBehavior({ app, prefix }) {
  const c = checks();
  c.equal(app.safeLocalPath("/account"), "/account", "Safe internal redirects remain available.");
  for (const unsafe of ["https://elsewhere.example", "//elsewhere.example", "javascript:alert(1)", "/%zz"]) c.equal(app.safeLocalPath(unsafe), "/", "Unsafe redirect target is rejected.");
  c.equal(app.canonicalOrigin("https://shop.example"), "https://shop.example", "Canonical HTTPS origin is accepted.");
  c.equal(app.requestOrigin({ headers: { host: "attacker.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } }), app.PUBLIC_BASE_URL, "Untrusted origin headers cannot affect generated links.");
  const responseHeaders = new Map();
  app.setSecurityHeaders({ setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value) });
  c.ok(responseHeaders.get("content-security-policy").includes("frame-ancestors 'none'"), "CSP blocks framing while retaining configured app resources.");
  c.ok(responseHeaders.get("content-security-policy").includes("https://accounts.google.com") && responseHeaders.get("content-security-policy").includes("https://checkout.razorpay.com"), "CSP allows the configured Google and Razorpay integrations.");
  c.equal(responseHeaders.get("x-content-type-options"), "nosniff", "Security headers disable MIME sniffing.");
  c.equal(responseHeaders.get("referrer-policy"), "no-referrer", "Security headers prevent token referrer leakage.");
  c.equal(responseHeaders.get("permissions-policy"), "camera=(), microphone=(), geolocation=()", "Unused browser permissions are disabled.");
  c.equal(responseHeaders.has("strict-transport-security"), false, "HSTS is not emitted in test/non-production mode.");
  c.ok(await app.db.get("SELECT name FROM schema_migrations WHERE name='005-auth-security.sql'"), "Auth/security migration is recorded.");
  c.ok(await app.db.get("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='email_verified'"), "User email-verification field exists.");
  c.ok(await app.db.get("SELECT to_regclass('public.account_tokens') AS name"), "Durable account token table exists.");
  c.ok(await app.db.get("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_account_tokens_expiry'"), "Token expiry index exists.");
  const user = await app.db.get("INSERT INTO users (name,email,password_hash,email_verified) VALUES (?,?,?,0) RETURNING id,email", "Token Regression", `${prefix}-tokens@example.test`, app.hashPassword("Testing123!"));
  let message;
  await app.issueAccountToken(user, "email_verification", async value => { message = value; return { delivered: true }; });
  const verificationToken = new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const verificationHash = crypto.createHash("sha256").update(verificationToken).digest("hex");
  c.equal(verificationToken.length, 43, "Verification token has 256 bits of random entropy.");
  c.equal((await app.db.get("SELECT token_hash FROM account_tokens WHERE user_id=? AND purpose='email_verification'", user.id)).token_hash, verificationHash, "Only token hash is persisted.");
  await assert.rejects(app.db.run("INSERT INTO account_tokens (user_id,purpose,token_hash,expires_at) VALUES (?,'email_verification',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')", user.id, verificationHash), error => error.code === "23505");
  c.ok(true, "Database rejects duplicate account-token hashes.");
  c.equal(await app.consumeEmailVerification(verificationToken), true, "Unexpired verification token is accepted.");
  c.equal(await app.consumeEmailVerification(verificationToken), false, "Verification token cannot be reused.");
  c.equal(Number((await app.db.get("SELECT email_verified FROM users WHERE id=?", user.id)).email_verified), 1, "Email verification updates account state.");
  await app.issueAccountToken(user, "email_verification", async value => { message = value; return { delivered: true }; });
  const expiredVerificationToken = new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const expiredVerificationHash = crypto.createHash("sha256").update(expiredVerificationToken).digest("hex");
  await app.db.run("UPDATE account_tokens SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE token_hash=?", expiredVerificationHash);
  c.equal(await app.consumeEmailVerification(expiredVerificationToken), false, "Expired verification token is rejected.");
  c.equal(await app.consumeEmailVerification("unknown-token"), false, "Unknown verification token is rejected.");

  await app.issueAccountToken(user, "password_reset", async value => { message = value; return { delivered: true }; });
  const expiredResetToken = new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const expiredResetHash = crypto.createHash("sha256").update(expiredResetToken).digest("hex");
  await app.db.run("UPDATE account_tokens SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE token_hash=?", expiredResetHash);
  c.equal(await app.resetPasswordWithToken(expiredResetToken, "Testing456!"), false, "Expired password-reset token is rejected.");
  await app.issueAccountToken(user, "password_reset", async value => { message = value; return { delivered: true }; });
  const resetToken = new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const resetHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  c.equal((await app.db.get("SELECT token_hash FROM account_tokens WHERE user_id=? AND purpose='password_reset' AND used_at IS NULL", user.id)).token_hash, resetHash, "Reset token is persisted as a hash.");
  c.equal(await app.resetPasswordWithToken(resetToken, "Testing456!"), true, "Valid reset token changes the password.");
  c.equal(app.verifyPassword("Testing456!", (await app.db.get("SELECT password_hash FROM users WHERE id=?", user.id)).password_hash), true, "Reset uses the existing password-hashing mechanism.");
  c.equal(await app.resetPasswordWithToken(resetToken, "Testing789!"), false, "Reset token cannot be reused.");

  await assert.rejects(app.db.run("INSERT INTO account_tokens (user_id,purpose,token_hash,expires_at) VALUES (?,?,?,CURRENT_TIMESTAMP+INTERVAL '1 hour')", user.id, "unknown-purpose", crypto.randomBytes(32).toString("hex")), error => error.code === "23514");
  c.ok(true, "Database rejects unsupported account-token purposes.");
  await app.db.run("DELETE FROM users WHERE id=?", user.id);
  return c.count;
}

module.exports = { assertAuthSecurityBehavior, assertAuthTokenBehavior };
