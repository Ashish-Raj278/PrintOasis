const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const adminRoutes = require("../routes/admin");

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function fixture({ isAdmin = true, csrfValid = true } = {}) {
  const calls = { updates: [] };
  const response = { status: 0, body: "", setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = String(body); } };
  const app = {
    requireAdmin() { return isAdmin; },
    validCsrf() { return csrfValid; },
    send(res, status, body) { res.writeHead(status); res.end(body); },
    redirect(res, location) { res.redirectedTo = location; },
    slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); },
    async saveProductImage() { return null; },
    async saveProductImages() { return []; },
    async addProductImages() {},
    async removeSavedUploads() {},
    productImageDirectory: "unused-test-directory",
    db: {
      async transaction(work) {
        return work({
          async get() { return { id: 7, image_original_name: null, image_stored_name: null, image_mime: null, image_size: null }; },
          async run(sql, ...args) { calls.updates.push({ sql, args }); }
        });
      }
    }
  };
  const context = (data = {}) => ({
    req: { method: "POST" }, res: response,
    url: new URL("http://localhost/admin/products/save"), data: { ...baseProduct(), ...data },
    session: { csrf: "valid-token", user: { id: 1 } }, cart: {}, app
  });
  return { calls, response, context };
}

function baseProduct() {
  return {
    csrf: "valid-token", id: "7", name: "Test product", slug: "test-product", category: "gifts",
    price: "1499", min_qty: "1", stock: "0", status: "active"
  };
}

async function savedRating(data, queryType = "UPDATE") {
  const f = fixture();
  await adminRoutes(f.context(data));
  equal(f.calls.updates.length, 1, "An authorized, valid form saves the product.");
  ok(f.calls.updates[0].sql.includes(queryType), `The existing ${queryType.toLowerCase()} save path is used.`);
  equal(f.calls.updates[0].args[0], "test-product", "The existing admin save query receives the product slug.");
  return f.calls.updates[0].args[5];
}

async function run() {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok(/name="rating" type="number" min="0" max="5"/.test(serverSource), "The admin editor permits an explicit zero rating.");
  equal(await savedRating({ rating: "0" }, "UPDATE products SET"), 0, "An explicit zero rating remains zero when updating.");
  equal(await savedRating({ rating: "0", id: "" }, "INSERT INTO products"), 0, "An explicit zero rating remains zero when creating.");
  equal(await savedRating({ rating: "4.2" }), 4.2, "A valid non-zero rating remains unchanged after saving.");
  equal(await savedRating({ rating: "0.5" }), 1, "The existing minimum clamp for non-zero ratings remains unchanged.");
  equal(await savedRating({}), 4.8, "An omitted rating retains the existing 4.8 default.");

  {
    const f = fixture({ isAdmin: false });
    equal(await adminRoutes(f.context({ rating: "0" })), true, "The product-save route handles unauthorized requests.");
    equal(f.calls.updates.length, 0, "An unauthorized request cannot update the product.");
  }
  {
    const f = fixture({ csrfValid: false });
    equal(await adminRoutes(f.context({ rating: "0" })), true, "The product-save route handles invalid-CSRF requests.");
    equal(f.response.status, 403, "An invalid CSRF token remains rejected with HTTP 403.");
    equal(f.calls.updates.length, 0, "An invalid CSRF token cannot update the product.");
  }
  ok(true, "Admin product-save rating regression completed.");
  process.stdout.write(`Admin product-save regression: ${assertions} assertions passed.\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
