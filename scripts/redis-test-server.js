const fs = require("node:fs");
const path = require("node:path");
const { assertIsolatedSupabaseTestDatabase } = require("./database-isolation");
const { assertIsolatedRedisTestConfig } = require("../services/redis");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
if (process.env.REDIS_TEST_CHILD !== "1") throw new Error("This helper is only for isolated Redis regression tests.");
assertIsolatedSupabaseTestDatabase({ databaseUrl: process.env.PRODUCTION_DATABASE_URL, testDatabaseUrl: process.env.TEST_DATABASE_URL });
assertIsolatedRedisTestConfig({ redisUrl: process.env.PRODUCTION_REDIS_URL, testRedisUrl: process.env.TEST_REDIS_URL });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL = process.env.TEST_REDIS_URL;

const { server, start } = require("../server");
start().then(() => console.log(`REDIS_TEST_SERVER_READY:${server.address().port}`)).catch(() => { process.exitCode = 1; });
