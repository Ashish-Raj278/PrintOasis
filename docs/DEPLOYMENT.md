# Production Deployment

This is the path for a real client website. The app must be deployed to a
hosting provider so it has a permanent HTTPS URL and keeps running when your
computer is off.

## Recommended Host: Render

The project includes:

- `Dockerfile` - builds the production app with Node.js 24.
- `render.yaml` - Render Blueprint for a web service.
- Shared S3-compatible object storage for runtime uploads; `/var/data` remains for local email-outbox operational copies.
- PostgreSQL connection supplied through `DATABASE_URL`.
- Redis connection supplied through `REDIS_URL` for shared sessions and rate limits.
- Health check path: `/healthz`.

Render's Blueprint retains `/var/data` for local email-outbox records. Runtime artwork and admin-uploaded product images use configured shared object storage. Users, sessions, carts, orders, and inventory require PostgreSQL; sessions/rate limits use Redis.

## Steps

1. Upload this folder to GitHub.
2. Sign in to Render.
3. Create a new Blueprint or Web Service from the GitHub repository.
4. Confirm the service uses the included `render.yaml`.
5. Deploy.
6. Render will provide a URL like:

```text
https://printoasis.onrender.com
```

That is the client-ready website URL. It is not localhost and does not depend
on your laptop staying on.

## Required Environment Variables

Use the [production environment checklist](PRODUCTION_ENVIRONMENT_CHECKLIST.md)
as the complete variable-by-variable release checklist. The values below are
illustrative names only: do not copy sample credentials or business identity
into deployment settings. Configure each secret directly in the hosting
provider's private environment settings.

Set these before sharing the production admin link. `DATABASE_URL` is required and must point to the managed PostgreSQL database:

```text
DATABASE_URL=postgresql://user:password@host:5432/printoasis
PGSSL=true
REDIS_URL=rediss://user:password@managed-redis-host:6380
REDIS_PREFIX=printoasis
TRUST_PROXY_HOPS=0
BASE_URL=https://your-final-domain.example
OBJECT_STORAGE_BACKEND=s3
OBJECT_STORAGE_ENDPOINT=<provider-supplied-endpoint>
OBJECT_STORAGE_REGION=<provider-supplied-region>
OBJECT_STORAGE_ACCESS_KEY_ID=<private-server-credential>
OBJECT_STORAGE_SECRET_ACCESS_KEY=<private-server-credential>
OBJECT_STORAGE_PUBLIC_BUCKET=<private-bucket-name>
OBJECT_STORAGE_PRIVATE_BUCKET=<private-bucket-name>
OBJECT_STORAGE_FORCE_PATH_STYLE=false
OBJECT_STORAGE_TIMEOUT_MS=30000
GST_RATE_BPS=1800
SELLER_LEGAL_NAME=
SELLER_REGISTERED_ADDRESS=
SELLER_GSTIN=
```

The GST rate shown is only the compatibility default for the application's
existing tax-inclusive invoice arithmetic; it is not confirmation of the
correct tax rate or treatment. Checkout totals are not increased by this
setting. Before launch, obtain business/tax review for the actual product and
delivery tax treatment, then set the verified rate. Supply the real seller legal
name, registered address, applicable GSTIN, and verified `SUPPORT_EMAIL` /
`SUPPORT_PHONE` through private deployment configuration. Do not use sample
contact/address defaults as verified legal seller identity. See
[Invoice and Tax Configuration](INVOICES_AND_TAX.md).

Redis is required at startup and is included in `/healthz`. Use a managed Redis endpoint with TLS (`rediss://`) in production. Sessions are shared in Redis while PostgreSQL retains the durable session/cart anchor used for reservation cleanup. Rate-limit counters use atomic Redis increments. Never point `TEST_REDIS_URL` at the production Redis endpoint. `TRUST_PROXY_HOPS` defaults to `0`; it is used only when deriving client IPs and should be set to the exact trusted proxy hop count after ensuring the app cannot be reached around that proxy. `BASE_URL` is required in production, must be the canonical HTTPS origin, and is used for generated links and Secure-cookie decisions; arbitrary Host and forwarded host/proto values are ignored.

Initial shared rate limits (fixed windows): login 20/IP and 8/IP+account per 15 minutes; registration 10/IP per 15 minutes; Google sign-in 20/IP per 15 minutes; password reset request 10/IP and 5/IP+account per 15 minutes; reset and email-verification submissions 10/IP and 5/IP+token per 15 minutes; logout 30/IP and 10/session+IP per 15 minutes; password changes 10/IP and 5/user+IP per 15 minutes; contact 5/IP and tracking 20/IP per 10 minutes; payment 20/IP and 20/user+IP per 10 minutes; cart writes 60/IP and 60/session-or-user+IP per minute; multipart customer artwork uploads 5/IP and 5/session-or-user+IP per 10 minutes; checkout 10/IP and 10/session-or-user+IP per 10 minutes; admin writes 60/IP and 60/user+IP per minute, with product saves/uploads limited to 10/IP and 10/user+IP per 10 minutes. Limit responses are generic `429` responses; Redis failures fail closed with `503`.

The Render Blueprint declares `DATABASE_URL`, `REDIS_URL`, `BASE_URL`,
administrator credentials, and SMTP host/sender credentials as dashboard-supplied
values (`sync: false`); no real values are stored in the repository. Render
provides the runtime `PORT`; the application defaults to 3000 elsewhere. The
Blueprint explicitly enables email delivery and declares a sample SMTP port and
transport mode. Confirm the correct `TRUST_PROXY_HOPS` for the actual network
path instead of copying a generic value. Startup waits for PostgreSQL,
migrations, Redis, and object storage before listening. `/healthz` returns only
generic dependency readiness; it does not probe SMTP, Razorpay, or email
delivery. `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are not consumed by
the current server; Google sign-in uses `GOOGLE_CLIENT_ID` for ID-token
audience validation. See the [operations runbook](OPERATIONS_RUNBOOK.md) for
recovery procedures and project-specific backup verification.

```text
ADMIN_EMAIL=owner-or-admin@example.com
ADMIN_PASSWORD=a-strong-private-password
```

For email notifications through Nodemailer:

```text
EMAIL_FROM=orders@your-domain.com
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
```

Also configure `SMTP_SECURE` according to the provider's documented connection
mode and keep `EMAIL_DELIVERY_ENABLED=true`. SMTP is not verified at startup,
and email failures have no automatic retry worker. Password-reset and
verification token rows are persisted before send; a failed reset email can be
requested again after recovery, but there is no verification-email resend
route. Test delivery only to an approved controlled mailbox.

Customer artwork and admin product-image uploads are stored in separate S3-compatible buckets through the storage service. Bucket objects should not be anonymously readable: artwork downloads are authorized against the database and streamed by the application; product uploads are also served through the existing application route with signature validation, server-detected MIME types, and `nosniff`. Image-library assets under `public/assets/images/` remain source-controlled release assets. `/var/data/email-outbox/` is still local and contains operational copies, not a delivery queue; it is not a cross-instance dependency for order correctness. Invoice pages render from immutable PostgreSQL snapshots; the PDF helper is currently not called and no invoice PDF is required for recovery.

Customer artwork remains limited to one file up to 25 MiB per request; product-image uploads allow up to 10 files, 8 MiB each and 32 MiB aggregate. Supported formats are signature/structure checked before object upload; browser MIME values are ignored and filenames are randomized. Database failure triggers best-effort object deletion; a failed compensation can leave an orphan, detectable with `npm run storage:migrate -- --audit`. Missing objects are surfaced as unavailable/not found rather than replaced with fake content. Uploads are not malware-scanned, so artwork still requires normal prepress review and a separately selected scanning process if business risk calls for one.

### Runtime object storage setup and migration

The production Blueprint requires `OBJECT_STORAGE_BACKEND=s3` and private
dashboard values for endpoint, region, credentials, and distinct public/private
bucket names. The provider/account is intentionally not preselected. Choose an
S3-compatible service that supports the required server-side API operations and
document its versioning, lifecycle, durability, and recovery controls; those
capabilities are provider-specific and must be verified. Keep both buckets
private at the provider ACL/policy level. Product images are public only through
the PrintOasis application route; customer artwork is always access-checked.

The implementation uses the AWS SDK for JavaScript v3 S3 client, so an
S3-compatible endpoint can be selected without provider-specific route code.
Supabase Storage is a viable candidate with private buckets and server-side
access, but its documented S3 compatibility does not provide S3 object
versioning; recovery therefore depends on a separately verified backup/copy
policy. See [Supabase S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility),
[Supabase bucket access](https://supabase.com/docs/guides/storage/buckets/fundamentals),
and [AWS SDK for JavaScript v3 S3 examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).
PrintOasis selects the S3 API/storage abstraction, not a named provider. Select
the actual provider only after verifying private access, versioning/recovery,
lifecycle, availability, and cost.

Keep `public/assets/images/` in Git/release artifacts. Do not copy it to runtime
storage. The migration tool scans current cart/order artwork and product image
references, copies locally referenced objects, verifies bytes, then changes
database references to namespaced keys. It supports repeatable execution and
never removes the source files. With approved production configuration:

```sh
npm run storage:migrate -- --dry-run
npm run storage:migrate -- --execute
npm run storage:migrate -- --audit
```

Review every nonzero `missingLocalAndRemote`, `unverified`, `failed`, or
`missingObjects` count before cutover. Keep local sources until the database/
object audit and authorized historical artwork checks pass. The migration
updates DB references and is an approved maintenance action, not a routine
startup task. After cutover, multiple app instances share uploads via the
database and object storage. Email outbox files remain instance-local logs;
historical invoices remain reconstructible from DB snapshots.

For local development, run a local Redis server and set `REDIS_URL` to it. Tests require a separate `TEST_REDIS_URL` endpoint and use a run-specific `REDIS_PREFIX`; the smoke runner rejects a test endpoint that matches the configured production Redis host and port. The regression runner does not flush Redis databases.

## Custom Domain

After deployment, add the client's domain in Render's Custom Domains settings,
then update DNS at the domain provider. When the domain is verified, Render
automatically serves it over HTTPS.

## Google Sign-In

After the final URL is known, create or update the Google OAuth Web Client:

- Authorized JavaScript origin: `https://your-final-domain.com`
- Authorized redirect URI: `https://your-final-domain.com/auth/google`

Then set this environment variable in Render:

```text
GOOGLE_CLIENT_ID=your-google-client-id
```

If you use a custom domain, also set:

```text
BASE_URL=https://your-final-domain.com
```

## Razorpay

After the client has a Razorpay account and approved keys, set these Render
environment variables:

```text
RAZORPAY_KEY_ID=your-key-id
RAZORPAY_KEY_SECRET=your-key-secret
RAZORPAY_WEBHOOK_SECRET=your-webhook-secret
```

Configure the provider webhook URL as `https://your-domain.com/webhooks/razorpay` and subscribe to `payment.authorized`, `payment.captured`, and `payment.failed`. The endpoint authenticates the raw request body using `RAZORPAY_WEBHOOK_SECRET`; it does not use browser sessions. Refund events are stored for recognition only and do not trigger refund processing. Do not commit these secrets to GitHub.
