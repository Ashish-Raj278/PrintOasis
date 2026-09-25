const { createDatabaseFromEnv } = require("./services/database");

async function main() {
  const userId = Number(process.env.ADMIN_USER_ID || 1);
  if (!Number.isInteger(userId) || userId < 1) throw new Error("ADMIN_USER_ID must be a positive integer.");
  const db = createDatabaseFromEnv();
  try {
    const result = await db.run("UPDATE users SET is_admin = 1 WHERE id = ? RETURNING id, name, email, is_admin", userId);
    if (!result.rows[0]) throw new Error(`User ${userId} was not found.`);
    console.log(result.rows[0]);
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });