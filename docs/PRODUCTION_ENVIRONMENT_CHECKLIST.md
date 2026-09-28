# PrintOasis Pre-Production Environment Checklist

Use this checklist with the actual deployment dashboard. Values marked for
business, provider, or dashboard verification must be supplied by the owner;
the repository cannot establish them. Never put real secrets in Git, issue
text, screenshots, or command history. The committed `.env.example` contains
placeholders only.

## Application and infrastructure variables

Classification uses `REQUIRED`, `OPTIONAL`, `PRODUCTION-ONLY`, and `SECRET`.
An optional value can still be a launch blocker when its feature is being
offered.

| Variable | Classification | Production action / verification |
| --- | --- | --- |
| `NODE_ENV` | REQUIRED, PRODUCTION-ONLY | Set `production`; startup requires an HTTPS `BASE_URL` in this mode. |
| `PORT` | OPTIONAL, PRODUCTION-ONLY | Supplied by the host; app defaults to `3000` if absent. Do not hard-code the host's assigned port. |
| `DATABASE_URL` | REQUIRED, PRODUCTION-ONLY, SECRET | Private PostgreSQL connection string for the intended production project. Verify TLS/network restrictions and the target project before release. Never substitute `TEST_DATABASE_URL`. |
| `PGSSL` | OPTIONAL, PRODUCTION-ONLY | Production mode enables PostgreSQL TLS even if this is unset. Set `true` when TLS is required outside production mode. |
| `PGSSL_REJECT_UNAUTHORIZED` | OPTIONAL, PRODUCTION-ONLY | Keep unset/`true` unless the database provider documents a certificate requirement that needs another setting. Do not disable verification as a routine workaround. |
| `PGPOOL_MAX` | OPTIONAL | Connection-pool size; confirm it against database connection limits before changing the default. |
| `PGPOOL_IDLE_TIMEOUT_MS` | OPTIONAL | Pool idle timeout; default is supplied by the app. |
| `PG_CONNECT_TIMEOUT_MS` | OPTIONAL | Connection timeout; default is supplied by the app. |
| `REDIS_URL` | REQUIRED, PRODUCTION-ONLY, SECRET | Shared Redis endpoint for canonical sessions and rate limits. Use `rediss://` when supported by the selected managed service. This must not be a test endpoint. |
| `REDIS_PREFIX` | OPTIONAL, PRODUCTION-ONLY | Namespace for this deployment; use a unique stable production prefix. Default is `printoasis`. |
| `REDIS_CONNECT_TIMEOUT_MS` | OPTIONAL | Redis connect timeout; default is supplied by the service. |
| `BASE_URL` | REQUIRED, PRODUCTION-ONLY | Canonical public HTTPS origin, without an untrusted request-derived host. Verify login, reset, verification, and order links use this origin. |
| `DATA_DIR` | REQUIRED, PRODUCTION-ONLY | Point to the host's runtime disk for local email-outbox operational copies and staging. Render uses `/var/data`; this data is instance-local. Uploaded objects use shared object storage. |
| `OBJECT_STORAGE_BACKEND` | REQUIRED, PRODUCTION-ONLY | Set `s3`; production explicitly rejects local-only upload storage. |
| `OBJECT_STORAGE_ENDPOINT` | REQUIRED, PRODUCTION-ONLY | Provider-supplied S3-compatible endpoint; verify HTTPS and endpoint ownership. |
| `OBJECT_STORAGE_REGION` | REQUIRED, PRODUCTION-ONLY | Provider-supplied region/region token expected by its S3 API. |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | REQUIRED, PRODUCTION-ONLY, SECRET | Restricted server credential for the configured buckets; store privately. |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | REQUIRED, PRODUCTION-ONLY, SECRET | Matching private server credential. Never expose to browsers or logs. |
| `OBJECT_STORAGE_PUBLIC_BUCKET` | REQUIRED, PRODUCTION-ONLY | Distinct product-image bucket. Keep provider-level anonymous access disabled; PrintOasis serves validated images. |
| `OBJECT_STORAGE_PRIVATE_BUCKET` | REQUIRED, PRODUCTION-ONLY | Distinct private customer-artwork bucket. Never enable anonymous reads. |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | OPTIONAL, PRODUCTION-ONLY | Default `false`; enable only if the selected compatible endpoint requires path-style addressing. |
| `OBJECT_STORAGE_TIMEOUT_MS` | OPTIONAL, PRODUCTION-ONLY | Request deadline in milliseconds; default `30000`, bounded by the service to 120000. Confirm it against provider latency and upload sizes. |
| `TRUST_PROXY_HOPS` | REQUIRED, PRODUCTION-ONLY | Configure only after verifying the real proxy chain and ensuring direct access cannot bypass it. The default `0` does not trust forwarded client-IP headers. |
| `ADMIN_EMAIL` | REQUIRED, PRODUCTION-ONLY | Set the real initial administrator account email privately. Verify admin access before launch. |
| `ADMIN_PASSWORD` | REQUIRED, PRODUCTION-ONLY, SECRET | Strong private initial bootstrap password. Do not assume changing this environment variable later rotates an existing account password; use the account password workflow. |
| `ADMIN_USER_ID` | OPTIONAL, CLI-ONLY | Used only by `make-admin.js` when promoting an existing user; not a server runtime setting. |
| `EMAIL_DELIVERY_ENABLED` | OPTIONAL, PRODUCTION-ONLY | Must be `true` if production email is being offered; set `false` during controlled maintenance that must suppress outgoing mail. |
| `EMAIL_FROM` | REQUIRED WHEN EMAIL IS ENABLED, PRODUCTION-ONLY | Verified sender name/address on the selected sending domain. Current sample default is not a production identity. |
| `SMTP_HOST` | REQUIRED WHEN EMAIL IS ENABLED, PRODUCTION-ONLY | Supply the chosen provider's real SMTP hostname privately. Provider selection remains an owner decision. |
| `SMTP_PORT` | REQUIRED WHEN EMAIL IS ENABLED, PRODUCTION-ONLY | Use the port documented by the provider. The template's `587` is an example, not a provider selection. |
| `SMTP_SECURE` | REQUIRED WHEN EMAIL IS ENABLED, PRODUCTION-ONLY | Set according to the provider's TLS mode; Nodemailer uses implicit TLS for port `465` automatically. Verify the provider's documented submission settings. |
| `SMTP_USER` | OPTIONAL, SECRET | Required only when the selected SMTP service requires authentication. |
| `SMTP_PASS` | OPTIONAL, SECRET | Required only when SMTP authentication is used. Store only in private deployment configuration. |
| `EMAIL_WEBHOOK_URL` | OPTIONAL, PRODUCTION-ONLY, SECRET | Fallback used only when SMTP is not configured; not a retry after SMTP failure. Protect credentials embedded in the URL. |
| `CONTACT_RECIPIENT` | OPTIONAL, PRODUCTION-ONLY | Verified mailbox that receives contact requests; defaults to the admin/support address. |
| `SUPPORT_EMAIL` | OPTIONAL, PRODUCTION-ONLY | Replace/confirm the current default with a monitored customer-support mailbox. |
| `SUPPORT_PHONE` | OPTIONAL, PRODUCTION-ONLY | Replace/confirm the current default with a monitored support number. |
| `OFFICE_ADDRESS` | OPTIONAL, PRODUCTION-ONLY | Confirm the displayed contact address. It is not a substitute for the registered seller address. |
| `GOOGLE_CLIENT_ID` | OPTIONAL, PRODUCTION-ONLY | Needed only when Google sign-in is enabled; configure the correct client audience. The current server does not read `GOOGLE_CLIENT_SECRET` or `GOOGLE_REDIRECT_URI`. |
| `RAZORPAY_KEY_ID` | OPTIONAL, PRODUCTION-ONLY | Needed only when live Razorpay payments are enabled. Obtain through the approved merchant account. |
| `RAZORPAY_KEY_SECRET` | OPTIONAL, PRODUCTION-ONLY, SECRET | Needed only for the live provider flow; store privately. |
| `RAZORPAY_WEBHOOK_SECRET` | OPTIONAL, PRODUCTION-ONLY, SECRET | Needed only when Razorpay webhooks are enabled; configure the same private secret at the provider and application. |
| `GST_RATE_BPS` | OPTIONAL, PRODUCTION-ONLY | Existing compatibility default is `1800` basis points. Confirm the applicable treatment/rate with the business tax adviser; this setting does not change checkout totals. |
| `SELLER_LEGAL_NAME` | REQUIRED BEFORE PRODUCTION INVOICES, PRODUCTION-ONLY | Supply the verified legal seller name. Do not infer it from the PrintOasis brand. |
| `SELLER_REGISTERED_ADDRESS` | REQUIRED BEFORE PRODUCTION INVOICES, PRODUCTION-ONLY | Supply the verified registered address. |
| `SELLER_GSTIN` | OPTIONAL WHEN APPLICABLE, PRODUCTION-ONLY | Supply only a verified GSTIN when applicable; otherwise leave empty. |

## Test-only variables

These variables are for isolated regression processes only. Do not configure
them as production service variables or point them at production resources.

| Variable | Classification | Use |
| --- | --- | --- |
| `TEST_DATABASE_URL` | OPTIONAL, TEST-ONLY, SECRET | Destructive PostgreSQL test target. Existing guard requires a supported isolated Supabase project reference different from `DATABASE_URL`. |
| `TEST_REDIS_URL` | OPTIONAL, TEST-ONLY, SECRET | Separate disposable Redis endpoint, validated against `REDIS_URL`. |
| `TEST_REDIS_PREFIX` | OPTIONAL, TEST-ONLY | Isolated Redis namespace for test keys. |
| `PRODUCTION_DATABASE_URL` | OPTIONAL, TEST-ONLY, SECRET | Guard input used by the cross-process Redis test helper; never used as its destructive target. |
| `PRODUCTION_REDIS_URL` | OPTIONAL, TEST-ONLY, SECRET | Guard input used by the test helper to prove endpoint separation. |
| `REDIS_TEST_CHILD` | OPTIONAL, TEST-ONLY | Internal child-process marker required by the isolated regression helper. |

The app itself does not define a separate session-signing secret variable;
session IDs are generated server-side and the canonical session payload is held
in Redis. GitHub Actions requires no production variables or secrets; the
destructive database smoke must instead use the separately guarded isolated
test PostgreSQL/Redis configuration.

## Render and repository agreement

- `render.yaml` supplies `NODE_ENV=production`, `/var/data`,
  `OBJECT_STORAGE_BACKEND=s3`, and private dashboard values for object storage,
  database, Redis, origin, admin bootstrap, and SMTP.
  Render supplies `PORT`.
- Optional feature/business values in this checklist must be added privately
  to the Render service only if the corresponding feature is enabled. Never
  commit their real values.
- `.env.example` is a local-development template, not a production secret
  store. Its local endpoints/defaults are not deployment instructions.
- `README.md`, `docs/DEPLOYMENT.md`, and `docs/OPERATIONS_RUNBOOK.md` link to
  this checklist and describe the same startup, readiness, email, and recovery
  boundaries.
- `.github/workflows/ci.yml` uses disposable CI PostgreSQL/Redis services and
  service-free storage/security/operations tests; it does not deploy or receive
  production credentials. Render deployment and its required private
  environment values remain separately managed.

## Release sign-off

- [ ] Database project, plan, PostgreSQL version, backup mode, retention, and
  latest recovery point verified in the production dashboard.
- [ ] Database, Redis, and object-storage endpoints/buckets verified against
  the intended production projects; test endpoints are separate.
- [ ] Canonical HTTPS origin, proxy hop count, and Secure-cookie behavior
  verified through the deployed edge.
- [ ] Initial admin login and password-change workflow verified.
- [ ] SMTP provider selected by the owner; sender/domain authentication and
  controlled-mailbox tests completed.
- [ ] Seller identity and tax treatment reviewed by the business/tax owner
  before production invoices are issued.
- [ ] Payment-provider account/configuration is approved before live online
  payments are enabled.
- [ ] GitHub Actions CI passes; an isolated guarded PostgreSQL/Redis smoke has
  passed for the release candidate; Render deploy and rollback have been
  verified without exposing production credentials in logs.
- [ ] Database restore drill and storage migration/audit completed; artwork
  access verified from a second application instance or isolated deployment.
