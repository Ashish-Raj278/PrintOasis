const assert = require("node:assert/strict");
const staticRoutes = require("../routes/static");
const { createEmailService, orderEmailTemplate } = require("../services/email");
const { attachRequestId, createLogger, errorContext, REQUEST_ID_PATTERN } = require("../services/logger");
const { getIsolatedCiDatabaseUrl } = require("./ci-migration-check");

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

async function checkHealth(databaseAvailable, redisAvailable, storageAvailable = true) {
  const result = {};
  const response = {
    setHeader() {},
    writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
    end(body) { result.body = String(body); }
  };
  const app = {
    db: {},
    async databaseHealth() { if (databaseAvailable instanceof Error) throw databaseAvailable; return databaseAvailable; },
    async redisHealth() { if (redisAvailable instanceof Error) throw redisAvailable; return redisAvailable; },
    async storageHealth() { if (storageAvailable instanceof Error) throw storageAvailable; return storageAvailable; },
    send(res, status, body, type) {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    }
  };
  await staticRoutes({ req: { method: "GET" }, res: response, url: new URL("http://localhost/healthz"), app });
  return result;
}

async function run() {
  const validRequest = { headers: { "x-request-id": "edge-req:42" } }, responseHeaders = {};
  const validRequestId = attachRequestId(validRequest, { setHeader(name, value) { responseHeaders[name] = value; } });
  equal(validRequestId, "edge-req:42", "A syntactically valid request ID is preserved.");
  equal(validRequest.requestId, validRequestId, "The validated request ID is attached to request context.");
  equal(responseHeaders["X-Request-Id"], validRequestId, "The response returns its correlated request ID.");
  const invalidRequestId = attachRequestId({ headers: { "x-request-id": `bad ${"x".repeat(200)}` } }, { setHeader() {} });
  equal(REQUEST_ID_PATTERN.test(invalidRequestId), true, "Invalid or oversized request IDs are replaced with a safe generated ID.");

  const logLines = [];
  const structuredLogger = createLogger(line => logLines.push(line));
  structuredLogger.error("request.failed", { request_id: validRequestId, error_code: "REDIS_UNAVAILABLE", dependency: "redis", password: "not-for-logs", recipient: "private@example.test" });
  const logRecord = JSON.parse(logLines[0]);
  equal(logRecord.severity, "error", "Structured logs include severity.");
  equal(logRecord.event, "request.failed", "Structured logs include a stable event name.");
  ok(Boolean(logRecord.timestamp), "Structured logs include a timestamp.");
  equal(Object.hasOwn(logRecord, "password"), false, "Unapproved secret fields are omitted from structured logs.");
  equal(Object.hasOwn(logRecord, "recipient"), false, "Unapproved personal fields are omitted from structured logs.");
  equal(errorContext(Object.assign(new Error("private detail"), { code: "REDIS_UNAVAILABLE" })).dependency, "redis", "Operational error classification exposes dependency type, not message text.");

  const ciMigrationEnv = {
    GITHUB_ACTIONS: "true",
    PRINTOASIS_CI_MIGRATION_CHECK: "1",
    TEST_DATABASE_URL: "postgresql://printoasis_ci:test-only@127.0.0.1:5433/printoasis_ci_test"
  };
  equal(new URL(getIsolatedCiDatabaseUrl(ciMigrationEnv)).hostname, "127.0.0.1", "CI migration guard accepts only its local PostgreSQL service target.");
  assert.throws(() => getIsolatedCiDatabaseUrl({ ...ciMigrationEnv, DATABASE_URL: "postgresql://not-used.invalid/db" }), /Production database variables/);
  assertions += 1;
  assert.throws(() => getIsolatedCiDatabaseUrl({ ...ciMigrationEnv, TEST_DATABASE_URL: "postgresql://user:pass@example.invalid/db" }), /does not match/);
  assertions += 1;
  assert.throws(() => getIsolatedCiDatabaseUrl({ ...ciMigrationEnv, GITHUB_ACTIONS: "false" }), /only run in its isolated workflow/);
  assertions += 1;

  let factoryCalls = 0;
  const disabled = createEmailService({ enabled: false, host: "smtp.invalid", from: "orders@example.invalid" }, () => {
    factoryCalls += 1;
    throw new Error("Disabled SMTP must not construct a transport.");
  });
  equal(disabled.configured, false, "Disabled SMTP is reported as unconfigured.");
  equal((await disabled.send({ to: "customer@example.invalid", subject: "Test", text: "Test" })).skipped, true, "Disabled email delivery is safely skipped.");
  equal(factoryCalls, 0, "Disabled SMTP does not construct a transport.");

  const noHost = createEmailService({ enabled: true, from: "orders@example.invalid" }, () => { factoryCalls += 1; });
  equal(noHost.configured, false, "Missing SMTP host leaves delivery unconfigured.");

  let transportConfig;
  const sent = [];
  const configured = createEmailService({ enabled: true, host: "smtp.example.invalid", port: 587, secure: false, user: "", pass: "", from: "orders@example.invalid" }, config => {
    factoryCalls += 1;
    transportConfig = config;
    return { async sendMail(message) { sent.push(message); return { messageId: "fake-message-id" }; } };
  });
  equal(configured.configured, true, "Complete SMTP host/sender configuration enables delivery.");
  equal(transportConfig.host, "smtp.example.invalid", "Transport receives the configured SMTP host.");
  equal(transportConfig.port, 587, "Transport receives the configured SMTP port.");
  equal(transportConfig.secure, false, "Transport receives explicit non-implicit-TLS mode.");
  equal(transportConfig.auth, undefined, "SMTP auth is omitted when credentials are not configured.");

  const emailLogLines = [];
  const testLogger = {
    info(event, fields) { emailLogLines.push({ severity: "info", event, ...fields }); },
    warn(event, fields) { emailLogLines.push({ severity: "warn", event, ...fields }); },
    error(event, fields) { emailLogLines.push({ severity: "error", event, ...fields }); }
  };
  const observedEmail = createEmailService({ enabled: true, host: "smtp.example.invalid", port: 587, secure: false, user: "", pass: "", from: "orders@example.invalid" }, config => ({
    async sendMail(message) { sent.push(message); return { messageId: "fake-message-id" }; }
  }), testLogger);
  try {
    const delivery = await observedEmail.send({ to: "qa@example.invalid", subject: "Order confirmation", text: "Order created", html: "<p>Order created</p>" });
    equal(delivery.delivered, true, "Successful SMTP response is reported as delivered.");
    equal(delivery.messageId, "fake-message-id", "Successful SMTP response preserves the provider message ID.");
    equal(sent[0].from, "orders@example.invalid", "Configured sender is applied to outgoing messages.");
    equal(sent[0].to, "qa@example.invalid", "Recipient is passed to the injected test transport.");

    const failing = createEmailService({ enabled: true, host: "smtp.example.invalid", port: 587, secure: false, from: "orders@example.invalid" }, () => ({
      async sendMail() { throw new Error("simulated SMTP unavailable"); }
    }), testLogger);
    const failed = await failing.send({ to: "qa@example.invalid", subject: "Reset", text: "Reset link" });
    equal(failed.delivered, false, "SMTP rejection is reported as a delivery failure.");
    equal(failed.error, "SMTP_DELIVERY_FAILED", "SMTP failure exposes only a stable safe code to its caller.");
    ok(emailLogLines.some(line => line.event === "email.delivery_failed" && line.dependency === "smtp"), "SMTP failure is observable without logging recipient or provider details.");
  } finally {
    emailLogLines.length = 0;
  }

  const order = {
    id: 77, order_number: "PO-OPS-77", customer_name: "QA <script>", total: 1250,
    status: "Shipped", courier_name: "Test Courier", tracking_number: "TRACK-77",
    tracking_url: "https://tracking.example.invalid/77", estimated_delivery: "2030-01-02"
  };
  const item = { product_id: 5, product_name: "Business Cards <b>", quantity: 2 };
  const emailArgs = { order, items: [item], baseUrl: "https://shop.example.invalid", money: amount => `INR ${amount}` };
  const shipping = orderEmailTemplate({ ...emailArgs, event: "shipping_update", note: "Dispatched" });
  ok(shipping.subject.includes(order.order_number), "Shipping email identifies the order.");
  ok(shipping.text.includes(order.tracking_number) && shipping.text.includes(order.tracking_url), "Shipping email includes tracking details.");
  ok(shipping.html.includes("&lt;script&gt;") && !shipping.html.includes("<script>"), "Order email HTML escapes customer-provided names.");
  const delivered = orderEmailTemplate({ ...emailArgs, event: "delivered" });
  ok(delivered.text.includes("Business Cards <b> x 2"), "Delivery email includes the immutable order-item summary.");
  const resetNotice = orderEmailTemplate({ ...emailArgs, event: "status_update", note: "Order received" });
  ok(resetNotice.subject.includes("Shipped"), "Order-status email reflects the supplied order state.");

  const healthy = await checkHealth(true, true);
  equal(healthy.status, 200, "Readiness returns 200 when PostgreSQL and Redis checks pass.");
  equal(healthy.body, "ok", "Healthy readiness response remains minimal.");
  const noDatabase = await checkHealth(false, true);
  equal(noDatabase.status, 503, "Readiness fails when PostgreSQL is unavailable.");
  equal(noDatabase.body, "service unavailable", "PostgreSQL failure response does not expose internals.");
  const noRedis = await checkHealth(true, false);
  equal(noRedis.status, 503, "Readiness fails when Redis is unavailable.");
  equal(noRedis.body, "service unavailable", "Redis failure response does not expose internals.");
  const noStorage = await checkHealth(true, true, false);
  equal(noStorage.status, 503, "Readiness fails when required object storage is unavailable.");
  equal(noStorage.body, "service unavailable", "Object-storage failure response does not expose internals.");
  const databaseError = await checkHealth(new Error("private database detail"), true);
  equal(databaseError.status, 503, "Readiness catches dependency errors.");
  equal(databaseError.body.includes("private database detail"), false, "Readiness never returns internal dependency errors.");

  console.log(`PASS Stage 6 operations regression: ${assertions} assertions. No SMTP network or real recipients used.`);
  return assertions;
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { run };
