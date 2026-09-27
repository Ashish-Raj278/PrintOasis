const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertAuthTokenBehavior } = require("./auth-security-regression");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for auth/security schema tests.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl });
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.ADMIN_EMAIL = "auth-security-smoke-admin@example.test";
  process.env.ADMIN_PASSWORD = "AuthSecuritySmokeAdmin123!";
  process.env.EMAIL_DELIVERY_ENABLED = "false";
  const { app, initDb } = require("../server");
  const prefix = `auth-security-${crypto.randomUUID()}`;
  try {
    await initDb();
    const assertions = await assertAuthTokenBehavior({ app, prefix });
    process.stdout.write(`PASS isolated auth/security schema and token regression (${assertions} assertions).\n`);
  } finally {
    try { await app.db.run("DELETE FROM users WHERE email LIKE ?", `${prefix}%`); }
    finally { await app.db.close(); }
  }
}

main().catch(error => {
  process.stderr.write(`Auth/security regression failed: ${error.message}\n`);
  process.exitCode = 1;
});
