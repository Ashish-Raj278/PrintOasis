const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertCheckoutIntentBehavior } = require("./postgres-regression");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for checkout intent regression tests.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl });

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.REDIS_URL = "redis://127.0.0.1:6380";
  process.env.REDIS_PREFIX = `checkout-intent-test:${crypto.randomUUID()}`;
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  const { app, initDb } = require("../server");
  try {
    await initDb();
    const assertions = await assertCheckoutIntentBehavior({ app, prefix: `checkout-intent-${crypto.randomUUID()}` });
    process.stdout.write(`PASS isolated checkout-intent regression (${assertions} assertions).\n`);
  } finally {
    await app.db.close();
  }
}

main().catch(error => {
  process.stderr.write(`Checkout-intent regression failed: ${error.message}\n`);
  process.exitCode = 1;
});
