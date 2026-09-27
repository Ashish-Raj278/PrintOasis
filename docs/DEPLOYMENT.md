# Production Deployment

This is the path for a real client website. The app must be deployed to a
hosting provider so it has a permanent HTTPS URL and keeps running when your
computer is off.

## Recommended Host: Render

The project includes:

- `Dockerfile` - builds the production app with Node.js 24.
- `render.yaml` - Render Blueprint for a web service.
- Persistent data path: `/var/data` for uploads and email-outbox records.
- PostgreSQL connection supplied through `DATABASE_URL`.
- Redis connection supplied through `REDIS_URL` for shared sessions and rate limits.
- Health check path: `/healthz`.

Render should attach a persistent disk at `/var/data` for uploads and email-outbox records. Users, sessions, carts, orders, and inventory require a separately provisioned PostgreSQL database.

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

Set these before sharing the production admin link. `DATABASE_URL` is required and must point to the managed PostgreSQL database:

```text
DATABASE_URL=postgresql://user:password@host:5432/printoasis
PGSSL=true
REDIS_URL=rediss://user:password@managed-redis-host:6380
REDIS_PREFIX=printoasis
TRUST_PROXY_HOPS=1
BASE_URL=https://your-final-domain.example
```

Redis is required at startup and is included in `/healthz`. Use a managed Redis endpoint with TLS (`rediss://`) in production. Sessions are shared in Redis while PostgreSQL retains the durable session/cart anchor used for reservation cleanup. Rate-limit counters use atomic Redis increments. Never point `TEST_REDIS_URL` at the production Redis endpoint. `TRUST_PROXY_HOPS` defaults to `0`; it is used only when deriving client IPs and should be set to the exact trusted proxy hop count after ensuring the app cannot be reached around that proxy. `BASE_URL` is required in production, must be the canonical HTTPS origin, and is used for generated links and Secure-cookie decisions; arbitrary Host and forwarded host/proto values are ignored.

Initial shared rate limits (fixed windows): login 20/IP and 8/IP+account per 15 minutes; registration 10/IP per 15 minutes; Google sign-in 20/IP per 15 minutes; password reset request 10/IP and 5/IP+account per 15 minutes; reset and email-verification submissions 10/IP and 5/IP+token per 15 minutes; logout 30/IP and 10/session+IP per 15 minutes; password changes 10/IP and 5/user+IP per 15 minutes; contact 5/IP and tracking 20/IP per 10 minutes; payment 20/IP and 20/user+IP per 10 minutes; cart writes 60/IP and 60/session-or-user+IP per minute; multipart customer artwork uploads 5/IP and 5/session-or-user+IP per 10 minutes; checkout 10/IP and 10/session-or-user+IP per 10 minutes; admin writes 60/IP and 60/user+IP per minute, with product saves/uploads limited to 10/IP and 10/user+IP per 10 minutes. Limit responses are generic `429` responses; Redis failures fail closed with `503`.

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

Uploaded artwork, product images, and local email-outbox files live under the persistent disk path `/var/data`. PostgreSQL remains external to that disk. Customer artwork is not served from the public upload URL space: authenticated customers can retrieve only artwork associated with their cart or orders, and admins can retrieve only files that have a database reference. Public product images are served from a separate directory with server-detected image MIME types and `nosniff`.

Customer artwork is limited to one file up to 25 MiB per request; product-image uploads allow up to 10 files, 8 MiB each and 32 MiB aggregate. Request bodies have endpoint-specific caps, and supported PDF/AI/PSD/PNG/JPEG/WebP files are signature/structure checked before storage; browser MIME values are ignored. Filenames are randomized by the server. Failed database writes remove files created by that request. Startup removes abandoned `.uploading` staging files older than 24 hours; completed files are deliberately retained because older order rows may not contain artwork references. Operators should review completed unreferenced files before manual deletion. Uploads are not malware-scanned, so artwork still requires normal prepress review and a separately selected scanning process if business risk calls for one.

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
