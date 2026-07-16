const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "data", "store.db"));

const stmt = db.prepare(`
UPDATE users
SET is_admin = 1
WHERE id = ?
`);

const result = stmt.run(1);

console.log(result);

const user = db.prepare(`
SELECT id, name, email, is_admin
FROM users
WHERE id = ?
`).get(1);

console.log(user);

db.close();