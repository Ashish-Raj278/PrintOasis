const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertProviderOrderBehavior } = require("./postgres-regression");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for provider-order regression tests.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl });

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.REDIS_URL = "redis://127.0.0.1:6380";
  process.env.REDIS_PREFIX = `provider-order-test:${crypto.randomUUID()}`;
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  const { app, initDb } = require("../server");
  try {
    await initDb();
    const assertions = await assertProviderOrderBehavior({ app, prefix: `provider-order-${crypto.randomUUID()}` });
    process.stdout.write(`PASS isolated provider-order regression (${assertions} assertions). No live provider calls were made.\n`);
  } finally {
    await app.db.close();
  }
}

main().catch(error => {
  process.stderr.write(`Provider-order regression failed: ${error.message}\n`);
  process.exitCode = 1;
});
