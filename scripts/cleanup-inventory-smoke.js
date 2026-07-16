const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("data/store.db");

db.exec("BEGIN IMMEDIATE");
try {
  db.exec("DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 'inventory-smoke-%')");
  db.exec("UPDATE products SET reserved = 0, status = 'hidden', active = 0 WHERE slug LIKE 'inventory-smoke-%'");
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
