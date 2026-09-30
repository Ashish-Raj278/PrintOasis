const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { products, productCollections } = require("../catalog");
const { app } = require("../server");
const productRoutes = require("../routes/products");

const root = path.resolve(__dirname, "..");
const slug = "printoasis-diwali-hamper-kit";
const draft = products.find(product => product[0] === slug);
assert.ok(draft, "The Diwali hamper concept is part of the canonical catalogue.");
assert.equal(draft[2], "gifts", "The concept belongs to Personalised Gifts.");
assert.equal(draft[3], 0, "The unpublished draft has no guessed price.");
assert.equal(draft[5], 0, "The unpublished draft has no invented rating.");
assert.equal(draft[12]?.draft, true, "The draft uses the explicit safe seed marker.");
assert.match(draft[7], /not available to order/i, "The draft description says it cannot be ordered.");
assert.deepEqual(productCollections["limited-editions"], [slug], "Limited Editions is a code-curated product collection.");

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const seedDraftAt = server.indexOf("if (product[12]?.draft)");
const restockAt = server.indexOf('UPDATE products SET stock = ? WHERE slug = ? AND stock <= 0', seedDraftAt);
assert.ok(seedDraftAt >= 0 && restockAt > seedDraftAt, "Draft seed handling runs before the standard stock seeding branch.");
assert.match(server.slice(seedDraftAt, restockAt), /VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,0,0,'hidden',0\)/, "Draft insertion sets zero stock, zero reservations, hidden status and inactive state.");
assert.match(server.slice(seedDraftAt, restockAt), /ON CONFLICT \(slug\) DO NOTHING/, "The startup seed does not overwrite later admin edits.");
assert.match(server, /AND slug IN \(\$?\{collectionSlugs\.map\(/, "Collection results are filtered through the curated slug list.");
assert.match(server, /homeImage\("hero-diwali-hamper", "hero-diwali-hamper\.svg"\)/, "The homepage resolves the Diwali image through the image library.");
assert.doesNotMatch(server, /<div class="promise">/, "The announcement strip is removed from the shared layout.");

const publicAsset = relative => path.join(root, "public", "assets", "images", relative);
const imagePaths = ["home/hero-diwali-hamper.svg", `products/gifts/${slug}/primary.svg`];
for (const imagePath of imagePaths) {
  const file = publicAsset(imagePath);
  assert.ok(fs.existsSync(file), `Image asset exists: ${imagePath}`);
  assert.match(fs.readFileSync(file, "utf8"), /<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `Image asset is an SVG: ${imagePath}`);
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; }
  };
  app.servePublic({}, response, new URL(`http://localhost/public/assets/images/${imagePath}`));
  assert.equal(response.status, 200, `Static image route serves ${imagePath}.`);
  assert.equal(response.headers["Content-Type"], "image/svg+xml", `Static image route declares SVG for ${imagePath}.`);
}
assert.match(server, /"\.png", "\.svg"/, "The resolver supports trusted SVG library assets.");
assert.match(server, /"\.svg": "image\/svg\+xml"/, "The static image handler returns the SVG MIME type.");

async function verifyHiddenProductRoutes() {
  const calls = [];
  const ctx = {
    req: { method: "GET" }, res: {}, url: new URL(`http://localhost/product/${slug}`), data: {}, session: {}, cart: {},
    app: {
      db: {
        async get(sql, requestedSlug) { calls.push({ sql, requestedSlug }); return null; },
        async all(sql) { calls.push({ sql }); return []; }
      },
      visibleProductCondition: () => "active = 1 AND COALESCE(status, 'active') != 'hidden'",
      send(res, status, body) { res.status = status; res.body = body; },
      sendJson(res, status, body) { res.status = status; res.body = body; },
      layout: async (_title, body) => body
    }
  };
  await productRoutes(ctx);
  assert.equal(ctx.res.status, 404, "A hidden draft has no public product-detail page.");
  assert.equal(calls[0].requestedSlug, slug, "The public detail route looked up the draft slug.");
  assert.match(calls[0].sql, /active = 1 AND COALESCE\(status, 'active'\) != 'hidden'/, "Product details require a visible product.");

  ctx.res = {};
  ctx.url = new URL("http://localhost/api/search-suggestions?q=Diwali");
  await productRoutes(ctx);
  assert.deepEqual(ctx.res.body, { suggestions: [] }, "Search suggestions do not reveal the hidden draft.");
  assert.match(calls[1].sql, /active = 1 AND COALESCE\(status, 'active'\) != 'hidden'/, "Search suggestions require a visible product.");
}

verifyHiddenProductRoutes().then(() => {
  console.log("Diwali catalogue, hidden seed, collection, route and image regressions passed.");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
