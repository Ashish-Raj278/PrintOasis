const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertRefundRecoveryBehavior } = require("./refund-recovery-regression");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for refund/recovery regression tests.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl });
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.REDIS_URL = "redis://127.0.0.1:6380";
  process.env.REDIS_PREFIX = `refund-recovery-test:${crypto.randomUUID()}`;
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.EMAIL_DELIVERY_ENABLED = "false";
  const { app, initDb } = require("../server");
  try {
    await initDb();
    const assertions = await assertRefundRecoveryBehavior({ app, prefix: `refund-recovery-${crypto.randomUUID()}` });
    process.stdout.write(`PASS isolated refund/recovery regression (${assertions} assertions). No live provider calls were made.\n`);
  } finally {
    await app.db.close();
  }
}

main().catch(error => {
  process.stderr.write(`Refund/recovery regression failed: ${error.message}\n`);
  process.exitCode = 1;
});
