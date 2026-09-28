const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createLocalObjectStorage, createObjectStorageFromEnv, objectKey, ObjectStorageError } = require("../services/object-storage");
const { auditStorageReferences, migrateStorageReferences } = require("../services/storage-migration");
const uploadSecurity = require("../services/upload-security");
const cartRoute = require("../routes/cart");

let assertions = 0;
function check(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function rejects(work, message) { assertions += 1; return assert.rejects(work, message); }
function throws(work, message) { assertions += 1; assert.throws(work, message); }

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
function pngFixture() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function memoryDb(initialRows) {
  const state = { rows: initialRows, failUpdates: false };
  return {
    state,
    async all() { return state.rows; },
    async transaction(work) {
      return work({
        async run(sql, next, previous) {
          if (state.failUpdates) throw new Error("fixture database failure");
          let changes = 0;
          state.rows = state.rows.map(row => {
            const field = row.kind === "artwork" ? "stored_name" : "stored_name";
            if (row[field] === previous && sql.includes(row.kind === "artwork" ? "artwork_stored_name" : "image_stored_name")) {
              changes += 1;
              return { ...row, stored_name: next };
            }
            return row;
          });
          return { changes };
        }
      });
    }
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "printoasis-storage-"));
  const localRoots = {
    artworkDirectory: path.join(root, "local-source", "uploads"),
    productImageDirectory: path.join(root, "local-source", "uploads", "product-images")
  };
  const objectRoots = {
    artworkDirectory: path.join(root, "shared", "private"),
    productImageDirectory: path.join(root, "shared", "public")
  };
  const storageA = createLocalObjectStorage(objectRoots);
  const storageB = createLocalObjectStorage(objectRoots);
  try {
    const artName = `1700000000000-${"a".repeat(32)}.png`;
    const imageName = `1700000000000-${"b".repeat(32)}.png`;
    const bytes = pngFixture();
    const validImage = uploadSecurity.validateUpload({ filename: artName, data: bytes }, "artwork", uploadSecurity.ARTWORK_LIMIT);
    await fs.mkdir(localRoots.productImageDirectory, { recursive: true });
    await fs.writeFile(path.join(localRoots.artworkDirectory, artName), bytes);
    await fs.writeFile(path.join(localRoots.productImageDirectory, imageName), bytes);
    const rows = [
      { kind: "artwork", stored_name: artName, content_type: validImage.mime, size: bytes.length },
      { kind: "product-image", stored_name: imageName, content_type: validImage.mime, size: bytes.length }
    ];
    const db = memoryDb(rows);

    const publicKey = objectKey("product-image", `product-images/${imageName}`);
    const privateKey = objectKey("artwork", `artwork/${artName}`);
    equal(publicKey, `product-images/${imageName}`, "public product object key is namespaced");
    equal(privateKey, `artwork/${artName}`, "private artwork object key is namespaced");
    await rejects(async () => objectKey("artwork", "../secret.png"), "reject path traversal");

    const uploaded = await storageA.put({ kind: "product-image", key: publicKey, body: bytes, contentType: "image/png" });
    equal(uploaded.size, bytes.length, "public image upload returns byte length");
    const fromSecondInstance = await storageB.get({ kind: "product-image", key: publicKey });
    equal(fromSecondInstance.body.toString("hex"), bytes.toString("hex"), "second instance reads shared object");
    equal(fromSecondInstance.contentType, "image/png", "content type is preserved across instances");
    await storageA.put({ kind: "artwork", key: privateKey, body: bytes, contentType: "image/png" });
    check(await storageB.head({ kind: "artwork", key: privateKey }), "private object is available through shared storage interface");
    equal(await storageB.get({ kind: "artwork", key: `artwork/1700000000000-${"c".repeat(32)}.png` }), null, "missing object resolves to null");
    await storageA.delete({ kind: "artwork", key: privateKey });

    const dry = await migrateStorageReferences({ db, storage: storageA, roots: { artwork: localRoots.artworkDirectory, productImages: localRoots.productImageDirectory }, dryRun: true });
    equal(dry.discovered, 2, "dry-run discovers all referenced fixtures");
    equal(dry.copied, 1, "dry-run identifies only missing remote object for copy");
    equal(db.state.rows[0].stored_name, artName, "dry-run does not change database references");

    db.state.failUpdates = true;
    const failed = await migrateStorageReferences({ db, storage: storageA, roots: { artwork: localRoots.artworkDirectory, productImages: localRoots.productImageDirectory }, dryRun: false });
    equal(failed.failed, 2, "database update failure is reported without deleting source files");
    check(await storageB.head({ kind: "artwork", key: privateKey }), "uploaded object remains recoverable after DB failure");
    check(await fs.stat(path.join(localRoots.artworkDirectory, artName)), "local historical source remains after DB failure");

    db.state.failUpdates = false;
    const resumed = await migrateStorageReferences({ db, storage: storageA, roots: { artwork: localRoots.artworkDirectory, productImages: localRoots.productImageDirectory }, dryRun: false });
    equal(resumed.failed, 0, "migration retry completes after transient DB failure");
    equal(db.state.rows[0].stored_name, privateKey, "artwork reference becomes namespaced after verification");
    equal(db.state.rows[1].stored_name, publicKey, "product image reference becomes namespaced after verification");
    equal(await auditStorageReferences({ db, storage: storageB }).then(result => result.missingObjects), 0, "reference audit finds no missing objects");
    const audit = await auditStorageReferences({ db, storage: storageB });
    equal(audit.unreferencedObjects, 0, "audit finds no orphan objects after migration");

    const legacyOnly = `1700000000000-${"f".repeat(32)}.png`;
    const legacyKey = objectKey("artwork", legacyOnly);
    await storageA.put({ kind: "artwork", key: legacyKey, body: bytes, contentType: "image/png" });
    const missingSourceDb = memoryDb([{ kind: "artwork", stored_name: legacyOnly, content_type: "image/png", size: bytes.length }]);
    const unverifiable = await migrateStorageReferences({ db: missingSourceDb, storage: storageA, roots: { artwork: path.join(root, "missing-artwork"), productImages: localRoots.productImageDirectory }, dryRun: false });
    equal(unverifiable.unverified, 1, "legacy reference is not updated when its local source is missing");
    equal(missingSourceDb.state.rows[0].stored_name, legacyOnly, "unverified legacy DB reference is preserved");
    await storageA.delete({ kind: "artwork", key: legacyKey });

    await storageA.delete({ kind: "product-image", key: publicKey });
    equal(await storageB.get({ kind: "product-image", key: publicKey }), null, "delete is visible to another storage instance");
    const staleTemp = path.join(objectRoots.artworkDirectory, `${artName}.${"d".repeat(16)}.uploading`);
    const recentTemp = path.join(objectRoots.artworkDirectory, `${artName}.${"e".repeat(16)}.uploading`);
    await fs.writeFile(staleTemp, "partial");
    await fs.writeFile(recentTemp, "partial");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(staleTemp, oldTime, oldTime);
    equal(await storageA.cleanupStaging(), 1, "stale staging artifact is cleaned conservatively");
    equal(await fs.stat(recentTemp).then(() => true), true, "recent staging artifact is retained");
    equal(await storageB.health(), true, "local test backend reports available");
    await rejects(async () => createObjectStorageFromEnv({ NODE_ENV: "production", OBJECT_STORAGE_BACKEND: "local" }, objectRoots), "production rejects local storage");
    throws(() => createObjectStorageFromEnv({
      NODE_ENV: "production", OBJECT_STORAGE_BACKEND: "s3", OBJECT_STORAGE_ENDPOINT: "http://storage.example",
      OBJECT_STORAGE_REGION: "region", OBJECT_STORAGE_ACCESS_KEY_ID: "test-only", OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-only",
      OBJECT_STORAGE_PUBLIC_BUCKET: "public", OBJECT_STORAGE_PRIVATE_BUCKET: "private"
    }, objectRoots), /HTTPS/);

    let dbAttempts = 0, cleanupCount = 0;
    const request = { method: "POST" };
    const response = {};
    const rollbackApp = {
      validCsrf: () => true,
      saveArtwork: async () => ({ stored: privateKey }),
      db: { async transaction() { dbAttempts += 1; throw new Error("simulated database write failure"); } },
      async removeSavedUploads(files) { if (files.some(file => file.stored === privateKey)) cleanupCount += 1; },
      send() {}, redirect() {}
    };
    await rejects(cartRoute({
      req: request, res: response, url: { pathname: "/cart/add" }, data: { product_id: 1, files: {} },
      session: { id: "fixture-session" }, cart: {}, app: rollbackApp
    }), "DB failure after upload propagates safely");
    equal(dbAttempts, 1, "failed cart write does not retry the DB transaction");
    equal(cleanupCount, 1, "DB failure invokes compensating object cleanup");
    const uploadUnavailableApp = {
      ...rollbackApp,
      saveArtwork: async () => { throw Object.assign(new Error("storage unavailable"), { code: "OBJECT_STORAGE_UNAVAILABLE" }); },
      db: { async transaction() { dbAttempts += 1; } }
    };
    await rejects(cartRoute({
      req: request, res: response, url: { pathname: "/cart/add" }, data: { product_id: 1, files: {} },
      session: { id: "fixture-session" }, cart: {}, app: uploadUnavailableApp
    }), "storage failure rejects before database write");
    equal(dbAttempts, 1, "upload failure creates no database reference");

    const failingClient = { async send() { throw new Error("simulated provider failure"); }, destroy() {} };
    const failingS3 = require("../services/object-storage").createS3ObjectStorage({ endpoint: "https://storage.invalid", region: "test", accessKeyId: "test-only", secretAccessKey: "test-only", publicBucket: "public", privateBucket: "private" }, failingClient);
    let storageFailure;
    try { await failingS3.put({ kind: "artwork", key: privateKey, body: bytes, contentType: "image/png" }); }
    catch (error) { storageFailure = error; }
    check(storageFailure instanceof ObjectStorageError, "provider errors use generic storage error type");
    equal(storageFailure.code, "OBJECT_STORAGE_UNAVAILABLE", "provider errors have stable failure code");
    await failingS3.close();

    const timeoutClient = { send(_command, options) {
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("request did not abort")), 100);
        options.abortSignal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("timed out")); }, { once: true });
      });
    }, destroy() {} };
    const timeoutStorage = require("../services/object-storage").createS3ObjectStorage({
      endpoint: "https://storage.invalid", region: "test", accessKeyId: "test-only", secretAccessKey: "test-only",
      publicBucket: "public", privateBucket: "private", requestTimeoutMs: 10
    }, timeoutClient);
    let timeoutError;
    try { await timeoutStorage.put({ kind: "artwork", key: privateKey, body: bytes, contentType: "image/png" }); }
    catch (error) { timeoutError = error; }
    check(timeoutError instanceof ObjectStorageError, "object request deadline fails with a generic storage error");
    equal(timeoutError.code, "OBJECT_STORAGE_UNAVAILABLE", "timeout is treated as unavailable storage");
    await timeoutStorage.close();

    process.stdout.write(`Stage 7 storage regression: PASS (${assertions} assertions)\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Stage 7 storage regression: FAIL (${assertions} assertions): ${error.stack}\n`);
  process.exitCode = 1;
});
