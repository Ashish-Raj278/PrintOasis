# PrintOasis Source Guide

This folder is the complete website source code. You can open it in VS Code,
GitHub Desktop, or any editor.

## Main Files

- `server.js` - Node.js server, page rendering, login, sessions, cart,
  checkout, Google Sign-In callback, Razorpay order creation and verification.
- `routes/` - request handlers split by area: auth, products, cart, checkout,
  admin, account and static assets.
- `services/database.js` - PostgreSQL pool, parameter conversion, transactions, health checks, and migration runner.
- `migrations/001-initial.sql` - idempotent PostgreSQL schema for all application data.
- `catalog.js` - starter seed catalog only. Use `/admin` to manage live
  products after the database is created.
- `public/styles.css` - all visual styling and responsive layout.
- `public/app.js` - browser-side menu, product price updates, Razorpay checkout
  popup handling.
- `.env.example` - template for live configuration values.
- `README.md` - run, share, Google, Razorpay, and client preview instructions.

## Editing Products

Use `/admin/products` for normal business-owner product management. It supports
add/edit/hide products and product image uploads.

`catalog.js` is only for initial seed products. Each seed product is one array
row:

```js
["slug", "Product name", "category", 399, 100, 4.8, "Badge",
 "Description", "Size 1|Size 2", "Material 1|Material 2",
 "Print option 1|Print option 2", "cobalt"]
```

An internal draft seed may append `{ draft: true }` after the normal fields.
The startup seed inserts it once with hidden status and zero stock, and does
not overwrite later admin edits. Code-curated collections are defined in
`productCollections`; only active products appear in storefront routes.

The numeric values mean:

- `399` - starting price in INR.
- `100` - minimum order quantity.
- `4.8` - rating shown on the product card.

Restart the website after editing. On startup, the catalog syncs into PostgreSQL through the migration-backed database service without deleting customers or existing orders.

## Routes

- `routes/auth.js` - login, register, logout and Google Sign-In.
- `routes/products.js` - home, catalog, product detail, search suggestions,
  wishlist and reviews.
- `routes/cart.js` - cart pages and artwork uploads.
- `routes/checkout.js` - checkout, Razorpay and GST invoices.
- `routes/admin.js` - admin dashboard, product CRUD, orders and statuses.
- `routes/account.js` - account, order tracking and support pages.
- `routes/static.js` - public assets, uploaded product images and health check.

## Admin

Local development admin:

```text
admin@printoasis.example
PrintOasisAdmin123!
```

Production must set `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

## Private Files

Do not upload these to GitHub:

- `.env`
- `data/`
- `node_modules/`
- `*.log`

They are already listed in `.gitignore`.
