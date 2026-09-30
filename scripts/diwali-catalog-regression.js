const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { products, productCollections } = require("../catalog");
const { app } = require("../server");
const productRoutes = require("../routes/products");
const cartRoutes = require("../routes/cart");

const root = path.resolve(__dirname, "..");
const slug = "printoasis-diwali-hamper-kit";
const hamper = products.find(product => product[0] === slug);
assert.ok(hamper, "The Diwali hamper is part of the canonical catalogue.");
assert.equal(products.filter(product => product[0] === slug).length, 1, "The canonical catalogue contains exactly one Diwali hamper row.");
assert.equal(hamper[2], "gifts", "The hamper belongs to Personalised Gifts.");
assert.equal(hamper[3], 1499, "The proposed selling price is ₹1,499 per hamper.");
assert.equal(hamper[4], 1, "The minimum order quantity is one hamper.");
assert.equal(hamper[5], 0, "The listing does not invent customer ratings.");
assert.equal(hamper[12]?.prelaunch, true, "The listing uses the explicit zero-stock prelaunch marker.");
for (const detail of ["200 g", "100 g", "almonds", "cashews", "raisins", "pistachios", "two decorative diyas", "greeting card", "name tag", "ribbon"]) {
  assert.ok(hamper[7].toLowerCase().includes(detail.toLowerCase()), `The catalogue describes confirmed detail: ${detail}.`);
}
assert.deepEqual(productCollections["limited-editions"], [slug], "Limited Editions is the existing code-curated collection.");
assert.equal(app.productUnitPriceMinor({ price: hamper[3], min_qty: hamper[4] }), 149900, "The product price resolves to exact paise through existing pricing logic.");

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const seedAt = server.indexOf("if (product[12]?.prelaunch)");
const stockSeedAt = server.indexOf('UPDATE products SET stock = ? WHERE slug = ? AND stock <= 0', seedAt);
assert.ok(seedAt >= 0 && stockSeedAt > seedAt, "The zero-stock prelaunch branch runs before standard inventory seeding.");
assert.match(server.slice(seedAt, stockSeedAt), /VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,0,0,'active',1\)/, "A new prelaunch row is visible with zero physical and reserved stock.");
assert.match(server.slice(seedAt, stockSeedAt), /ON CONFLICT \(slug\) DO NOTHING/, "Seeding preserves existing product IDs and data.");
assert.match(server, /slug IN \(\$?\{collectionSlugs\.map\(/, "Collection results are filtered through the curated slug list.");
assert.match(server, /\/product\/printoasis-diwali-hamper-kit/ , "The homepage CTA links to the normal product detail route.");
assert.match(server, /₹1,499 incl\. taxes/, "The homepage feature shows the proposed price.");
assert.match(server, /diwaliProductPurchasable \? "\/product\/printoasis-diwali-hamper-kit"/, "The hero CTA points to the detail route when the product is purchasable.");
assert.match(server, /diwaliProductPurchasable \? "\/product\/printoasis-diwali-hamper-kit" : "\/products\?category=gifts"/, "The hero CTA safely falls back to Personalised Gifts while unavailable.");
assert.match(server, /COALESCE\(stock, 0\) - COALESCE\(reserved, 0\) >= min_qty/, "The hero CTA only links directly to a stocked quantity that satisfies the minimum order.");
assert.match(server, /homeImage\("hero-diwali-hamper", "hero-diwali-hamper\.png"\)/, "The homepage uses the supplied wide banner through the image library.");
assert.match(server, /isDiwaliHamper \? "hamper"/, "The catalogue card labels the fixed price per hamper.");
assert.match(server, /const PREFERRED_IMAGE_EXTENSIONS = \["\.webp", "\.avif", "\.jpg", "\.jpeg", "\.png", "\.svg"\]/, "PNG product photographs are supported by the established image library.");
assert.match(server, /libraryImage\(libraryDirectory, "primary"\)/, "The product-card and gallery resolver selects the primary library asset.");
assert.match(server, /primary\.url.*width="1200" height="900"/, "Product cards use the resolved primary product image.");
assert.doesNotMatch(server, /<div class="promise">/, "The announcement strip is absent from the shared layout.");
const localOrderSource = server.slice(server.indexOf("async function createLocalOrder"), server.indexOf("async function finalizeCapturedCheckout"));
const providerOrderSource = server.slice(server.indexOf("async function finalizeCapturedCheckout"), server.indexOf("async function createCheckoutIntent"));
assert.match(localOrderSource, /item\.artwork_note \? ` · \$\{item\.artwork_note\}`/, "The local order-item snapshot retains product personalisation.");
assert.match(providerOrderSource, /item\.artwork_note \? ` · \$\{item\.artwork_note\}`/, "The provider order-item snapshot retains product personalisation.");
const productPageSource = server.slice(server.indexOf("async function productPage"), server.indexOf("async function authPage"));
for (const text of ["200 g assorted dry fruits", "100 g assorted chocolates", "recipient_name", "maxlength=\"60\"", "card_message", "maxlength=\"400\"", "Out of Stock"]) {
  assert.ok(productPageSource.includes(text), `The SSR product detail implements ${text}.`);
}
assert.match(server, /productImageAlt\(product\)/, "Product image references receive descriptive product-specific alt text.");
assert.match(server, /class="product-photo-hover" src="\$\{esc\(hover\.url\)\}" alt=""/, "The existing hover-image slot continues to use its resolved image URL.");
assert.match(server, /hero-art-link-primary[^>]+href="\$\{slide\[3\]\}" aria-label="\$\{slide\[4\]\}"/, "The printed primary CTA is a keyboard-accessible real link.");
assert.match(server, /hero-diwali-copy/, "Mobile hero layout includes live text and CTA controls alongside the artwork.");
assert.match(server, /PrintOasis Diwali Hamper Kit in a plum and gold gift box/, "Product imagery has descriptive alt text for the supplied photograph.");
assert.match(server, /limited-editions.*printoasis-diwali-hamper-kit/s, "Limited Editions includes the canonical hamper slug.");
assert.match(styles, /\.hero-diwali-artwork\{[^}]*aspect-ratio:16\/9/, "The desktop hero preserves the banner ratio without cropping its CTA artwork.");
assert.match(styles, /@media\(max-width:680px\)\{\.hero-diwali/, "A dedicated responsive hero layout is present for mobile.");

const publicAsset = relative => path.join(root, "public", "assets", "images", relative);
const imagePaths = ["home/hero-diwali-hamper.png", `products/gifts/${slug}/primary.png`];
for (const imagePath of imagePaths) {
  const file = publicAsset(imagePath);
  assert.ok(fs.existsSync(file), `Referenced supplied image asset exists: ${imagePath}`);
  const content = fs.readFileSync(file);
  assert.deepEqual([...content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `The local asset is a readable PNG: ${imagePath}`);
  assert.ok(content.readUInt32BE(16) > 0 && content.readUInt32BE(20) > 0, `The PNG dimensions are valid: ${imagePath}`);
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  app.servePublic({}, response, new URL(`http://localhost/public/assets/images/${imagePath}`));
  assert.equal(response.status, 200, `The static image route serves ${imagePath}.`);
  assert.equal(response.headers["Content-Type"], "image/png", `The static image route declares PNG for ${imagePath}.`);
  assert.equal(response.body.length, content.length, `The static image response contains the complete ${imagePath} asset.`);
}
assert.ok(!fs.existsSync(publicAsset("home/hero-diwali-hamper.svg")), "The old concept hero is removed from the active asset library.");
assert.ok(!fs.existsSync(publicAsset(`products/gifts/${slug}/primary.svg`)), "The old concept product image is removed from the product gallery.");

function responseStub() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
}

async function verifyProductDetailAndSearch() {
  const product = { id: 987654, slug, name: hamper[1], category: hamper[2], price: hamper[3], min_qty: hamper[4], rating: 0, badge: hamper[6], description: hamper[7], sizes: hamper[8], materials: hamper[9], print_options: hamper[10], color: hamper[11], stock: 0, reserved: 0, active: 1, status: "active" };
  let visible = true;
  const routeApp = {
    db: {
      async get(sql) { ctx.detailSql = sql; return /WHERE slug = \?/.test(sql) && visible ? product : null; },
      async all(sql) { ctx.searchSql = sql; return visible ? [{ name: product.name }] : []; }
    },
    visibleProductCondition: () => "active = 1 AND COALESCE(status, 'active') != 'hidden'",
    async productPage(value) { return `<main><h1>${value.name}</h1><b>₹1,499</b><span>Out of Stock</span></main>`; },
    async productsPage() { return `<main><a href="/product/${slug}">${product.name}</a><b>₹1,499</b></main>`; },
    layout: async (_title, body) => body,
    send(res, status, body) { res.status = status; res.body = body; },
    sendJson(res, status, body) { res.status = status; res.body = body; }
  };
  const ctx = { req: { method: "GET" }, res: responseStub(), url: new URL(`http://localhost/product/${slug}`), data: {}, session: {}, cart: { count: 0 }, app: routeApp };
  await productRoutes(ctx);
  assert.equal(ctx.res.status, 200, "The visible zero-stock product reaches its normal detail page.");
  assert.match(ctx.res.body, /PrintOasis Diwali Hamper Kit/);
  assert.match(ctx.res.body, /Out of Stock/);
  assert.match(ctx.detailSql, /WHERE slug = \? AND active = 1 AND COALESCE\(status, 'active'\) != 'hidden'/, "The public detail route enforces standard product visibility.");

  visible = false;
  ctx.res = responseStub();
  await productRoutes(ctx);
  assert.equal(ctx.res.status, 404, "A hidden product does not have a public product-detail page.");

  visible = true;
  ctx.res = responseStub();
  ctx.url = new URL("http://localhost/api/search-suggestions?q=Diwali");
  await productRoutes(ctx);
  assert.deepEqual(ctx.res.body, { suggestions: [product.name] }, "Search suggestions include the visible catalogue product.");
  assert.match(ctx.searchSql, /active = 1 AND COALESCE\(status, 'active'\) != 'hidden'/, "Search suggestions enforce standard visibility.");
  visible = false;
  ctx.res = responseStub();
  await productRoutes(ctx);
  assert.deepEqual(ctx.res.body, { suggestions: [] }, "Search suggestions do not expose a hidden product.");

  ctx.res = responseStub();
  ctx.url = new URL("http://localhost/products?category=gifts&collection=limited-editions");
  await productRoutes(ctx);
  assert.ok(ctx.res.body.includes(`/product/${slug}`), "The curated catalogue page links to the normal detail route.");
  assert.ok(ctx.res.body.includes("₹1,499"), "The curated catalogue page displays the proposed price.");
}

async function verifyPersonalisationCartAndInventorySafety() {
  const inserts = [];
  let product = { id: 987654, slug, name: hamper[1], price: hamper[3], min_qty: 1, stock: 1, reserved: 0, active: 1, status: "active" };
  const session = { id: "isolated-session" };
  const ctx = {
    req: { method: "POST" }, res: responseStub(), url: new URL("http://localhost/cart/add"), session, cart: { count: 0 },
    data: { csrf: "ok", product_id: String(product.id), quantity: "1", size: "One hamper", material: "Gift box", print_option: "Printed sleeve, greeting card and name tag", recipient_name: "Asha", card_message: "Wishing you a joyful Diwali" },
    app: {
      db: { async transaction(callback) { return callback({ async get() { return product; }, async run(sql, ...args) { inserts.push({ sql, args }); return { changes: 1 }; } }); } },
      validCsrf: () => true,
      visibleProductCondition: () => "active = 1 AND COALESCE(status, 'active') != 'hidden'",
      saveArtwork: async () => null,
      addCartItem: app.addCartItem,
      redirect(res, url) { res.redirect = url; },
      send(res, status, body) { res.status = status; res.body = body; }
    }
  };
  await cartRoutes(ctx);
  const insert = inserts.find(entry => /INSERT INTO cart_items/.test(entry.sql));
  assert.ok(insert, "The existing cart add flow stores a purchasable hamper.");
  assert.match(insert.args[6], /Recipient name: Asha\nGreeting-card message: Wishing you a joyful Diwali/, "Personalisation is saved in the existing cart artwork_note field.");
  assert.equal(inserts[0].args[0], 1, "The existing stock reservation path reserves one hamper.");

  inserts.length = 0;
  product = { ...product, stock: 0, reserved: 0 };
  ctx.res = responseStub();
  await cartRoutes(ctx);
  assert.equal(inserts.length, 0, "The cart flow does not reserve or insert a zero-stock hamper.");
  assert.match(ctx.res.redirect, /out%20of%20stock/i, "A zero-stock add attempt returns the existing out-of-stock message.");

  const missingFields = { ...ctx.data, recipient_name: "", card_message: "" };
  product = { ...product, stock: 1 };
  inserts.length = 0;
  ctx.data = missingFields;
  ctx.res = responseStub();
  await cartRoutes(ctx);
  assert.equal(inserts.length, 0, "Required personalisation is validated before cart insertion.");
  assert.match(ctx.res.redirect, /recipient%20name/i, "Missing recipient details return a useful form error.");
}

Promise.all([verifyProductDetailAndSearch(), verifyPersonalisationCartAndInventorySafety()]).then(() => {
  console.log("Diwali catalogue, collection, product detail, search, image route, personalisation and zero-stock cart regressions passed.");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
