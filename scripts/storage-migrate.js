const fs = require("node:fs");
const path = require("node:path");
const { createDatabaseFromEnv } = require("../services/database");
const { createObjectStorageFromEnv } = require("../services/object-storage");
const { auditStorageReferences, migrateStorageReferences } = require("../services/storage-migration");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  process.stdout.write("Usage: node scripts/storage-migrate.js [--dry-run | --execute | --audit]\n");
  process.exit(0);
}
const modes = ["--dry-run", "--execute", "--audit"].filter(mode => args.has(mode));
if (modes.length > 1 || process.argv.slice(2).some(arg => !["--dry-run", "--execute", "--audit"].includes(arg))) {
  throw new Error("Choose exactly one supported storage migration mode.");
}
if (process.env.OBJECT_STORAGE_BACKEND !== "s3") throw new Error("Set OBJECT_STORAGE_BACKEND=s3 with isolated or approved storage configuration before running this tool.");

async function main() {
  const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
  let db, storage;
  try {
    db = createDatabaseFromEnv();
    storage = createObjectStorageFromEnv(process.env, {
      artworkDirectory: path.join(dataDirectory, "uploads"),
      productImageDirectory: path.join(dataDirectory, "uploads", "product-images")
    });
    if (args.has("--audit")) {
      const result = await auditStorageReferences({ db, storage });
      process.stdout.write(`Storage audit: ${JSON.stringify(result)}\n`);
      if (result.missingObjects) process.exitCode = 2;
      return;
    }
    const dryRun = !args.has("--execute");
    const result = await migrateStorageReferences({
      db,
      storage,
      roots: { artwork: path.join(dataDirectory, "uploads"), productImages: path.join(dataDirectory, "uploads", "product-images") },
      dryRun
    });
    process.stdout.write(`Storage migration ${dryRun ? "dry-run" : "execution"}: ${JSON.stringify(result)}\n`);
    if (result.missingLocalAndRemote || result.unverified || result.failed) process.exitCode = 2;
  } finally {
    if (storage) await storage.close();
    if (db) await db.close();
  }
}

main().catch(error => {
  process.stderr.write(`Storage migration stopped safely: ${error.code === "OBJECT_STORAGE_UNAVAILABLE" ? "object storage is unavailable" : error.code || "operation failed"}\n`);
  process.exitCode = 1;
});
