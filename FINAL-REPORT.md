# PrintOasis Final Project Report

## Current Source Location

```text
C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\PrintOasis-GitHub-Source
```

This is now the working project folder. The existing `.env` and `data/`
folder in this location were preserved so Google, Razorpay, database and local
runtime settings remain in place.

## Architecture

PrintOasis is one application, one database, one deployment and one login
system.

```text
/
├── Home
├── Products
├── Cart
├── Login / Register
├── Checkout
├── Account
├── Wishlist
├── Order Tracking
└── /admin
    ├── Dashboard
    ├── Products
    ├── Orders
    └── Notifications
```

Admin is not a separate website. It lives inside the same Node.js app at
`/admin`. Users have an `is_admin` field in SQLite. Normal users see the
customer storefront; admin users see the admin link and can access `/admin`.

## Source Split

The app is no longer one giant route file.

```text
server.js              App bootstrap, database, shared helpers, rendering
routes/auth.js         Login, register, logout, Google Sign-In
routes/products.js     Home, catalog, product detail, search, reviews, wishlist
routes/cart.js         Cart, artwork uploads and inventory reservations
routes/checkout.js     Checkout, Razorpay, GST invoices
routes/admin.js        Admin dashboard, products, orders, status updates
routes/account.js      Account, support pages, order tracking
routes/static.js       Public assets, product images, health check
```

## Completed Features

- Full multi-page storefront.
- Login and create-account flow.
- Google Sign-In integration.
- Razorpay checkout integration.
- SQLite database persistence.
- Admin dashboard inside the same app.
- Product add/edit/hide from `/admin/products`.
- Product image uploads for JPG, PNG and WebP.
- Artwork uploads for PDF, PNG, AI and PSD.
- Admin order view.
- Order status updates: Pending, Printing, Packed, Shipped, Delivered,
  Cancelled.
- Production inventory flow: stock, reserved and available stock.
- Order tracking page.
- Nodemailer SMTP email notification support.
- Local notification outbox under `data/email-outbox`.
- Search autocomplete.
- Customer reviews.
- Wishlist.
- Coupons.
- Shipping cost estimate.
- GST invoice print/save page.
- Dark mode.
- Render/Docker production deployment files.

## Inventory Architecture

Inventory now uses:

```text
available = stock - reserved
```

- `stock` is the physical warehouse quantity.
- `reserved` is system-managed by active carts and pending checkout flow.
- Add to cart increases `reserved` only.
- Cart quantity changes adjust `reserved` by the difference.
- Removing an item, logout and payment failure release reservations.
- Successful checkout decreases both `stock` and `reserved`.
- Cancelled orders restore deducted stock once.
- Admin edits `stock` and product `status`; `reserved` is read-only.
- Hidden products never appear in storefront, search or product pages.

## Important Runtime Files

Do not commit these to public GitHub:

```text
.env
data/
node_modules/
```

They are excluded by `.gitignore`.

## Local Run

```powershell
cd "C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\PrintOasis-GitHub-Source"
npm.cmd install
npm.cmd start
```

Open:

```text
http://localhost:3000
http://localhost:3000/admin
```

## Production Requirements

Set these environment variables on the hosting provider:

```text
ADMIN_EMAIL=
ADMIN_PASSWORD=
BASE_URL=
GOOGLE_CLIENT_ID=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
EMAIL_FROM=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
DATA_DIR=/var/data
```

For Render, keep the persistent disk mounted at `/var/data` so uploaded files,
SQLite data, carts, users and orders survive deploys.

## Verification Completed

From the final target folder:

```text
npm.cmd install
npm.cmd run check
powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1
powershell -ExecutionPolicy Bypass -File .\inventory-smoke-test.ps1
```

Result:

```text
PASS home=200 auth=registered cart=persisted checkout=created orders=visible admin=working tracking=working invoice=working
PASS inventory=reserved_without_stock_deduct update=released checkout=deducted cancel=restocked logout=released
```

Dependency audit during install:

```text
found 0 vulnerabilities
```
