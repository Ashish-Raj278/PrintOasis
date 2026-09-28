const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDatabaseFromEnv, runMigrations, databaseHealth } = require("../services/database");
const { errorContext } = require("../services/logger");

function getIsolatedCiDatabaseUrl(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.PRINTOASIS_CI_MIGRATION_CHECK !== "1") {
    throw new Error("CI migration verification can only run in its isolated workflow step.");
  }
  if (env.DATABASE_URL || env.PRODUCTION_DATABASE_URL) {
    throw new Error("Production database variables must not be present in the CI migration process.");
  }
  if (!env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for CI migration verification.");

  const url = new URL(env.TEST_DATABASE_URL);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("CI migration target must be PostgreSQL.");
  }
  if (url.hostname !== "127.0.0.1" || url.port !== "5433" || url.pathname !== "/printoasis_ci_test" || url.username !== "printoasis_ci") {
    throw new Error("CI migration target does not match the disposable local PostgreSQL service.");
  }
  return url.toString();
}

async function run() {
  const connectionString = getIsolatedCiDatabaseUrl();
  const database = createDatabaseFromEnv({ DATABASE_URL: connectionString, NODE_ENV: "test" });
  const migrationDirectory = path.join(__dirname, "..", "migrations");
  const expectedMigrations = fs.readdirSync(migrationDirectory).filter(file => /^\d+-.+\.sql$/.test(file)).sort();

  try {
    await runMigrations(database, migrationDirectory);
    const firstRun = await database.all("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(firstRun.map(row => row.name), expectedMigrations, "Every repository migration applies to the clean CI database.");
    assert.equal(await databaseHealth(database), true, "The migrated CI database answers health queries.");

    await runMigrations(database, migrationDirectory);
    const secondRun = await database.all("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(secondRun.map(row => row.name), expectedMigrations, "A second migration pass is idempotent.");

    const requiredTables = ["users", "sessions", "products", "product_images", "orders", "order_items", "checkout_intents", "payments", "payment_webhook_events", "refunds"];
    const missingTables = [];
    for (const table of requiredTables) {
      if (!(await database.get("SELECT to_regclass(?) AS name", `public.${table}`))?.name) missingTables.push(table);
    }
    assert.deepEqual(missingTables, [], "Core application and payment-integrity tables exist after migration.");

    const constraints = await database.get("SELECT COUNT(*)::int AS count FROM pg_constraint WHERE contype IN ('f', 'u', 'c')");
    const indexes = await database.get("SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'");
    assert.ok(constraints.count > 0, "Migrations install database constraints.");
    assert.ok(indexes.count > 0, "Migrations install indexes.");
    console.log(`PASS isolated CI PostgreSQL migrations: ${expectedMigrations.length} migrations, repeatable, core schema and constraints verified.`);
  } finally {
    await database.close();
  }
}

if (require.main === module) run().catch(error => {
  console.error(JSON.stringify({ event: "ci.postgresql_migration_check_failed", ...errorContext(error, "postgresql") }));
  process.exitCode = 1;
});

module.exports = { getIsolatedCiDatabaseUrl, run };
