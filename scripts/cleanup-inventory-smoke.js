const { createDatabaseFromEnv } = require("../services/database");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for smoke cleanup.");
  assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.DATABASE_URL, testDatabaseUrl: process.env.TEST_DATABASE_URL });
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = createDatabaseFromEnv();
  try {
    await db.transaction(async tx => {
      await tx.run("DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 'inventory-smoke-%' OR slug LIKE 'pg-smoke-%')");
      await tx.run("UPDATE products SET reserved = 0, status = 'hidden', active = 0 WHERE slug LIKE 'inventory-smoke-%' OR slug LIKE 'pg-smoke-%'");
    });
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });