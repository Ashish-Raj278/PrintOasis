# PrintOasis Print Services

A multi-page print-commerce website built with Node.js, SQLite, Nodemailer,
Razorpay-ready checkout and an admin dashboard.

## Run

```powershell
cd "C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\print-services-site"
npm start
```

Open `http://localhost:3000`.

The database is created automatically at `data/store.db` on first start.
Run `npm.cmd install` once after downloading/cloning the source.

Local admin login:

```text
Email: admin@printoasis.example
Password: PrintOasisAdmin123!
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in production.

## Edit Products

Use the admin dashboard:

```text
/admin
```

From there the business owner can add, edit, hide/delete products, upload
product images, view orders, update order statuses, and see analytics.

`catalog.js` is now only the starter seed catalog. Every product is one row:

```js
["slug", "Product name", "category", 399, 100, 4.8, "Badge",
 "Description", "Size 1|Size 2", "Material 1|Material 2",
 "Print option 1|Print option 2", "cobalt"]
```

The numbers after the category are the starting price in INR, minimum
quantity, and rating. Restart the server after editing. The catalog is synced
into SQLite without deleting customers or orders.

The main application bootstrap is in `server.js`, route handlers are in
`routes/`, styling is in `public/styles.css`, and browser interactions are in
`public/app.js`.

For a file-by-file source map, see `docs/SOURCE-GUIDE.md`.

## Google Sign-In

1. Create a Web OAuth client in Google Cloud Console.
2. Add the deployed domain to Authorized JavaScript origins.
3. Add `https://your-domain.example/auth/google` as an authorized redirect URI.
4. Set `GOOGLE_CLIENT_ID` and `BASE_URL` in your hosting environment.

The Google button appears automatically once configured. Google ID tokens are
validated server-side before a local account/session is created.

## Razorpay Payments

1. Create a Razorpay account and complete business activation/KYC.
2. Generate test API keys first.
3. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in your hosting environment.
4. Complete test payments, then replace them with live keys after approval.

The server creates a Razorpay Order for every online payment and verifies the
payment signature before creating the PrintOasis order. Never put
`RAZORPAY_KEY_SECRET` in browser code or commit it to source control.

## Email Notifications

Order confirmations and status updates are queued in SQLite and written to
`data/email-outbox`. Configure SMTP to send real email through Nodemailer:

```text
EMAIL_FROM=orders@your-domain.example
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_USER=your-user
SMTP_PASS=your-password
```

Supported order statuses: Pending, Printing, Packed, Shipped and Delivered.

## Share With A Client

Double-click `SHARE-WITH-CLIENT.cmd`.

The launcher starts the website and prints a public HTTPS URL similar to:

```text
https://example-name.loca.lt
```

Send that URL to the client. Keep the launcher window and computer running
while the client reviews the site. Press `Ctrl+C` to stop sharing.

Alternatively, from PowerShell:

```powershell
cd "C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\print-services-site"
npm.cmd run share
```

The first run downloads the small LocalTunnel utility through `npx`. This
temporary preview URL may change each time. Permanent hosting requires
deploying the Node.js application and its SQLite data directory to a hosting
provider.

## Proper Hosted Website

For client use, deploy the app instead of running it from localhost. This
project includes production hosting files:

- `Dockerfile`
- `render.yaml`
- `docs/DEPLOYMENT.md`

After deployment, the site runs at a public HTTPS URL such as
`https://printoasis.onrender.com` or the client's own domain.

## GitHub Source

This folder is GitHub-ready. Private runtime files are excluded by `.gitignore`,
including `.env`, `data/`, `node_modules/`, and logs.

See `docs/GITHUB-AND-CLIENT.md` for upload and client approval steps.
See `docs/DEPLOYMENT.md` for permanent hosting steps.

## Included

- Responsive home, catalog, product, cart, checkout, support and business pages
- Product search, category filtering and configurable products
- Autocomplete search suggestions and popular searches
- Persistent cart and SQLite catalog
- Password-hashed registration and login
- Admin dashboard for products, orders, status updates and analytics
- Artwork uploads for PDF, PNG, AI and PSD files
- Product image uploads for JPG, PNG and WebP mockups
- Customer reviews, wishlist, coupons, shipping calculator and GST invoices
- Email notification outbox with Nodemailer SMTP support
- Server-side sessions with CSRF-protected forms
- Razorpay-ready checkout with server-side order and signature verification
- Cash on delivery and persistent order history

Google and Razorpay credentials belong to the business owner. The integration
is included, but live operation requires the client's approved accounts,
credentials, deployed HTTPS domain, privacy policy, terms, refund policy, and
Razorpay KYC activation.
