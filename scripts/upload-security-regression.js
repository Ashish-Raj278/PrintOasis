const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const uploads = require("../services/upload-security");
const { requestLimitPolicies } = require("../services/redis");

function makeChecks() {
  let count = 0;
  return {
    get count() { return count; },
    ok(value, message) { count += 1; assert.ok(value, message); },
    equal(actual, expected, message) { count += 1; assert.equal(actual, expected, message); },
    throws(work, message) { count += 1; assert.throws(work, message); }
  };
}

const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
function pngChunk(type, content) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(content.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, content])));
  return Buffer.concat([size, name, content, checksum]);
}
function validPng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]);
}
function validJpeg() {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 1, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, scan]);
}
function validWebp() {
  const body = Buffer.from([0x2f, 0, 0, 0, 0]), header = Buffer.alloc(12), chunk = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(18, 4); header.write("WEBP", 8, "ascii");
  chunk.write("VP8L", 0, "ascii"); chunk.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, chunk, body, Buffer.alloc(1)]);
}
function validPsd() {
  const data = Buffer.alloc(41); data.write("8BPS", 0, "ascii"); data.writeUInt16BE(1, 4); data.writeUInt16BE(3, 12);
  data.writeUInt32BE(1, 14); data.writeUInt32BE(1, 18); data.writeUInt16BE(8, 22); data.writeUInt16BE(3, 24);
  data[40] = 0;
  return data;
}
const validPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii");
const file = (filename, data, contentType = "application/octet-stream") => ({ filename, data, contentType });

async function assertUploadValidationAndStorage() {
  const c = makeChecks();
  const png = validPng(), jpeg = validJpeg(), webp = validWebp();
  c.equal(uploads.validateUpload(file("press.png", png, "text/html"), "image", uploads.PRODUCT_IMAGE_LIMIT).mime, "image/png", "PNG signature overrides fake browser MIME type.");
  c.equal(uploads.validateUpload(file("press.jpg", jpeg), "image", uploads.PRODUCT_IMAGE_LIMIT).mime, "image/jpeg", "Structurally valid JPEG is accepted.");
  c.equal(uploads.validateUpload(file("press.jpeg", jpeg), "image", uploads.PRODUCT_IMAGE_LIMIT).mime, "image/jpeg", "The .jpeg extension remains supported.");
  c.equal(uploads.validateUpload(file("press.webp", webp), "image", uploads.PRODUCT_IMAGE_LIMIT).mime, "image/webp", "Structured WebP product images are accepted.");
  c.equal(uploads.validateUpload(file("artwork.pdf", validPdf), "artwork", uploads.ARTWORK_LIMIT).mime, "application/pdf", "PDF artwork is accepted by its content signature.");
  c.equal(uploads.validateUpload(file("legacy.ai", Buffer.from("%!PS-Adobe-3.0\n%%EOF")), "artwork", uploads.ARTWORK_LIMIT).mime, "application/postscript", "PostScript-based Illustrator artwork remains supported.");
  c.equal(uploads.validateUpload(file("editable.psd", validPsd()), "artwork", uploads.ARTWORK_LIMIT).mime, "image/vnd.adobe.photoshop", "Structured PSD artwork is accepted.");
  c.throws(() => uploads.validateUpload(file("fake.png", Buffer.from("<script>alert(1)</script>"), "image/png"), "image", uploads.PRODUCT_IMAGE_LIMIT), "Executable text cannot masquerade as an image.");
  c.throws(() => uploads.validateUpload(file("active.pdf", Buffer.from("%PDF-1.4\n1 0 obj << /JavaScript (app.alert) >> endobj\n%%EOF")), "artwork", uploads.ARTWORK_LIMIT), "PDF active-script actions are rejected.");
  c.throws(() => uploads.validateUpload(file("fake.png", validPdf), "image", uploads.PRODUCT_IMAGE_LIMIT), "Extension/content mismatch is rejected.");
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 5] ^= 0x01;
  c.throws(() => uploads.validateUpload(file("corrupt.png", corrupt), "image", uploads.PRODUCT_IMAGE_LIMIT), "Corrupt PNG chunk checksums are rejected.");
  c.throws(() => uploads.validateUpload(file("bad.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])), "image", uploads.PRODUCT_IMAGE_LIMIT), "Truncated/corrupt JPEG is rejected.");
  c.throws(() => uploads.safeOriginalFilename("..\\..\\private.png"), "Windows-style path traversal filename is rejected.");
  c.throws(() => uploads.safeOriginalFilename("../../private.pdf"), "POSIX path traversal filename is rejected.");
  c.throws(() => uploads.validateUpload(file("empty.pdf", Buffer.alloc(0)), "artwork", uploads.ARTWORK_LIMIT), "Empty uploads are rejected.");
  c.throws(() => uploads.validateMultipartFiles({ image: file("large.webp", Buffer.alloc(uploads.PRODUCT_IMAGE_LIMIT + 1)) }, "/admin/products/save"), "Per-image size limit is enforced before file processing.");
  c.throws(() => uploads.validateMultipartFiles({ gallery: [1, 2, 3, 4, 5].map(i => file(`${i}.webp`, Buffer.alloc(7 * 1024 * 1024))) }, "/admin/products/save"), "Aggregate image upload limit is enforced.");
  c.throws(() => uploads.validateMultipartFiles({ gallery: Array.from({ length: 11 }, (_, i) => file(`${i}.webp`, Buffer.from("x"))) }, "/admin/products/save"), "Gallery file count is capped.");
  assert.throws(() => uploads.assertRequestSize("50000000", 1024), { code: "UPLOAD_TOO_LARGE" }); c.count += 1;
  const uploadReq = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" } };
  const ipLimits = requestLimitPolicies(uploadReq, "/cart/add", {}, null, "ip");
  c.ok(ipLimits.some(policy => policy.scope === "customer-artwork-upload" && policy.limit === 5), "Customer artwork uploads have a dedicated shared Redis IP limit.");
  const accountLimits = requestLimitPolicies(uploadReq, "/cart/add", {}, { id: "upload-session", user: { id: 22 } }, "account");
  c.ok(accountLimits.some(policy => policy.scope === "customer-artwork-upload-session" && policy.limit === 5), "Customer artwork uploads have a per-session/user limiter.");
  const adminLimits = requestLimitPolicies({ method: "POST", headers: {} }, "/admin/products/save", {}, { user: { id: 22 } }, "ip");
  c.ok(adminLimits.some(policy => policy.scope === "admin-product-upload"), "Admin image uploads retain their dedicated shared Redis limit.");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "printoasis-upload-security-"));
  const customerFiles = path.join(root, "artwork"), imageFiles = path.join(root, "product-images");
  fs.mkdirSync(customerFiles); fs.mkdirSync(imageFiles);
  try {
    c.throws(() => uploads.resolveContained(customerFiles, "../escape.pdf"), "Storage path containment rejects traversal.");
    const one = uploads.writeUpload(customerFiles, uploads.validateUpload(file("same.pdf", validPdf), "artwork", uploads.ARTWORK_LIMIT));
    const two = uploads.writeUpload(customerFiles, uploads.validateUpload(file("same.pdf", validPdf), "artwork", uploads.ARTWORK_LIMIT));
    c.ok(one.stored !== two.stored && uploads.GENERATED_FILE.test(one.stored), "Server generates unique randomized storage names.");
    c.equal(fs.existsSync(path.join(customerFiles, one.stored)), true, "Validated upload is written inside its private storage root.");
    uploads.removeUpload(customerFiles, one.stored);
    c.equal(fs.existsSync(path.join(customerFiles, one.stored)), false, "A simulated failed database transaction can remove its new file.");

    const historical = uploads.writeUpload(customerFiles, uploads.validateUpload(file("historical.pdf", validPdf), "artwork", uploads.ARTWORK_LIMIT));
    const abandonedTemp = `${Date.now()}-${"a".repeat(16)}.pdf.uploading`;
    fs.writeFileSync(path.join(customerFiles, abandonedTemp), validPdf);
    fs.utimesSync(path.join(customerFiles, abandonedTemp), new Date(0), new Date(0));
    const removed = await uploads.cleanupOrphanedUploads({ uploadDir: customerFiles, productImageDir: imageFiles, olderThanMs: 1000 });
    c.equal(removed.includes(abandonedTemp), true, "Old abandoned staging files are cleaned conservatively.");
    c.equal(fs.existsSync(path.join(customerFiles, historical.stored)), true, "Cleanup never removes final historical artwork with incomplete legacy references.");
    c.equal(fs.existsSync(path.join(customerFiles, abandonedTemp)), false, "Abandoned staging file is removed.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return c.count;
}

async function assertUploadAccessBehavior({ app, get, postMultipart, csrf, prefix, admin, customer, register, createProduct, sessionId, trackUpload }) {
  const c = makeChecks();
  const png = validPng(), pdf = validPdf;
  const adminPage = await get("/admin/products", admin);
  const imageForm = { csrf: csrf(adminPage.html), name: `Upload regression ${prefix}`, slug: `${prefix}-upload-image`, category: "marketing", price: "50", min_qty: "1", stock: "20", status: "active" };
  const imageUpload = await postMultipart("/admin/products/save", imageForm, admin, [{ name: "product_image", filename: "catalog.png", type: "text/html", data: png }]);
  c.equal(imageUpload.response.status, 303, "Authorized admin can create a product with a validated image.");
  const savedProduct = await app.db.get("SELECT * FROM products WHERE slug=?", imageForm.slug);
  c.ok(savedProduct?.image_stored_name, "A validated product-image reference is stored.");
  trackUpload(savedProduct.image_stored_name, app.productImageDirectory);
  const publicImagePath = savedProduct.image_stored_name.split("/").map(encodeURIComponent).join("/");
  const publicImage = await get(`/uploads/${publicImagePath}`);
  c.equal(publicImage.response.status, 200, "Product catalog images remain publicly accessible.");
  c.equal(publicImage.response.headers.get("content-type"), "image/png", "Product image MIME is derived from its verified content.");
  c.equal(publicImage.response.headers.get("x-content-type-options"), "nosniff", "Product image response disables MIME sniffing.");

  const invalidForm = { ...imageForm, name: `Rejected ${prefix}`, slug: `${prefix}-upload-invalid` };
  await postMultipart("/admin/products/save", invalidForm, admin, [{ name: "product_image", filename: "script.png", type: "image/png", data: Buffer.from("<script>alert(1)</script>") }]);
  c.equal(await app.db.get("SELECT id FROM products WHERE slug=?", invalidForm.slug), undefined, "Invalid image does not create a product or database reference.");
  const rollbackForm = { ...imageForm, name: `Rollback ${prefix}`, slug: `${prefix}-upload-rollback` };
  const filesBeforeRollback = fs.readdirSync(app.productImageDirectory).length;
  const transaction = app.db.transaction;
  app.db.transaction = work => transaction.call(app.db, async tx => { await work(tx); throw new Error("upload regression forced rollback"); });
  try {
    await postMultipart("/admin/products/save", rollbackForm, admin, [{ name: "product_image", filename: "rollback.png", type: "image/png", data: png }]);
  } finally { app.db.transaction = transaction; }
  c.equal(await app.db.get("SELECT id FROM products WHERE slug=?", rollbackForm.slug), undefined, "Failed database transaction leaves no product image reference.");
  c.equal(fs.readdirSync(app.productImageDirectory).length, filesBeforeRollback, "Failed database transaction removes its newly written product image.");

  const product = await createProduct(admin, `${prefix}-private-artwork`, 10);
  const detail = await get(`/product/${product.slug}`, customer);
  const uploaded = await postMultipart("/cart/add", { csrf: csrf(detail.html), product_id: String(product.id), quantity: "1", size: "A4", material: "Matte", print_option: "Full color" }, customer,
    [{ name: "artwork_file", filename: "customer-final.pdf", type: "image/png", data: pdf }]);
  c.equal(uploaded.response.status, 303, "Customer artwork accepts valid PDF even when browser MIME is false.");
  const cartItem = await app.db.get("SELECT artwork_stored_name,artwork_mime FROM cart_items WHERE session_id=? AND product_id=?", sessionId(uploaded.cookie), product.id);
  trackUpload(cartItem.artwork_stored_name, app.uploadDirectory);
  c.equal(cartItem.artwork_mime, "application/pdf", "Persisted artwork MIME is server-derived rather than client-supplied.");
  const ownerFile = await get(`/artwork/${encodeURIComponent(cartItem.artwork_stored_name)}`, uploaded.cookie);
  c.equal(ownerFile.response.status, 200, "Owning customer can retrieve artwork from their active cart.");
  c.equal(ownerFile.response.headers.get("content-disposition")?.startsWith("attachment;"), true, "Private artwork is delivered as an attachment.");
  c.equal(ownerFile.response.headers.get("cache-control"), "private, no-store", "Private artwork is not cached publicly.");
  const anotherCustomer = await register("Other Artwork Customer", `${prefix}-other-artwork@example.test`);
  c.equal((await get(`/artwork/${encodeURIComponent(cartItem.artwork_stored_name)}`, anotherCustomer)).response.status, 404, "Different customer cannot retrieve the artwork.");
  c.equal((await get(`/artwork/${encodeURIComponent(cartItem.artwork_stored_name)}`)).response.status, 404, "Unauthenticated visitor cannot enumerate/retrieve customer artwork.");
  c.equal((await get(`/artwork/${encodeURIComponent(cartItem.artwork_stored_name)}`, admin)).response.status, 200, "Authorized admin can retrieve referenced customer artwork.");

  const before = await app.db.get("SELECT COUNT(*) AS count FROM cart_items WHERE session_id=? AND product_id=?", sessionId(uploaded.cookie), product.id);
  const invalidDetail = await get(`/product/${product.slug}`, uploaded.cookie);
  await postMultipart("/cart/add", { csrf: csrf(invalidDetail.html), product_id: String(product.id), quantity: "1", size: "A4", material: "Matte", print_option: "Full color" }, uploaded.cookie,
    [{ name: "artwork_file", filename: "mismatch.png", type: "application/pdf", data: pdf }]);
  const after = await app.db.get("SELECT COUNT(*) AS count FROM cart_items WHERE session_id=? AND product_id=?", sessionId(uploaded.cookie), product.id);
  c.equal(Number(after.count), Number(before.count), "Rejected upload leaves cart/database references unchanged.");

  for (let index = 0; index < 3; index += 1) {
    const page = await get(`/product/${product.slug}`, uploaded.cookie);
    const result = await postMultipart("/cart/add", { csrf: csrf(page.html), product_id: String(product.id), quantity: "1", size: "A4", material: "Matte", print_option: "Full color" }, uploaded.cookie,
      [{ name: "artwork_file", filename: `repeat-${index}.pdf`, type: "application/pdf", data: pdf }]);
    c.equal(result.response.status, 303, `Allowed artwork upload attempt ${index + 2} completes below the configured limit.`);
    const saved = await app.db.get("SELECT artwork_stored_name FROM cart_items WHERE session_id=? AND product_id=? ORDER BY id DESC LIMIT 1", sessionId(uploaded.cookie), product.id);
    if (saved?.artwork_stored_name) trackUpload(saved.artwork_stored_name, app.uploadDirectory);
  }
  const limitedPage = await get(`/product/${product.slug}`, uploaded.cookie);
  const limited = await postMultipart("/cart/add", { csrf: csrf(limitedPage.html), product_id: String(product.id), quantity: "1", size: "A4", material: "Matte", print_option: "Full color" }, uploaded.cookie,
    [{ name: "artwork_file", filename: "rate-limited.pdf", type: "application/pdf", data: pdf }]);
  c.equal(limited.response.status, 429, "Repeated customer artwork upload attempts are limited by shared Redis policy.");
  c.equal(await app.db.get("SELECT id FROM cart_items WHERE artwork_original_name='rate-limited.pdf' AND session_id=?", sessionId(uploaded.cookie)), undefined, "Rate-limited upload creates no cart/database reference.");

  const checkoutPage = await get("/checkout", uploaded.cookie);
  const orderResponse = await postMultipart("/checkout", { csrf: csrf(checkoutPage.html), payment_method: "cod", customer_name: "Artwork Customer", phone: "9876500000", address: "1 Print Lane", city: "Bengaluru", postal_code: "560001" }, uploaded.cookie);
  c.equal(orderResponse.response.status, 303, "COD order completes with uploaded artwork in the cart.");
  const order = await app.db.get("SELECT id FROM orders WHERE user_id=(SELECT user_id FROM sessions WHERE id=?) ORDER BY id DESC LIMIT 1", sessionId(uploaded.cookie));
  const persistedArtwork = await app.db.get("SELECT artwork_stored_name FROM order_items WHERE order_id=? AND artwork_stored_name IS NOT NULL ORDER BY id LIMIT 1", order.id);
  c.ok(persistedArtwork?.artwork_stored_name, "Order items retain artwork references after cart cleanup.");
  c.equal((await get(`/artwork/${encodeURIComponent(persistedArtwork.artwork_stored_name)}`, uploaded.cookie)).response.status, 200, "Order owner retains private artwork access after checkout.");
  return c.count;
}

module.exports = { assertUploadValidationAndStorage, assertUploadAccessBehavior, validPng, validJpeg, validWebp, validPdf, validPsd };

if (require.main === module) assertUploadValidationAndStorage().then(count => console.log(`PASS upload validation/storage regression: ${count} assertions.`)).catch(error => { console.error(error); process.exitCode = 1; });
