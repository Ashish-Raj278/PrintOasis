const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assertIsolatedRedisTestConfig, createRedisService, requestIp } = require("../services/redis");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

async function main() {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required; Redis checks will not use REDIS_URL.");
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required to verify test/production Redis endpoint separation.");
  if (!process.env.TEST_REDIS_PREFIX || !/^[A-Za-z0-9:_-]{1,80}$/.test(process.env.TEST_REDIS_PREFIX)) throw new Error("TEST_REDIS_PREFIX must be configured with a safe test-only namespace.");
  assertIsolatedRedisTestConfig({ redisUrl: process.env.REDIS_URL, testRedisUrl: process.env.TEST_REDIS_URL });
  const prefix = `${process.env.TEST_REDIS_PREFIX}:unit:${process.pid}:${Date.now()}`;
  const env = { ...process.env, REDIS_URL: process.env.TEST_REDIS_URL, REDIS_PREFIX: prefix };
  const first = createRedisService(env);
  const second = createRedisService(env);
  let assertions = 0;
  try {
    await Promise.all([first.connect(), second.connect()]);
    const session = { id: `redis-test-${process.pid}-${Date.now()}`, user_id: 42, csrf: "test-csrf-token", expires_at: Date.now() + 60000 };
    await first.setSession(session);
    assert.deepEqual(await second.getSession(session.id), session, "Independent Redis clients must share session state."); assertions += 1;
    await second.deleteSession(session.id);
    assert.equal(await first.getSession(session.id), null, "Session deletion must be visible across Redis clients."); assertions += 1;

    const concurrentPolicy = { scope: "parallel", subject: `test:${session.id}`, limit: 5, windowMs: 60000 };
    const results = await Promise.all(Array.from({ length: 24 }, () => first.incrementRateLimit(concurrentPolicy)));
    assert.equal(results.filter(result => result.allowed).length, 5, "Atomic rate limiting must enforce the limit during concurrent requests."); assertions += 1;

    const expiryPolicy = { scope: "expiry", subject: `test:${session.id}`, limit: 1, windowMs: 1200 };
    assert.equal((await first.incrementRateLimit(expiryPolicy)).allowed, true); assertions += 1;
    assert.equal((await first.incrementRateLimit(expiryPolicy)).allowed, false); assertions += 1;
    await new Promise(resolve => setTimeout(resolve, 1350));
    assert.equal((await first.incrementRateLimit(expiryPolicy)).allowed, true, "Expired rate windows must reset."); assertions += 1;

    const fake = { isOpen: true, isReady: true, on() {}, async eval() { throw new Error("simulated disconnect"); } };
    const unavailable = createRedisService({ REDIS_URL: "redis://127.0.0.1:6379", REDIS_PREFIX: "failure-test" }, fake);
    await assert.rejects(unavailable.incrementRateLimit({ scope: "fail", subject: "x", limit: 1, windowMs: 1000 }), error => error.code === "REDIS_UNAVAILABLE"); assertions += 1;
    fake.get = async () => { throw new Error("simulated disconnect"); };
    await assert.rejects(unavailable.getSession("missing"), error => error.code === "REDIS_UNAVAILABLE"); assertions += 1;
    assert.equal(requestIp({ method: "POST", socket: { remoteAddress: "192.0.2.10" }, headers: { "x-forwarded-for": "198.51.100.22" } }, 0), "192.0.2.10", "Forwarded IP is ignored by default."); assertions += 1;
    assert.equal(requestIp({ method: "POST", socket: { remoteAddress: "192.0.2.10" }, headers: { "x-forwarded-for": "198.51.100.22, 203.0.113.5" } }, 1), "203.0.113.5", "Configured proxy hops select the rightmost proxy-provided client chain entry."); assertions += 1;
    console.log(`PASS isolated Redis service regression (${assertions} assertions).`);
  } finally {
    const client = first.client;
    let pending = [];
    for await (const keys of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      pending.push(...keys);
      if (pending.length >= 100) { await client.del(pending); pending = []; }
    }
    if (pending.length) await client.del(pending);
    await Promise.all([first.close(), second.close()]);
  }
}

main().catch(error => { console.error(error.code === "REDIS_UNAVAILABLE" ? error.message : error); process.exitCode = 1; });
