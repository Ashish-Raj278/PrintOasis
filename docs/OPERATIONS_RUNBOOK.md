# PrintOasis Operations Runbook

This runbook describes the current single-Node.js deployment using PostgreSQL,
Redis, and a persistent local disk. It does not assume provider backup
retention, recovery-point objectives, or recovery-time guarantees. Record those
values from the actual database and hosting plans before launch.

## Dependencies and readiness

The production command is `npm start` (`node server.js`, Node.js 22.5 or later).
The container uses `node server.js`. The host-provided `PORT` is used when set;
otherwise the server uses 3000. Production requires `DATABASE_URL`, `REDIS_URL`,
and an HTTPS canonical `BASE_URL`. Configure a real initial `ADMIN_EMAIL` and
`ADMIN_PASSWORD` or separately provision an administrator before opening the
site. `TRUST_PROXY_HOPS` defaults to 0; set it only after confirming the
reachable proxy chain and ensuring direct public access cannot bypass it.

Startup connects PostgreSQL and Redis, applies each pending numbered SQL
migration in its own transaction, performs initialization, checks both
dependencies, and only then listens. A failed connection or migration prevents
the server from accepting requests. `/healthz` is a dependency readiness check:
it runs `SELECT 1` and a Redis PING and returns only `ok` or `service
unavailable` with HTTP 200/503. It does not test SMTP, Razorpay, disk capacity,
or email delivery, and it is not a separate process-liveness endpoint.

SIGINT/SIGTERM stops the HTTP listener and then closes Redis and the PostgreSQL
pool. Set the hosting platform's termination grace period to allow ordinary
in-flight requests to drain. The application does not implement a separate
bounded drain timer.

## PostgreSQL backup

PostgreSQL is the authoritative store for accounts, sessions' durable anchors,
carts, reservations, products, orders, payment/refund state, notifications, and
migration history. `data/store.db` is legacy SQLite and is not part of the
production PostgreSQL recovery path.

1. In the Supabase project dashboard, confirm which automated backup/PITR
   controls are enabled for the actual project and plan. Record the verified
   retention, restore-point coverage, access procedure, and business-approved
   RPO/RTO. Do not infer these from this repository.
2. Keep an independent encrypted logical backup in access-controlled storage.
   Use the provider-recommended connection route and TLS settings. Prefer a
   protected `.pgpass`/secret-manager credential or an interactive password
   prompt; do not put the URI/password in a command, terminal transcript, or
   backup filename.
3. With `PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE` set to the approved
   source, choose a restricted `BACKUP_FILE` path in the encrypted backup
   location and create a custom-format dump. `pg_dump` will prompt for a
   password if no protected credential source is configured:

   ```sh
   pg_dump --format=custom --no-owner --no-acl \
     --file="$BACKUP_FILE" \
     --host="$PGHOST" --port="$PGPORT" \
     --username="$PGUSER" --dbname="$PGDATABASE"
   pg_restore --list "$BACKUP_FILE" >/dev/null
   ```

   Restrict the backup directory to the operator account, encrypt it at rest,
   and verify the archive before transferring it off-host. The dump contains
   personal, order, and payment-related business data and must be protected as
   such.
4. Record the application commit/release and migration versions alongside the
   backup. The authoritative migration list is:

   ```sql
   SELECT name, applied_at FROM schema_migrations ORDER BY name;
   ```

Choose and document backup frequency and retention with the business owner;
the repository does not prescribe or guarantee either.

## PostgreSQL restore and migration recovery

1. Declare an incident, stop or place the application behind a maintenance
   response at the hosting edge, and preserve the failed deployment/database
   for diagnosis where feasible.
2. Prefer restoring a provider snapshot/PITR point into a new isolated database
   or project first. For a logical dump, create an empty isolated restore target
   and run this with the provider-approved connection settings:

   ```sh
   pg_restore --exit-on-error --no-owner --no-acl \
     --dbname="$PGDATABASE" "$BACKUP_FILE"
   ```

   Do not use `--clean` on a production target as an ad-hoc recovery shortcut.
3. Verify `schema_migrations`, required tables, representative customer/order
   records, order-item/invoice snapshots, and foreign-key integrity. Check the
   restored application release against the restored migration version before
   starting it. Startup automatically applies newer migrations; do not start a
   newer release until its compatibility with the restored schema is reviewed.
4. Run `npm run check`, start a controlled application instance against the
   restore, verify `/healthz`, storefront, account/order views, and private
   artwork access. Any destructive smoke test must use the separate guarded
   `TEST_DATABASE_URL` and isolated `TEST_REDIS_URL`, never the restored
   production candidate.
5. Validate reconciliation and obtain business approval before directing
   customer traffic to a restored database. Capture the final migration list
   and recovery point in the incident record.

Migrations are ordered additive SQL files recorded in `schema_migrations` and
run transactionally per file. There are no automatic down migrations. A code
rollback is safe only when the older code is compatible with the already
migrated schema. Otherwise use a reviewed forward fix or restore the database
and matching files from a chosen recovery point; restoring loses changes made
after that point.

## Uploaded files and artwork recovery

| Location | Current contents | Recovery treatment |
| --- | --- | --- |
| `DATA_DIR/uploads/` (production example `/var/data/uploads/`) | Private customer artwork referenced by carts/order items. | Back up with restrictive access and coordinate its recovery point with PostgreSQL. Missing files cannot be reconstructed from database rows. |
| `DATA_DIR/uploads/product-images/` | Admin-uploaded public product images. | Back up and restore with the database snapshot that contains their stored filenames. |
| `DATA_DIR/email-outbox/` | Local text copies of order/contact notification content, including customer data. | Protect as sensitive operational data; include only if required by the organization's retention policy. It is not a delivery queue. |
| `public/assets/images/` | Deployed image-library assets, when present. | Preserve the matching source release/artifact and separately back up any local-only files; this directory is not the customer upload store. |
| repository `invoices/` | Ignored PDF output location used by a currently uncalled helper; the customer invoice route renders from PostgreSQL snapshots. | Derived output, not the invoice source of truth. Can be regenerated from order/item/invoice snapshots if PDF generation is later invoked. |

`DATA_DIR` defaults to `<repository>/data`; the included Render Blueprint sets
it to `/var/data` and attaches a persistent disk. That disk is local to the
deployment instance. It is not shared storage: do not run multiple application
instances or move traffic between instances while expecting their uploaded
files to be visible everywhere. Disk loss, disk replacement, or an instance
change can make customer artwork unavailable unless a verified external file
backup is restored. Object storage/shared media is explicitly deferred to
Stage 7.

For coordinated recovery, stop writes or otherwise establish an operator-owned
consistent capture point, archive `DATA_DIR/uploads`, note the PostgreSQL
recovery point, and restore both together. Do not delete completed unreferenced
artwork automatically: legacy orders may not contain complete references.
Startup only removes old abandoned `.uploading` staging files. Review files
manually before retention cleanup.

## SMTP and email operations

Production email configuration uses private environment values:
`EMAIL_DELIVERY_ENABLED=true`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, and, when required by the provider, `SMTP_USER` and `SMTP_PASS`.
Use the provider's documented port/TLS mode and credentials. Never commit or
print SMTP secrets. The application does not call SMTP verify during startup;
`/healthz` does not represent mail readiness. `npm run ops:check` uses a fake
transport and sends no email. Before launch, perform an explicitly approved
delivery check to a controlled mailbox outside automated tests.

Current delivery is synchronous and best-effort, not a durable retry worker.
Order notification attempts are recorded in PostgreSQL `notifications`; a
failed attempt gets a `failed:<reason>` status. Text copies are written under
`DATA_DIR/email-outbox/`. Password-reset and email-verification token rows are
persisted before SMTP send, but their mail delivery result is not queued for
automatic retry. A user can request another password-reset email after SMTP is
restored; email verification has no resend endpoint. If SMTP fails, restore
SMTP first, inspect notification records and protected logs, and use existing
user flows where available. Do not manually expose or send stored token hashes
as links. No provider credentials or real recipients are included in tests.

`EMAIL_WEBHOOK_URL` is an optional fallback only when SMTP is not configured;
it is not attempted as a second delivery after a configured SMTP send fails.
Webhook fallback failure is recorded as failed. There is no background queue,
automatic retry/backoff, dead-letter workflow, or delivery alerting in the
current application.

## Redis failure

Redis is required for canonical session payloads and shared rate limits. On
outage, startup fails or `/healthz` returns 503; requests fail closed with a
generic service-unavailable response. There is no process-local session
fallback. Restore connectivity to the configured Redis service, verify TLS and
the namespace/configuration, then check readiness. If Redis data was lost,
PostgreSQL remains authoritative for orders, carts, reservations and inventory,
but active session payloads may be unavailable; affected sessions are rejected
and normal session cleanup may release their cart reservations. Customers may
need to sign in again and rebuild carts. Do not treat Redis as the authoritative
record of paid orders or inventory.

## Application restart and payment-provider dependency

For a routine restart, use the host's restart/rollback control and allow
SIGTERM/SIGINT handling to close the HTTP listener and dependency pools. Confirm
the new process is ready at `/healthz`, then verify one storefront page and an
admin sign-in. Avoid concurrent deployment instances sharing the local disk.

If Razorpay is unavailable or returns an ambiguous response, do not manually
mark an order paid, create a duplicate provider order, or infer payment success
from the browser. Preserve the persisted checkout/provider/payment state and
use the existing provider lookup/reconciliation service after the provider is
reachable. That callable reconciliation path is not a scheduled worker; no
automatic polling or alerting is configured. Reconcile provider and local
records before taking customer-facing payment action. Do not issue refunds from
an unverified browser report.

## Operational verification

- `npm run check`: syntax validation, no external services.
- `npm run ops:check`: fake SMTP transport and health-response regression; no
  network connection or real recipient.
- `npm run db:smoke`: destructive integration suite; only run after its existing
  Supabase project-reference guard and Redis endpoint isolation preflight pass.
- After restore or migration incidents, use a newly isolated test target for
  destructive smoke tests. Never repoint test variables at production.
