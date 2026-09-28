const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const uploadSecurity = require("./upload-security");
const { objectKey } = require("./object-storage");

const REFERENCE_QUERY = `
  SELECT 'artwork' AS kind, artwork_stored_name AS stored_name, artwork_mime AS content_type, artwork_size AS size
  FROM cart_items WHERE artwork_stored_name IS NOT NULL
  UNION ALL
  SELECT 'artwork', artwork_stored_name, artwork_mime, artwork_size
  FROM order_items WHERE artwork_stored_name IS NOT NULL
  UNION ALL
  SELECT 'product-image', image_stored_name, image_mime, image_size
  FROM products WHERE image_stored_name IS NOT NULL
  UNION ALL
  SELECT 'product-image', image_stored_name, image_mime, image_size
  FROM product_images WHERE image_stored_name IS NOT NULL`;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sourcePath(roots, kind, storedName) {
  const key = objectKey(kind, storedName);
  const filename = key.slice(key.indexOf("/") + 1);
  const root = path.resolve(kind === "artwork" ? roots.artwork : roots.productImages);
  const file = path.resolve(root, filename);
  if (path.dirname(file) !== root) throw new Error("Invalid database file reference.");
  return { file, key, filename };
}

function collectReferences(rows) {
  const references = new Map();
  for (const row of rows) {
    const key = objectKey(row.kind, row.stored_name);
    const id = `${row.kind}:${key}`;
    const current = references.get(id) || { kind: row.kind, key, oldNames: new Set(), sizes: new Set(), contentTypes: new Set() };
    current.oldNames.add(String(row.stored_name));
    if (row.size != null) current.sizes.add(Number(row.size));
    if (row.content_type) current.contentTypes.add(String(row.content_type));
    references.set(id, current);
  }
  return [...references.values()];
}

async function updateReferences(db, kind, oldName, newName) {
  if (oldName === newName) return 0;
  return db.transaction(async tx => {
    const statements = kind === "artwork"
      ? [
          "UPDATE cart_items SET artwork_stored_name=? WHERE artwork_stored_name=?",
          "UPDATE order_items SET artwork_stored_name=? WHERE artwork_stored_name=?"
        ]
      : [
          "UPDATE products SET image_stored_name=? WHERE image_stored_name=?",
          "UPDATE product_images SET image_stored_name=? WHERE image_stored_name=?"
        ];
    let count = 0;
    for (const sql of statements) count += (await tx.run(sql, newName, oldName)).changes;
    return count;
  });
}

async function migrateStorageReferences({ db, storage, roots, dryRun = true }) {
  const rows = await db.all(REFERENCE_QUERY);
  const references = collectReferences(rows);
  const result = { mode: dryRun ? "dry-run" : "execute", discovered: references.length, copied: 0, alreadyPresent: 0, referencesUpdated: 0, missingLocalAndRemote: 0, unverified: 0, failed: 0 };

  for (const reference of references) {
    try {
      const source = sourcePath(roots, reference.kind, reference.key);
      let local;
      try { local = await fs.readFile(source.file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const expectedSizes = [...reference.sizes];
      const expectedTypes = [...reference.contentTypes];
      const hasLegacyReference = [...reference.oldNames].some(name => name !== reference.key);
      if (expectedSizes.length > 1 || expectedTypes.length > 1) throw new Error("Conflicting database metadata for a referenced file.");
      if (local) {
        const uploadType = reference.kind === "artwork" ? "artwork" : "image";
        const limit = uploadType === "artwork" ? uploadSecurity.ARTWORK_LIMIT : uploadSecurity.PRODUCT_IMAGE_LIMIT;
        const validated = uploadSecurity.validateUpload({ filename: source.filename, data: local }, uploadType, limit);
        if ((expectedSizes.length && expectedSizes[0] !== validated.size) || (expectedTypes.length && expectedTypes[0] !== validated.mime)) {
          result.unverified += 1;
          continue;
        }
      }

      if (dryRun) {
        const existing = await storage.head({ kind: reference.kind, key: reference.key });
        if (!local && !existing) result.missingLocalAndRemote += 1;
        else if (!local) {
          if (hasLegacyReference || (expectedSizes.length && existing.size !== expectedSizes[0]) || (expectedTypes.length && existing.contentType !== expectedTypes[0])) result.unverified += 1;
          else result.alreadyPresent += 1;
        } else if (existing) {
          const remote = await storage.get({ kind: reference.kind, key: reference.key });
          if (!remote || sha256(remote.body) !== sha256(local)) result.unverified += 1;
          else result.alreadyPresent += 1;
        } else result.copied += 1;
        continue;
      }

      let existing = await storage.head({ kind: reference.kind, key: reference.key });
      if (existing && local) {
        const remote = await storage.get({ kind: reference.kind, key: reference.key });
        if (!remote || sha256(remote.body) !== sha256(local)) throw new Error("Existing object differs from its local source; refusing to overwrite it.");
      } else if (!existing && local) {
        const type = reference.kind === "artwork" ? "artwork" : "image";
        const validated = uploadSecurity.validateUpload({ filename: source.filename, data: local }, type, type === "artwork" ? uploadSecurity.ARTWORK_LIMIT : uploadSecurity.PRODUCT_IMAGE_LIMIT);
        await storage.put({ kind: reference.kind, key: reference.key, body: validated.data, contentType: validated.mime });
        existing = await storage.head({ kind: reference.kind, key: reference.key });
        const remote = existing && await storage.get({ kind: reference.kind, key: reference.key });
        if (!remote || remote.size !== local.length || sha256(remote.body) !== sha256(local)) throw new Error("Uploaded object failed byte-for-byte verification.");
        result.copied += 1;
      } else if (!existing) {
        result.missingLocalAndRemote += 1;
        continue;
      } else {
        if (hasLegacyReference) { result.unverified += 1; continue; }
        const metadataOk = (!expectedSizes.length || existing.size === expectedSizes[0]) &&
          (!expectedTypes.length || existing.contentType === expectedTypes[0]);
        if (!metadataOk) { result.unverified += 1; continue; }
        const remote = await storage.get({ kind: reference.kind, key: reference.key });
        if (!remote || remote.size !== existing.size) { result.unverified += 1; continue; }
        result.alreadyPresent += 1;
      }

      for (const oldName of reference.oldNames) {
        if (oldName !== reference.key) result.referencesUpdated += await updateReferences(db, reference.kind, oldName, reference.key);
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function auditStorageReferences({ db, storage }) {
  const references = collectReferences(await db.all(REFERENCE_QUERY));
  const referenced = new Set(references.map(reference => `${reference.kind}:${reference.key}`));
  const result = { referencesChecked: references.length, missingObjects: 0, unreferencedObjects: 0, objectsChecked: 0 };
  for (const reference of references) {
    if (!await storage.head({ kind: reference.kind, key: reference.key })) result.missingObjects += 1;
  }
  for (const kind of ["artwork", "product-image"]) {
    let continuationToken;
    do {
      const page = await storage.list({ kind, continuationToken });
      for (const object of page.objects) {
        result.objectsChecked += 1;
        if (!referenced.has(`${kind}:${object.key}`)) result.unreferencedObjects += 1;
      }
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }
  return result;
}

module.exports = { REFERENCE_QUERY, auditStorageReferences, collectReferences, migrateStorageReferences, sourcePath, updateReferences };
