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
- Configurable Nodemailer SMTP delivery with a local email outbox fallback.
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
| Security | Password hashing with `scrypt`, HTTP-only session cookies, CSRF tokens, role checks, HTML escaping, safe upload checks, and Razorpay signature verification. |
| Images | A WebP-first library resolver supports primary, hover, gallery, category, and section-specific images while preserving legacy uploads. |

## Tech Stack

| Technology | Purpose |
| --- | --- |
| Node.js 22.5+ | Application runtime. |
| Native Node.js HTTP | Request handling and HTTP responses without a web framework. |
| `pg` | PostgreSQL connection-pool persistence for users, products, sessions, carts, orders, coupons, reviews, and related records. |
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
├── public/
│   ├── app.js                        # Browser interactions
│   ├── styles.css                    # Responsive UI styles
│   └── assets/images/                # WebP-first image-library directory structure
├── scripts/
│   ├── sprint3-smoke.js              # Sprint 3 feature verification script
│   └── cleanup-inventory-smoke.js    # Inventory smoke-test cleanup helper
├── docs/
│   ├── DEPLOYMENT.md                 # Render/Docker deployment notes
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

Accounts use `scrypt`-hashed passwords. `sessions` are stored in PostgreSQL and represented by a random, HTTP-only, `SameSite=Lax` cookie. Each session has a CSRF token and a 30-day expiry. `requireAuth()` protects customer pages; `requireAdmin()` additionally checks `users.is_admin` for admin pages. Google sign-in is configuration-dependent and validates the ID token server-side when `GOOGLE_CLIENT_ID` is configured.

### Security

Current protections include parameterized PostgreSQL statements, database-enforced foreign keys, escaping for rendered HTML, CSRF validation on protected form submissions, authorization checks, filename/path checks for served or uploaded content, upload allowlists and size limits, HTTP-only session cookies, and Razorpay signature verification.

Current limitations: the repository does not yet include operational observability, rate limiting, a full CSP/security-header policy, or an automated security scanner. Live Google, Razorpay, and SMTP use require real provider credentials and production configuration.

### Orders, Tracking, Reviews, and Coupons

Orders progress through `Pending`, `Printing`, `Packed`, `Shipped`, `Delivered`, or `Cancelled`. Admin status updates can record courier, tracking number, URL, and estimated delivery; customers can view tracking and invoices from their account. Reviews require a delivered purchase and prevent duplicate product reviews. Coupons store active state, dates, order thresholds, maximum discounts, limits, and usage accounting, which increments only within successful order creation.

### Image Architecture

The image system is prepared for a reusable asset library rather than one image per product. It supports `primary`, `hover`, gallery, category, and placement-specific images with a WebP-first resolver and safe JPG/JPEG/PNG legacy fallback. See [IMAGE_LIBRARY.md](IMAGE_LIBRARY.md), [IMAGE_ASSET_MANIFEST.md](IMAGE_ASSET_MANIFEST.md), and [PHASE_B_IMAGE_PRODUCTION_SPEC.md](PHASE_B_IMAGE_PRODUCTION_SPEC.md).

The infrastructure is implemented. Premium final product photography described in the manifest and Phase B specification is a planned content-production task, not a claim that every asset already exists.

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
| `PGSSL`, `PGSSL_REJECT_UNAUTHORIZED`, `PGPOOL_MAX`, `PGPOOL_IDLE_TIMEOUT_MS`, `PG_CONNECT_TIMEOUT_MS` | PostgreSQL TLS and pool configuration. | Optional; defaults are supplied. |
| `TEST_DATABASE_URL` | Isolated PostgreSQL database for `npm run db:smoke`; its Supabase project reference must differ from `DATABASE_URL`. | Required for smoke testing only. |
| `BASE_URL`, `PORT`, `DATA_DIR` | Public base URL, port, and runtime-data directory for uploads and email outbox. | `PORT` is optional; the defaults work locally. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial/admin account configuration. | Change for production. |
| `EMAIL_DELIVERY_ENABLED`, `EMAIL_FROM` | Enables delivery and defines sender identity. | Optional. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Nodemailer SMTP configuration. | Optional; otherwise email is logged to the outbox. |
| `EMAIL_WEBHOOK_URL` | Optional notification webhook fallback. | Optional. |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `OFFICE_ADDRESS`, `CONTACT_RECIPIENT` | Customer-facing support and contact-enquiry details. | Optional; defaults exist. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google provider configuration template. | Optional; sign-in UI is configuration-dependent. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay online-payment configuration. | Optional; required only for the provider flow. |

## Testing and Validation

The repository does not use Jest, Vitest, Cypress, or a CI workflow. Its current validation commands are:

```powershell
npm run check
# Set DATABASE_URL and TEST_DATABASE_URL in the process environment first.
npm run db:smoke
```

`npm run check` runs Node syntax checks across the server, routes, database service, email service, and browser JavaScript. `npm run db:smoke` starts the application on an ephemeral port and runs the customer, admin, inventory, rollback, and concurrency workflow exclusively against `TEST_DATABASE_URL`. The guard extracts Supabase project references from direct database hosts or Session Pooler usernames and requires the production and test references to differ. Unknown or matching references are rejected. Both variables must be set in the process environment before running the command. The PowerShell smoke entry points delegate to that same isolated workflow.

## Deployment

The repository includes a [Dockerfile](Dockerfile), [Render Blueprint](render.yaml), and [deployment guide](docs/DEPLOYMENT.md). The included Render configuration mounts `/var/data` for uploads and email-outbox persistence; production also requires a managed PostgreSQL `DATABASE_URL`. Configure secrets in the host's environment settings, not in Git.

Google, Razorpay, and SMTP are implementation-ready but configuration-dependent; this repository does not claim a live payment deployment or a CI/CD pipeline.

## Design Decisions

| Decision | Why it fits this project | Trade-off |
| --- | --- | --- |
| Native Node HTTP, not Express | Keeps the request lifecycle explicit and dependency surface small. | More routing and middleware responsibilities are implemented manually. |
| PostgreSQL with `pg` pooling | Supports durable relational data, transactions, row locking, and a path to production write concurrency. | Requires a separately provisioned database and connection management. |
| SSR plus vanilla JS | Fast first HTML response, straightforward SEO-friendly markup, and no client framework build step. | UI composition is less componentized than a framework application. |
| Reserved inventory | Prevents a cart from reducing physical stock while still protecting available quantity. | Requires careful release paths for cart changes, logout, expiry, failure, and cancellation. |
| Modular routes | Keeps feature request handlers separate while retaining shared rendering/business logic. | `server.js` remains the central application module. |

## Current Status

**Implemented:** the core print-commerce storefront, admin workflow, reservation-based inventory, checkout and COD, configured Razorpay integration path, order tracking, reviews, coupons, image-library infrastructure, trust/support pages, Docker/Render configuration, and local smoke checks.

**Configuration-dependent:** live SMTP delivery, Google sign-in, Razorpay payments, public sharing, and hosted deployment require the correct credentials, approved accounts, and environment variables.

**Future / production-scale improvements:** Redis, object storage, CDN delivery, background workers, stronger payment idempotency, observability, rate limiting, and CI/CD are not current implementation details.

## Documentation

- [Source guide](docs/SOURCE-GUIDE.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [GitHub and client sharing guide](docs/GITHUB-AND-CLIENT.md)
- [Image library contract](IMAGE_LIBRARY.md)
- [Image asset manifest](IMAGE_ASSET_MANIFEST.md)
- [Phase B image-production specification](PHASE_B_IMAGE_PRODUCTION_SPEC.md)

## Author / Project

PrintOasis is an interview-ready full-stack print-commerce project maintained as a single Node.js and PostgreSQL application.
