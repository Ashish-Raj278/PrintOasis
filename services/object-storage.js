const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command
} = require("@aws-sdk/client-s3");
const { GENERATED_FILE } = require("./upload-security");

const OBJECT_TYPES = {
  artwork: { prefix: "artwork", visibility: "private" },
  "product-image": { prefix: "product-images", visibility: "public" }
};

class ObjectStorageError extends Error {
  constructor(operation, cause) {
    super(`Object storage ${operation} failed.`, { cause });
    this.name = "ObjectStorageError";
    this.code = "OBJECT_STORAGE_UNAVAILABLE";
    this.operation = operation;
  }
}

function objectKey(kind, storedName) {
  const type = OBJECT_TYPES[kind];
  const value = String(storedName || "");
  const parts = value.split("/");
  let filename = value;
  if (parts.length === 2 && parts[0] === type?.prefix) filename = parts[1];
  else if (parts.length !== 1) throw new Error("Invalid stored object reference.");
  if (!type || !GENERATED_FILE.test(filename)) throw new Error("Invalid stored object reference.");
  return `${type.prefix}/${filename}`;
}

function storedReference(kind, storedName) {
  return objectKey(kind, storedName);
}

function bucketFor(buckets, kind) {
  const visibility = OBJECT_TYPES[kind]?.visibility;
  const bucket = visibility && buckets[visibility];
  if (!bucket) throw new Error("Invalid object storage kind.");
  return bucket;
}

function isMissingObject(error) {
  return ["NoSuchKey", "NotFound", "404"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404;
}

async function bodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body?.transformToByteArray) return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body || []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createS3ObjectStorage(config, clientOverride = null) {
  const buckets = { public: config.publicBucket, private: config.privateBucket };
  if (!config.endpoint || !config.region || !buckets.public || !buckets.private || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("S3-compatible object storage requires endpoint, region, credentials, and separate public/private buckets.");
  }
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("S3-compatible object storage endpoint must be a valid URL."); }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("S3-compatible object storage endpoint must not contain credentials, query parameters, or a fragment.");
  }
  if (config.production && endpoint.protocol !== "https:") {
    throw new Error("Production object storage endpoint must use HTTPS.");
  }
  if (buckets.public === buckets.private) throw new Error("Public and private object storage buckets must be different.");
  const client = clientOverride || new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2
  });
  const requestTimeoutMs = Math.min(120000, Math.max(1, Number(config.requestTimeoutMs) || 30000));
  const requestOptions = () => ({ abortSignal: AbortSignal.timeout(requestTimeoutMs) });

  async function send(operation, command) {
    try { return await client.send(command, requestOptions()); }
    catch (error) { throw new ObjectStorageError(operation, error); }
  }

  return {
    backend: "s3",
    objectKey,
    async put({ kind, key, body, contentType }) {
      const normalized = objectKey(kind, key);
      const bytes = await bodyBuffer(body);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      await send("upload", new PutObjectCommand({
        Bucket: bucketFor(buckets, kind), Key: normalized, Body: bytes,
        ContentLength: bytes.length, ContentType: contentType,
        Metadata: { sha256 }
      }));
      return { key: normalized, size: bytes.length, contentType, sha256 };
    },
    async get({ kind, key }) {
      const normalized = objectKey(kind, key);
      const bucket = bucketFor(buckets, kind);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalized }), requestOptions());
        return { body: await bodyBuffer(result.Body), contentType: result.ContentType || "application/octet-stream", size: Number(result.ContentLength || 0), metadata: result.Metadata || {} };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw new ObjectStorageError("download", error);
      }
    },
    async head({ kind, key }) {
      const normalized = objectKey(kind, key);
      const bucket = bucketFor(buckets, kind);
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: normalized }), requestOptions());
        return { key: normalized, size: Number(result.ContentLength || 0), contentType: result.ContentType || "application/octet-stream", metadata: result.Metadata || {} };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw new ObjectStorageError("inspect", error);
      }
    },
    async delete({ kind, key }) {
      const normalized = objectKey(kind, key);
      await send("delete", new DeleteObjectCommand({ Bucket: bucketFor(buckets, kind), Key: normalized }));
      return true;
    },
    async list({ kind, prefix = "", continuationToken, limit = 1000 } = {}) {
      const type = OBJECT_TYPES[kind];
      if (!type) throw new Error("Invalid object storage kind.");
      const result = await send("list", new ListObjectsV2Command({
        Bucket: bucketFor(buckets, kind), Prefix: `${type.prefix}/${prefix}`,
        ContinuationToken: continuationToken, MaxKeys: Math.min(1000, Math.max(1, Number(limit) || 1000))
      }));
      return {
        objects: (result.Contents || []).map(item => ({ key: item.Key, size: Number(item.Size || 0), lastModified: item.LastModified || null })),
        continuationToken: result.NextContinuationToken || null
      };
    },
    async health() {
      try {
        await Promise.all(Object.keys(buckets).map(kind => send("health check", new ListObjectsV2Command({ Bucket: buckets[kind], MaxKeys: 1 }))));
        return true;
      } catch { return false; }
    },
    async close() { client.destroy?.(); }
  };
}

function createLocalObjectStorage({ artworkDirectory, productImageDirectory }) {
  const roots = { artwork: artworkDirectory, "product-image": productImageDirectory };
  function localPath(kind, key) {
    const normalized = objectKey(kind, key);
    const name = normalized.slice(normalized.indexOf("/") + 1);
    const root = path.resolve(roots[kind]);
    const resolved = path.resolve(root, name);
    if (path.dirname(resolved) !== root) throw new Error("Invalid stored object reference.");
    return { normalized, root, resolved };
  }
  return {
    backend: "local",
    objectKey,
    async put({ kind, key, body, contentType }) {
      const target = localPath(kind, key);
      const bytes = await bodyBuffer(body);
      await fs.mkdir(target.root, { recursive: true });
      const temp = `${target.resolved}.${crypto.randomBytes(8).toString("hex")}.uploading`;
      const metadataPath = `${target.resolved}.metadata.json`;
      const metadataTemp = `${metadataPath}.${crypto.randomBytes(8).toString("hex")}.uploading`;
      try {
        await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await fs.writeFile(metadataTemp, JSON.stringify({ contentType }), { flag: "wx", mode: 0o600 });
        await fs.rename(temp, target.resolved);
        await fs.rename(metadataTemp, metadataPath);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
        await fs.rm(metadataTemp, { force: true }).catch(() => {});
      }
      return { key: target.normalized, size: bytes.length, contentType, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    },
    async get({ kind, key }) {
      const target = localPath(kind, key);
      try {
        const body = await fs.readFile(target.resolved);
        let contentType = "application/octet-stream";
        try { contentType = JSON.parse(await fs.readFile(`${target.resolved}.metadata.json`, "utf8")).contentType || contentType; } catch {}
        return { body, size: body.length, contentType, metadata: {} };
      } catch (error) { if (error.code === "ENOENT") return null; throw new ObjectStorageError("download", error); }
    },
    async head({ kind, key }) {
      const target = localPath(kind, key);
      try {
        const stat = await fs.stat(target.resolved);
        let contentType = "application/octet-stream";
        try { contentType = JSON.parse(await fs.readFile(`${target.resolved}.metadata.json`, "utf8")).contentType || contentType; } catch {}
        return { key: target.normalized, size: stat.size, contentType, metadata: {} };
      }
      catch (error) { if (error.code === "ENOENT") return null; throw new ObjectStorageError("inspect", error); }
    },
    async delete({ kind, key }) {
      const target = localPath(kind, key);
      try {
        await fs.unlink(target.resolved);
        await fs.rm(`${target.resolved}.metadata.json`, { force: true });
        return true;
      }
      catch (error) { if (error.code === "ENOENT") return false; throw new ObjectStorageError("delete", error); }
    },
    async list({ kind, continuationToken = 0, limit = 1000 } = {}) {
      const type = OBJECT_TYPES[kind];
      if (!type) throw new Error("Invalid object storage kind.");
      const root = path.resolve(roots[kind]);
      const names = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && GENERATED_FILE.test(entry.name)).map(entry => `${type.prefix}/${entry.name}`).sort();
      const offset = Number(continuationToken || 0), page = names.slice(offset, offset + limit);
      const objects = await Promise.all(page.map(async key => {
        const stat = await fs.stat(localPath(kind, key).resolved);
        return { key, size: stat.size, lastModified: stat.mtime };
      }));
      return { objects, continuationToken: offset + page.length < names.length ? String(offset + page.length) : null };
    },
    async cleanupStaging({ olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
      let removed = 0;
      const staleName = /^(?:[0-9]+-(?:[a-f0-9]{16}|[a-f0-9]{32})\.(?:pdf|png|ai|psd|jpe?g|webp)(?:\.metadata\.json)?\.[a-f0-9]{16}\.uploading)$/i;
      for (const rootValue of Object.values(roots)) {
        const root = path.resolve(rootValue);
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          if (!entry.isFile() || !staleName.test(entry.name)) continue;
          const file = path.resolve(root, entry.name);
          if (path.dirname(file) !== root) continue;
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs >= olderThanMs) { await fs.unlink(file); removed += 1; }
        }
      }
      return removed;
    },
    async health() { return true; },
    async close() {}
  };
}

function createObjectStorageFromEnv(env = process.env, roots) {
  const backend = String(env.OBJECT_STORAGE_BACKEND || (env.NODE_ENV === "production" ? "s3" : "local")).toLowerCase();
  if (backend === "local") {
    if (env.NODE_ENV === "production") throw new Error("Production requires shared S3-compatible object storage; local file storage is disabled.");
    return createLocalObjectStorage(roots);
  }
  if (backend !== "s3") throw new Error("OBJECT_STORAGE_BACKEND must be 'local' or 's3'.");
  return createS3ObjectStorage({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    publicBucket: env.OBJECT_STORAGE_PUBLIC_BUCKET,
    privateBucket: env.OBJECT_STORAGE_PRIVATE_BUCKET,
    production: env.NODE_ENV === "production",
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
    requestTimeoutMs: env.OBJECT_STORAGE_TIMEOUT_MS
  });
}

module.exports = {
  OBJECT_TYPES, ObjectStorageError, objectKey, storedReference,
  createS3ObjectStorage, createLocalObjectStorage, createObjectStorageFromEnv
};
