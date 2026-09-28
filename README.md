# PrintOasis

PrintOasis is a full-stack commercial-printing storefront for discovering configurable print products, placing orders, and managing fulfilment from one application.

## Overview

The project gives customers a complete print-commerce flow: browse a searchable catalogue, configure products, upload artwork, reserve inventory in a cart, check out with cash on delivery or a configured Razorpay flow, track orders, manage addresses, save a wishlist, and leave verified-purchase reviews.

Administrators use the same application to manage products, images, stock, visibility, coupons, order status, tracking details, and notification history. The application is built with native Node.js HTTP, PostgreSQL, server-side rendered HTML, and modular route handlers.

## Demo and Screenshots

Repository screenshots have not been committed yet. Add verified product screenshots under `docs/screenshots/` and reference them here with relative paths, for example:

```md
![PrintOasis home page](docs/screenshots/home.png)
```

## Key Features

- Searchable product catalogue with category filters, configurable product options, featured products, and hidden-product exclusion.
- Admin product CRUD, image upload, stock management, visibility controls, and featured-product controls.
- Session-backed cart with artwork uploads for PDF, PNG, AI, and PSD files.
- Reservation-based inventory: cart activity changes reserved stock; physical stock is deducted only when an order is created.
- Checkout with address validation, shipping calculation, GST invoice view/print, cash on delivery, and a Razorpay-ready online-payment flow.
- Order history, status timeline, shipment tracking, cancellation/restocking, and notification records.
- Verified-purchase reviews, rating statistics, wishlist, saved addresses, password changes, and coupons.
- Configurable Nodemailer SMTP delivery with local notification logging (not an automatic retry queue).
- Password-hashed accounts, server-side sessions, CSRF-protected forms, authorization checks, and SSR output escaping.
- Responsive vanilla HTML/CSS/JavaScript UI with dark mode, mega navigation, and image-library support for galleries and card hover images.

## Technical Highlights

| Area | Implementation |
| --- | --- |
| HTTP layer | A native Node.js `http` server in `server.js`; no Express dependency. |
| Rendering | Server-side HTML rendering helpers generate pages from PostgreSQL-backed data. |
| Routes | Focused modules in `routes/` handle authentication, products, cart, checkout, accounts, admin, and static assets. |
| Inventory | `available = stock - reserved`; row-locked PostgreSQL transactions protect reservation, checkout, and restock changes. |
| Data access | PostgreSQL through the official `pg` connection pool with parameterized statements, foreign keys, and explicit transactions. |
| Security | Password hashing with `scrypt`, Redis-shared HTTP-only sessions, atomic Redis rate limits, CSRF tokens, role checks, HTML escaping, safe upload checks, and Razorpay signature verification. |
| Images and files | A WebP-first source-controlled image library ships with the release; runtime uploads use a shared S3-compatible object-storage interface. |

## Tech Stack

| Technology | Purpose |
| --- | --- |
| Node.js 22.5+ | Application runtime. |
| Native Node.js HTTP | Request handling and HTTP responses without a web framework. |
| `pg` | PostgreSQL connection-pool persistence for business data and durable session/cart lifecycle anchors. |
| `redis` | Shared canonical session payloads and atomic fixed-window rate-limit counters. |
| HTML, CSS, JavaScript | Server-rendered UI, responsive styling, and progressive browser interactions. |
| Server-side rendering | Generates the storefront and admin HTML on the server for every request. |
| Nodemailer | Optional SMTP delivery for order and contact notifications. |
| Razorpay API | Optional configured online-payment integration. |
| Docker / Render Blueprint | Included deployment configuration. |

## Architecture

```mermaid
flowchart LR
    B[Browser] --> S[Native Node.js HTTP server<br/>server.js]
    S --> R[Route modules<br/>routes/]
    R --> G[Session, authorization,<br/>CSRF and validation helpers]
    G --> L[Business logic and<br/>transaction helpers]
    L --> D[(PostgreSQL<br/>connection pool)]
    L --> V[SSR rendering helpers]
    V --> B
    L --> E[Optional SMTP / Razorpay<br/>configuration]
```

`server.js` owns application bootstrap, database initialization, shared helpers, and page-rendering functions. It dispatches requests to route modules. A route validates the request and calls shared business logic; the server queries PostgreSQL, renders HTML, and writes the HTTP response. Static assets and uploaded product images are served by `routes/static.js`.

## Project Structure

```text
.
├── server.js                         # Bootstrap, schema, shared logic, SSR helpers
├── catalog.js                        # Starter seed catalogue and category configuration
├── routes/
│   ├── auth.js                       # Registration, login, logout, Google sign-in
│   ├── products.js                   # Home, catalogue, product, search, wishlist, reviews
│   ├── cart.js                       # Cart operations, reservations, artwork uploads
│   ├── checkout.js                   # Checkout, payment endpoints, invoices
│   ├── account.js                    # Account, orders, tracking, trust/contact pages
│   ├── admin.js                      # Admin products, coupons, orders, notifications
│   └── static.js                     # Public assets, uploaded images, health check
├── services/email.js                 # SMTP service and order-email templates
├── services/object-storage.js        # Shared local/S3-compatible object operations
├── services/storage-migration.js     # Resumable file-reference migration and audit
├── public/
│   ├── app.js                        # Browser interactions
│   ├── styles.css                    # Responsive UI styles
│   └── assets/images/                # WebP-first image-library directory structure
├── scripts/
│   ├── sprint3-smoke.js              # Sprint 3 feature verification script
│   └── cleanup-inventory-smoke.js    # Inventory smoke-test cleanup helper
├── docs/
│   ├── DEPLOYMENT.md                 # Render/Docker deployment and object-storage setup
│   ├── OPERATIONS_RUNBOOK.md         # Backup, restore, email and outage procedures
│   ├── PRODUCTION_ENVIRONMENT_CHECKLIST.md # Deployment variables and release checks
│   ├── GITHUB-AND-CLIENT.md          # Client sharing and GitHub notes
│   └── SOURCE-GUIDE.md               # File-by-file source map
├── IMAGE_LIBRARY.md                  # Image resolver and naming contract
├── IMAGE_ASSET_MANIFEST.md           # Planned image-library inventory
├── PHASE_B_IMAGE_PRODUCTION_SPEC.md  # Premium asset-production brief
├── .env.example                      # Safe configuration template
├── Dockerfile                        # Container build
├── render.yaml                       # Render Blueprint
└── package.json                      # Scripts, dependencies, runtime requirement
```

`scripts/storage-migrate.js` provides the explicit dry-run/execute/audit
commands for transferring existing upload references; `scripts/storage-regression.js`
tests the storage contract with disposable local fixtures.

`data/` and `invoices/` are runtime output locations and are intentionally ignored by Git.

## Core Technical Concepts

### Inventory Reservation

PrintOasis separates warehouse stock from cart reservations:

```text
available = stock - reserved
```

- Adding to cart reserves quantity without reducing physical `stock`.
- Increasing or decreasing cart quantity adjusts only the reservation delta.
- Removing an item, logging out, or expiring a session releases its reservation.
- `createLocalOrder()` runs inside one PostgreSQL transaction with `FOR UPDATE` row locks, creates the order, decrements both `stock` and `reserved`, records order items, applies coupon accounting, and clears the cart atomically.
- Cancelling an order uses `restoreOrderInventory()` and its `inventory_restocked` guard to restore physical stock once.

### Checkout

The checkout route requires an authenticated user and a valid CSRF token. It re-reads the cart, calculates totals and coupons, validates inventory during the transaction, then creates an order and its line items. Cash on delivery calls the local order flow directly. The configured Razorpay path creates a provider order, verifies the returned HMAC signature server-side, then calls the same local order flow. A failed payment releases the session's reservations.

### Authentication and Sessions

Accounts use `scrypt`-hashed passwords. A random, HTTP-only, `SameSite=Lax` `sid` cookie identifies a canonical session payload in Redis; PostgreSQL retains the durable session row referenced by carts and reservation cleanup. Successful registration/login rotates the session ID while transferring that session's cart rows without changing reservations. Logout revokes the old ID. Password changes and resets revoke other sessions. Password-reset and email-verification links use hashed, expiring, single-use tokens delivered through configured SMTP. Google sign-in is configuration-dependent and validates the ID token server-side when `GOOGLE_CLIENT_ID` is configured.

### Security

Current protections include parameterized PostgreSQL statements, database-enforced foreign keys, escaping for rendered HTML, CSRF validation on protected form submissions, authorization checks, safe-local redirects, a configured canonical origin, response security headers, HTTP-only session cookies, shared Redis rate limits, Razorpay signature verification, server-side upload signature/structure checks, bounded multipart uploads, private customer-artwork authorization, and safe MIME/disposition headers.

Current limitations: CSP permits inline scripts/styles for existing SSR/UI behavior; uploads are format-validated but are not malware-scanned; final unreferenced files are retained for manual review because older order rows did not preserve artwork references; and the repository does not include operational observability or an automated security scanner. Email verification does not block an otherwise valid account session. Live Google, Razorpay, SMTP, PostgreSQL, and Redis use require provider configuration and credentials. Production must configure an HTTPS `BASE_URL`; request Host and forwarded host/proto do not define the canonical origin.

### Orders, Tracking, Reviews, and Coupons

Orders progress through `Pending`, `Printing`, `Packed`, `Shipped`, `Delivered`, or `Cancelled`. Admin status updates can record courier, tracking number, URL, and estimated delivery; customers can view tracking and invoices from their account. Reviews require a delivered purchase and prevent duplicate product reviews. Coupons store active state, dates, order thresholds, maximum discounts, limits, and usage accounting, which increments only within successful order creation.

Fulfillment advances only through `Pending → Printing → Packed → Shipped → Delivered`; eligible pre-shipment cancellation remains governed by the payment/refund service. Invalid, skipped, backward, or unpaid-online fulfillment transitions are rejected. Status events retain prior/new states, actor and timestamp. Invoices read saved order-item and invoice snapshots, not the mutable product catalog. See [Invoice and Tax Configuration](docs/INVOICES_AND_TAX.md) for the current inclusive-tax behavior and production review requirements.

### Image Architecture

The image system is prepared for a reusable asset library rather than one image per product. It supports `primary`, `hover`, gallery, category, and placement-specific images with a WebP-first resolver and safe JPG/JPEG/PNG legacy fallback. See [IMAGE_LIBRARY.md](IMAGE_LIBRARY.md), [IMAGE_ASSET_MANIFEST.md](IMAGE_ASSET_MANIFEST.md), and [PHASE_B_IMAGE_PRODUCTION_SPEC.md](PHASE_B_IMAGE_PRODUCTION_SPEC.md).

The infrastructure is implemented. Premium final product photography described in the manifest and Phase B specification is a planned content-production task, not a claim that every asset already exists.

### Runtime File Storage

Production customer artwork and admin-uploaded product images use separate configured S3-compatible buckets through `services/object-storage.js`. Artwork remains private: each download is authorized against the customer's cart/order or admin access before the server fetches and streams the object. Product uploads remain public through the existing application image route, which validates bytes and selects the MIME type; the bucket itself need not be anonymously readable. Legacy filename references continue to resolve during migration. Files under `public/assets/images/` remain release assets and are not copied to object storage. Invoice pages render from immutable PostgreSQL snapshots; generated PDFs are derived and are not durable records. `DATA_DIR/email-outbox/` is an operational local copy, not a delivery queue or shared business store.

Before production cutover, configure the provider endpoint, two buckets, region/addressing mode, and restricted server credentials privately. Run `npm run storage:migrate -- --dry-run`, review all reported missing/unverified references, then run `--execute` and `--audit`. The tool verifies object bytes before changing each database reference and never deletes local files. See [Deployment](docs/DEPLOYMENT.md), the [environment checklist](docs/PRODUCTION_ENVIRONMENT_CHECKLIST.md), and [Operations Runbook](docs/OPERATIONS_RUNBOOK.md).

## Request Lifecycle

```text
Browser request
  -> server.js creates/loads the session and parses POST data
  -> matching route module handles the URL and method
  -> route checks authentication, authorization, CSRF, and input
  -> shared helpers run PostgreSQL queries and business rules
  -> SSR helper produces HTML (or a JSON/static response)
  -> native HTTP response returns to the browser
```

## Installation and Local Setup

**Prerequisite:** Node.js `>=22.5.0` (required by `package.json`).

```powershell
git clone <your-repository-url>
cd PrintOasis-GitHub-Source
npm install
Copy-Item .env.example .env
npm start
```

Create an empty PostgreSQL database, set `DATABASE_URL` in `.env`, then start the application. On first start, PrintOasis validates the connection, applies repeatable SQL migrations from `migrations/`, and seeds the starter catalogue. It fails fast if the URL is missing or PostgreSQL is unreachable.

For local client previews, run:

```powershell
npm run share
```

This uses the existing `share-preview.ps1` script and produces a temporary public preview URL. It is not permanent hosting.

## Environment Variables

Copy `.env.example` to `.env`; never commit the resulting `.env` file.

| Variable | Purpose | Required locally? |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string used by the application. | Yes. |
| `REDIS_URL` | Redis connection for shared sessions and rate limits (`rediss://` enables TLS). | Yes. |
| `REDIS_PREFIX` | Namespace for this app’s session and rate-limit keys. | Optional; defaults to `printoasis`. |
| `REDIS_CONNECT_TIMEOUT_MS` | Redis connection timeout. | Optional. |
| `TRUST_PROXY_HOPS` | Exact trusted proxy hop count used when deriving client IPs; `0` ignores forwarded IP headers. | Optional; defaults to `0`. |
| `PGSSL`, `PGSSL_REJECT_UNAUTHORIZED`, `PGPOOL_MAX`, `PGPOOL_IDLE_TIMEOUT_MS`, `PG_CONNECT_TIMEOUT_MS` | PostgreSQL TLS and pool configuration. | Optional; defaults are supplied. |
| `TEST_DATABASE_URL` | Isolated PostgreSQL database for `npm run db:smoke`; its Supabase project reference must differ from `DATABASE_URL`. | Required for smoke testing only. |
| `TEST_REDIS_URL`, `TEST_REDIS_PREFIX` | Separate Redis endpoint and test namespace used by smoke/regression checks. | Required for Redis tests; endpoint must differ from production Redis. |
| `BASE_URL`, `PORT`, `DATA_DIR` | Canonical public origin, port, and local runtime-data directory for email outbox/staging. | `BASE_URL` defaults to localhost only outside production; HTTPS origin is required in production. `PORT` is optional. Runtime uploads use object storage. |
| `OBJECT_STORAGE_BACKEND` | Runtime upload storage (`local` for development, `s3` for production). | Production requires `s3`; local storage is disabled there. |
| `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_REGION` | S3-compatible endpoint and region. | Required for the production storage backend; use provider-supplied values. |
| `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` | Server-only object storage credentials. | Required secrets for `s3`; set privately, never commit. |
| `OBJECT_STORAGE_PUBLIC_BUCKET`, `OBJECT_STORAGE_PRIVATE_BUCKET` | Separate product-image and customer-artwork buckets. | Required for `s3`; bucket names differ and both should block anonymous access. |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | S3 endpoint addressing mode. | Optional; enable only if the chosen endpoint requires it. |
| `OBJECT_STORAGE_TIMEOUT_MS` | Object request deadline in milliseconds. | Optional; defaults to 30 seconds, capped at 120 seconds. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial/admin account configuration. | Change for production. |
| `EMAIL_DELIVERY_ENABLED`, `EMAIL_FROM` | Enables delivery and defines sender identity. | Optional. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Nodemailer SMTP configuration. | Optional for startup; required for reliable account/order email at launch. Local logs are not an automatic retry queue. |
| `EMAIL_WEBHOOK_URL` | Optional notification webhook fallback. | Optional. |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `OFFICE_ADDRESS`, `CONTACT_RECIPIENT` | Customer-facing support and contact-enquiry details. | Optional; defaults exist. |
| `GST_RATE_BPS` | Inclusive-tax extraction rate in basis points; defaults to `1800` to preserve existing display arithmetic. | Configure only after tax review; it does not change checkout totals. |
| `SELLER_LEGAL_NAME`, `SELLER_REGISTERED_ADDRESS`, `SELLER_GSTIN` | Seller identity snapshotted onto new invoices. | Supply real, verified business values before issuing production invoices; GSTIN only if applicable. |
| `GOOGLE_CLIENT_ID` | Google ID-token audience used by the sign-in flow. | Optional; only needed when Google sign-in is enabled. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay online-payment configuration. | Optional; required only for the provider flow. |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured for the Razorpay webhook endpoint at `/webhooks/razorpay`. | Optional until webhook delivery is enabled. |

## Testing and Validation

The repository uses focused Node regression scripts rather than Jest, Vitest, or Cypress. GitHub Actions runs the checks on pushes to `main` and pull requests using disposable PostgreSQL/Redis services where needed. The validation commands are:

```powershell
npm run check
npm run storage:smoke
npm run upload:security:check
npm run ops:check
# Set DATABASE_URL and TEST_DATABASE_URL in the process environment first.
npm run db:smoke
npm run db:order-integrity:smoke
```

`npm run check` runs Node syntax checks across the server, services, routes, and browser JavaScript. `npm run db:smoke` runs customer/admin/inventory and Redis-session/rate-limit workflows against `TEST_DATABASE_URL` and `TEST_REDIS_URL`; both test endpoints are checked for separation from production configuration. `npm run redis:smoke` runs the isolated Redis service checks. No smoke runner flushes a Redis database. The PowerShell smoke entry points delegate to the PostgreSQL/Redis-isolated workflow.

`npm run ops:check` tests SMTP configuration/send success/failure through a fake transport and checks generic dependency-readiness responses. It does not connect to SMTP or deliver email.

The workflow is [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It uses `npm ci`, read-only repository permissions, disposable PostgreSQL/Redis services, and no production secrets or external service credentials. A CI-only migration check accepts only the workflow's fixed local PostgreSQL target and verifies clean/repeated migration application. The destructive `db:smoke` remains a separately guarded operator/staging test because its current database isolation check requires distinct Supabase project references; CI does not bypass that guard or run against production.

`npm run db:order-integrity:smoke` runs the Stage 5 tax/invoice/order-state regression against the isolated `TEST_DATABASE_URL`; it uses a uniquely namespaced local test Redis endpoint and does not call a live payment provider.

## Deployment

The repository includes a [Dockerfile](Dockerfile), [Render Blueprint](render.yaml), and [deployment guide](docs/DEPLOYMENT.md). The included Render configuration mounts `/var/data` for local email-outbox operational copies; runtime uploads use the separately configured object-storage service. Production also requires PostgreSQL and Redis. Configure secrets in the host's environment settings, not in Git. Use the [pre-production environment checklist](docs/PRODUCTION_ENVIRONMENT_CHECKLIST.md) and [operations runbook](docs/OPERATIONS_RUNBOOK.md) for release/recovery decisions.

For PostgreSQL backup/restore, object-storage migration/recovery, SMTP failures, Redis outages, migration recovery, and payment-provider incidents, see the [operations runbook](docs/OPERATIONS_RUNBOOK.md). `/healthz` checks PostgreSQL, Redis, and object storage; it does not verify SMTP or Razorpay availability. The email outbox remains instance-local operational logging, not a delivery queue.

Google, Razorpay, SMTP, and hosted deployment remain configuration-dependent; CI validates code but does not deploy. Render startup applies migrations and waits for the configured required dependencies.

## Design Decisions

| Decision | Why it fits this project | Trade-off |
| --- | --- | --- |
| Native Node HTTP, not Express | Keeps the request lifecycle explicit and dependency surface small. | More routing and middleware responsibilities are implemented manually. |
| PostgreSQL with `pg` pooling | Supports durable relational data, transactions, row locking, and a path to production write concurrency. | Requires a separately provisioned database and connection management. |
| SSR plus vanilla JS | Fast first HTML response, straightforward SEO-friendly markup, and no client framework build step. | UI composition is less componentized than a framework application. |
| Reserved inventory | Prevents a cart from reducing physical stock while still protecting available quantity. | Requires careful release paths for cart changes, logout, expiry, failure, and cancellation. |
| Modular routes | Keeps feature request handlers separate while retaining shared rendering/business logic. | `server.js` remains the central application module. |

## Current Status

**Implemented:** the core print-commerce storefront, admin workflow, reservation-based inventory, checkout and COD, configured Razorpay integration path, order tracking, reviews, coupons, image-library infrastructure, Redis-shared sessions and rate limits, trust/support pages, Docker/Render configuration, and isolated smoke checks.

**Configuration-dependent:** live SMTP delivery, Google sign-in, Razorpay payments, public sharing, and hosted deployment require the correct credentials, approved accounts, and environment variables.

**Implemented operations:** GitHub Actions CI, JSON request/error logs with validated request IDs, dependency classifications, `/healthz` readiness, and deployment/recovery guidance. There are no application metrics or automated alert rules; use the hosting platform's logs, deploy events, and health notifications, with manual payment/webhook reconciliation.

**Future / production-scale improvements:** CDN delivery, background workers, metrics, and alert automation remain future work. Runtime uploads use configurable object storage; production provider and recovery controls still require selection and verification.

## Documentation

- [Source guide](docs/SOURCE-GUIDE.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Pre-production environment checklist](docs/PRODUCTION_ENVIRONMENT_CHECKLIST.md)
- [Operations runbook](docs/OPERATIONS_RUNBOOK.md)
- [GitHub and client sharing guide](docs/GITHUB-AND-CLIENT.md)
- [Image library contract](IMAGE_LIBRARY.md)
- [Image asset manifest](IMAGE_ASSET_MANIFEST.md)
- [Phase B image-production specification](PHASE_B_IMAGE_PRODUCTION_SPEC.md)

## Author / Project

PrintOasis is an interview-ready full-stack print-commerce project maintained as a single Node.js and PostgreSQL application.
