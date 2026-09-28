const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { errorContext, logger } = require("./logger");

function postgresPlaceholders(sql) {
  let index = 0;
  let quoted = false;
  let result = "";
  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position];
    if (character === "'") {
      if (quoted && sql[position + 1] === "'") {
        result += "''";
        position += 1;
        continue;
      }
      quoted = !quoted;
    }
    result += character === "?" && !quoted ? `$${++index}` : character;
  }
  return result;
}

function normalizeParams(params) {
  return params.map(value => value === undefined ? null : value);
}

class QueryClient {
  constructor(client) {
    this.client = client;
  }

  async query(sql, params = []) {
    return this.client.query(postgresPlaceholders(sql), normalizeParams(params));
  }

  async get(sql, ...params) {
    const result = await this.query(sql, params);
    return result.rows[0];
  }

  async all(sql, ...params) {
    const result = await this.query(sql, params);
    return result.rows;
  }

  async run(sql, ...params) {
    const result = await this.query(sql, params);
    return { changes: result.rowCount, rows: result.rows };
  }
}

class PostgresDatabase extends QueryClient {
  constructor(pool) {
    super(pool);
    this.pool = pool;
  }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new QueryClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error("postgresql.transaction_rollback_failed", errorContext(rollbackError, "postgresql"));
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

function createDatabaseFromEnv(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required. PrintOasis no longer starts against SQLite.");
  const ssl = env.PGSSL === "true" || env.NODE_ENV === "production"
    ? { rejectUnauthorized: env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined;
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl,
    max: Math.max(1, Number(env.PGPOOL_MAX || 10)),
    idleTimeoutMillis: Math.max(1000, Number(env.PGPOOL_IDLE_TIMEOUT_MS || 30000)),
    connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECT_TIMEOUT_MS || 5000))
  });
  pool.on("error", error => logger.error("postgresql.idle_client_error", errorContext(error, "postgresql")));
  return new PostgresDatabase(pool);
}

async function runMigrations(database, migrationDirectory = path.join(__dirname, "..", "migrations")) {
  await database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const migrations = fs.readdirSync(migrationDirectory).filter(file => /^\d+-.+\.sql$/.test(file)).sort();
  for (const name of migrations) {
    if (await database.get("SELECT name FROM schema_migrations WHERE name = ?", name)) continue;
    const sql = fs.readFileSync(path.join(migrationDirectory, name), "utf8");
    await database.transaction(async tx => {
      await tx.query(sql);
      await tx.run("INSERT INTO schema_migrations (name) VALUES (?)", name);
    });
  }
}

async function databaseHealth(database) {
  return (await database.get("SELECT 1 AS ok"))?.ok === 1;
}

module.exports = { createDatabaseFromEnv, runMigrations, databaseHealth, postgresPlaceholders };
