const crypto = require("node:crypto");
const net = require("node:net");
const { createClient } = require("redis");
const { errorContext, logger } = require("./logger");

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

class RedisUnavailableError extends Error {
  constructor() {
    super("Shared session and rate-limit service is unavailable.");
    this.name = "RedisUnavailableError";
    this.code = "REDIS_UNAVAILABLE";
  }
}

function redisEndpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid Redis connection URL.`); }
  if (!new Set(["redis:", "rediss:"]).has(url.protocol) || !url.hostname) throw new Error(`${label} must use redis:// or rediss://.`);
  return { host: url.hostname.toLowerCase(), port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)), database: url.pathname || "/0" };
}

function assertIsolatedRedisTestConfig({ redisUrl, testRedisUrl }) {
  const production = redisEndpoint(redisUrl, "REDIS_URL");
  const test = redisEndpoint(testRedisUrl, "TEST_REDIS_URL");
  if (production.host === test.host && production.port === test.port) throw new Error("TEST_REDIS_URL must use a separate Redis endpoint from REDIS_URL.");
  return true;
}

function isIp(value) {
  const normalized = String(value || "").trim().replace(/^\[|\]$/g, "");
  return net.isIP(normalized) ? normalized : "";
}

function requestIp(req, trustedProxyHops = 0) {
  const socketIp = isIp(req.socket?.remoteAddress) || "unknown";
  const hops = Number(trustedProxyHops);
  if (!Number.isInteger(hops) || hops <= 0) return socketIp;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(isIp);
  if (forwarded.length < hops || forwarded.some(ip => !ip)) return socketIp;
  const chain = [...forwarded, socketIp];
  return chain[Math.max(0, chain.length - 1 - hops)];
}

function accountKey(value) {
  return crypto.createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex");
}

function requestLimitPolicies(req, pathname, data = {}, session = null, phase = "ip", trustedProxyHops = 0) {
  if (req.method !== "POST") return [];
  const ip = requestIp(req, trustedProxyHops);
  const userId = session?.user?.id;
  const sid = session?.id;
  const ipPolicy = (scope, limit, windowMs) => ({ scope, subject: `ip:${ip}`, limit, windowMs });
  const userPolicy = (scope, limit, windowMs) => ({ scope, subject: `${userId ? `user:${userId}` : `session:${sid || "anonymous"}`}:${ip}`, limit, windowMs });
  const isAdminMutation = pathname.startsWith("/admin/") && !["GET", "HEAD"].includes(req.method);
  let policies = [];
  if (pathname === "/login") policies = [ipPolicy("login", 20, 900000), { scope: "login-account", subject: `account:${accountKey(data.email)}`, limit: 8, windowMs: 900000 }];
  else if (pathname === "/register") policies = [ipPolicy("register", 10, 900000)];
  else if (pathname === "/auth/google") policies = [ipPolicy("google-auth", 20, 900000)];
  else if (pathname === "/account/password") policies = [ipPolicy("password-change", 10, 900000), userPolicy("password-change-user", 5, 900000)];
  else if (pathname === "/password/reset/request") policies = [ipPolicy("password-reset-request", 10, 900000), { scope: "password-reset-account", subject: `account:${accountKey(data.email)}`, limit: 5, windowMs: 900000 }];
  else if (pathname === "/password/reset") policies = [ipPolicy("password-reset-submit", 10, 900000), { scope: "password-reset-token", subject: `token:${accountKey(data.token)}`, limit: 5, windowMs: 900000 }];
  else if (pathname === "/account/verify-email") policies = [ipPolicy("email-verify", 10, 900000), { scope: "email-verify-token", subject: `token:${accountKey(data.token)}`, limit: 5, windowMs: 900000 }];
  else if (pathname === "/logout") policies = [ipPolicy("logout", 30, 900000), userPolicy("logout-session", 10, 900000)];
  else if (pathname === "/contact") policies = [ipPolicy("contact", 5, 600000)];
  else if (pathname === "/track") policies = [ipPolicy("tracking", 20, 600000)];
  else if (["/payment/create", "/payment/verify", "/payment/failed"].includes(pathname)) policies = [ipPolicy("payment", 20, 600000), userPolicy("payment-user", 20, 600000)];
  else if (isAdminMutation) {
    const productSave = pathname === "/admin/products/save";
    policies = [
      ipPolicy("admin-write", 60, 60000),
      ...(productSave ? [ipPolicy("admin-product-upload", 10, 600000)] : []),
      userPolicy(productSave ? "admin-product-upload-user" : "admin-write-user", productSave ? 10 : 60, productSave ? 600000 : 60000)
    ];
  }
  else if (pathname === "/cart/add") {
    const uploadAttempt = String(req.headers["content-type"] || "").toLowerCase().includes("multipart/form-data");
    policies = [ipPolicy("cart-write", 60, 60000), userPolicy("cart-write-user", 60, 60000),
      ...(uploadAttempt ? [ipPolicy("customer-artwork-upload", 5, 600000), userPolicy("customer-artwork-upload-session", 5, 600000)] : [])];
  }
  else if (["/cart/update", "/cart/remove", "/wishlist/move-to-cart", "/account/orders/reorder"].includes(pathname)) policies = [ipPolicy("cart-write", 60, 60000), userPolicy("cart-write-user", 60, 60000)];
  else if (pathname === "/checkout") policies = [ipPolicy("checkout", 10, 600000), userPolicy("checkout-user", 10, 600000)];
  if (phase === "ip") return policies.filter(policy => policy.subject.startsWith("ip:"));
  return policies.filter(policy => !policy.subject.startsWith("ip:"));
}

function createRedisService(env = process.env, clientOverride = null) {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is required; shared session storage cannot use an in-process fallback.");
  const endpoint = redisEndpoint(env.REDIS_URL, "REDIS_URL");
  const prefix = String(env.REDIS_PREFIX || "printoasis").trim().replace(/:+$/, "");
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(prefix)) throw new Error("REDIS_PREFIX contains unsupported characters.");
  const client = clientOverride || createClient({
    url: env.REDIS_URL,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: Math.max(1000, Number(env.REDIS_CONNECT_TIMEOUT_MS || 5000)),
      reconnectStrategy: retries => retries >= 5 ? new Error("Redis connection retries exhausted.") : Math.min(250 * (retries + 1), 1500)
    }
  });
  let connectionFailureLogged = false;
  client.on("error", error => {
    if (connectionFailureLogged) return;
    connectionFailureLogged = true;
    logger.error("redis.connection_failed", errorContext(error, "redis"));
  });
  client.on("ready", () => {
    if (!connectionFailureLogged) return;
    connectionFailureLogged = false;
    logger.info("redis.connection_restored", { dependency: "redis" });
  });
  const sessionKey = id => `${prefix}:session:${id}`;
  const rateKey = (scope, subject) => `${prefix}:rate:${scope}:${accountKey(subject)}`;

  async function command(work) {
    try { return await work(); } catch { throw new RedisUnavailableError(); }
  }
  return {
    client,
    prefix,
    async connect() {
      try { if (!client.isOpen) await client.connect(); }
      catch { throw new RedisUnavailableError(); }
      if (!client.isReady) throw new RedisUnavailableError();
    },
    async health() { try { return client.isReady && await client.ping() === "PONG"; } catch { return false; } },
    async close() { if (client.isOpen) { try { await client.quit(); } catch { client.destroy(); } } },
    async getSession(id) {
      const value = await command(() => client.get(sessionKey(id)));
      if (!value) return null;
      try { return JSON.parse(value); } catch { await command(() => client.del(sessionKey(id))); return null; }
    },
    async setSession(session) {
      const ttl = Number(session.expires_at) - Date.now();
      if (ttl <= 0) throw new RedisUnavailableError();
      await command(() => client.set(sessionKey(session.id), JSON.stringify({ id: session.id, user_id: session.user_id || null, csrf: session.csrf, expires_at: Number(session.expires_at) }), { PX: ttl }));
    },
    async deleteSession(id) { await command(() => client.del(sessionKey(id))); },
    async incrementRateLimit(policy) {
      const result = await command(() => client.eval(RATE_LIMIT_SCRIPT, { keys: [rateKey(policy.scope, policy.subject)], arguments: [String(policy.windowMs)] }));
      const count = Number(result?.[0]);
      const ttlMs = Math.max(1, Number(result?.[1]));
      return { allowed: count <= policy.limit, count, retryAfter: Math.max(1, Math.ceil(ttlMs / 1000)) };
    },
    async deleteRateLimit(policy) { await command(() => client.del(rateKey(policy.scope, policy.subject))); },
    endpoint
  };
}

module.exports = { RedisUnavailableError, assertIsolatedRedisTestConfig, createRedisService, requestIp, requestLimitPolicies };
