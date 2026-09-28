# PrintOasis Operations Runbook

This runbook describes the current Node.js deployment using PostgreSQL,
Redis, S3-compatible object storage for runtime uploads, and a local disk for
operational email copies. It does not assume provider backup
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
migration in its own transaction, checks PostgreSQL, Redis, and object storage,
and only then listens. A failed connection, migration, or storage check prevents
the server from accepting requests. `/healthz` is a dependency readiness check:
it runs `SELECT 1`, a Redis PING, and checks access to both configured storage
buckets; it returns only `ok` or `service unavailable` with HTTP 200/503. It
does not test SMTP, Razorpay, local disk
capacity, or email delivery, and it is not a separate process-liveness endpoint.

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

### Supabase plan and recovery facts

The actual production project's organization plan, backup mode, retention,
PITR setting/retention, latest recovery point, restore-to-new-project
availability, and PostgreSQL version are **requires production dashboard
verification**. No project credentials or safe read-only Supabase dashboard
connection are available to this repository audit, so none of those values is
asserted here.

Verify and record them before launch:

1. Supabase Dashboard → organization → Billing/Subscription: record the
   organization plan. Supabase billing is organization-based; projects in one
   organization share its plan.
2. Production project → Database → Backups: record whether daily backups are
   visible, their timestamps, and the available retention window.
3. Production project → Database → Backups / Point in Time settings: record
   whether PITR is enabled, its configured recovery-retention period, and the
   earliest/latest recovery points shown in the dashboard. A configured PITR
   window does not prove the latest point is current; record its actual
   freshness before relying on it.
4. Project Settings → General: record the PostgreSQL version. Confirm with the
   Dashboard SQL Editor using the read-only query `SHOW server_version;`.
5. Database → Backups: confirm whether **Restore to a New Project** is offered
   for this source project before using it in a drill.

Supabase's current published plan matrix says Free has no managed daily-backup
retention; Pro exposes 7 days, Team 14 days, and Enterprise up to 30 days.
Daily backup contents omit custom-role passwords. Physical backup handling is
the default for PostgreSQL 15.8.1.079 and newer; older projects must be upgraded
before transitioning. Supabase Storage API objects are not included in database
backups. PITR is a paid add-on for paid plans, requires at least Small compute,
and replaces daily backups while enabled. Its configured recovery period and
the dashboard's earliest/latest points determine what can actually be
restored. Supabase reports restore downtime depends on database size. Verify
all project-specific settings rather than inferring them from this matrix.
Sources: [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups),
[Supabase billing and plans](https://supabase.com/docs/guides/platform/billing-on-supabase),
[PostgreSQL version query](https://supabase.com/docs/guides/database/postgres/which-version-of-postgres).

Supabase documents **Restore to a New Project** as a beta database-only copy
for paid-plan projects with physical backups enabled. It copies database
schema/data/indexes/roles, but requires manual reconfiguration of project
services and settings. It can also start enabled database extensions that
perform external work, so inspect extensions/jobs before a binary clone. Verify
current availability and limitations in the dashboard before planning around
it. See [Restore to a New Project](https://supabase.com/docs/guides/platform/clone-project).

### Internal recovery targets (not customer SLAs)

These are proposed internal operational targets, not promises to customers.
They are not considered achieved until configuration is verified and a drill
is recorded.

| System | Internal target | Current ability / dependency |
| --- | --- | --- |
| PostgreSQL RPO | At most 24 hours with a verified daily backup; target at most 15 minutes only if PITR is enabled and its latest usable point is verified no more than 15 minutes behind the incident. | Project plan and backup/PITR configuration are unknown. No achieved RPO can currently be claimed. If daily backups are unavailable, an independently stored `pg_dump` at least daily is required for the 24-hour target. |
| PostgreSQL RTO | Restore, verify, and cut over within one business day. | Internal target only; restore time depends on database size, provider availability, manual setup, and drill results. It is not verified yet. |
| Runtime files/artwork RPO | At most 24 hours. | Not yet verifiable: the storage provider has not been selected and its versioning/backup controls are unknown. Configure a provider recovery point no older than 24 hours or explicitly mark the target missed. |
| Runtime files/artwork RTO | Restore references and files within one business day. | Internal target only; requires provider recovery, a matching database point, and a successful isolated restore drill. Provider capabilities and measured recovery time remain unverified. |

Daily-backup RPO must be measured from the actual latest available snapshot,
not assumed from the plan name. If any latest point is older than the target,
the target is missed and the incident record must say so.

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

### Isolated database restore drill

Complete this drill before public launch, then repeat after a material change
to backup configuration or recovery procedure. Never restore over production.

1. Obtain approval for an isolated Supabase project or isolated PostgreSQL
   target with access controls comparable to production. Record the source
   recovery point and destination identity without recording credentials in
   the drill report.
2. Prefer Supabase Dashboard → source project → Database → Backups → **Restore
   to a New Project** when the actual plan and physical-backup configuration
   support it. Select a documented daily backup or a PITR timestamp within the
   dashboard's available range. The current Supabase documentation describes
   this as beta and database-only; manually reconfigure services/settings.
   If it is unavailable, create an encrypted logical dump using the earlier
   `pg_dump` procedure and restore it into an empty isolated target. Never use
   `pg_restore --clean` against production.
3. Before connecting the application, inspect enabled extensions, scheduled
   jobs, webhooks, and external integrations. Do not allow a cloned database
   job to send email, call payment providers, or reach customer systems.
4. Verify `schema_migrations` against release files `migrations/001` through
   `migrations/008`. Check tables, indexes, foreign keys, and representative
   counts for `products`, `users`, `sessions`, `cart_items`, `orders`,
   `order_items`, `checkout_intents`, `provider_orders`, `payments`,
   `payment_webhook_events`, `refunds`, `notifications`, `reviews`, `coupons`,
   `addresses`, `wishlist_items`, and `account_tokens`. Compare counts against
   the source using approved read-only queries. Inspect invoice snapshots:
   ```sql
   SELECT count(*) AS orders,
          count(*) FILTER (WHERE invoice_snapshot IS NULL) AS missing_invoice_snapshots
   FROM orders;

   SELECT name, applied_at FROM schema_migrations ORDER BY name;

   SELECT contype, count(*)
   FROM pg_constraint
   GROUP BY contype
   ORDER BY contype;

   SELECT count(*) AS indexes FROM pg_indexes
   WHERE schemaname = 'public';
   ```
   Product category membership is stored on product records, not a separate
   category table. Business/seller/tax configuration and all secrets are
   deployment environment values, not database backup content; re-enter only
   verified values through private settings.
5. For application regression, make a separate disposable copy/target for
   destructive smoke tests. `npm run db:smoke` initializes and mutates its
   isolated target; it must not be run against production or the only retained
   restore artifact. Keep its PostgreSQL project-reference and Redis endpoint
   isolation guards enabled. Use `npm run check` and `npm run ops:check` as
   non-destructive local checks; the latter uses a fake email transport.
6. Record pass/fail, source point, schema version, counts, failures, elapsed
   restore/verification time, and operator. Preserve the isolated target until
   the drill is signed off, then remove it using the provider dashboard's
   normal project lifecycle after confirming it is not the source.
7. Cutover only after business approval: configure the restored connection
   privately, deploy the matching compatible application release, verify
   `/healthz` and representative read-only storefront/account/order pages, and
   redirect traffic at the hosting edge. Keep the prior project intact for
   investigation. A database restore can lose writes after the selected point;
   reconcile those records before reopening transactions.

## Uploaded files and artwork recovery

| Location | Current contents | Recovery treatment |
| --- | --- | --- |
| Configured private object bucket (`artwork/<generated-name>`) | Customer artwork referenced by carts/order items. | Verify provider recovery/versioning controls and reconcile against PostgreSQL references. Never expose a public bucket URL. |
| Configured product-image object bucket (`product-images/<generated-name>`) | Admin-uploaded product images referenced by products/product_images. | Preserve object recovery alongside the PostgreSQL reference backup; images are served through the app with signature validation. |
| Legacy/local `DATA_DIR/uploads/` and `DATA_DIR/uploads/product-images/` | Existing disk files during migration and local-development storage. | Migration sources; retain until the DB/object audit and authorized file checks pass. No automatic cleanup after migration. |
| `DATA_DIR/email-outbox/` | Local text copies of order/contact notification content, including customer data. | Protect as sensitive operational data; include only if required by the organization's retention policy. It is not a delivery queue. |
| Temporary `.uploading` staging files | Local backend's short-lived atomic-write staging only; S3 uploads are sent directly. | Only strictly named files older than 24 hours are removed in local mode; no customer-visible reference is created from a staging file. |
| `public/assets/images/` | Deployed image-library assets, when present. | Preserve the matching source release/artifact and separately back up any local-only files; this directory is not the customer upload store. |
| repository `invoices/` | Ignored PDF output location used by a currently uncalled helper; the customer invoice route renders from PostgreSQL snapshots. | Derived output, not the invoice source of truth. Can be regenerated from order/item/invoice snapshots if PDF generation is later invoked. |

`DATA_DIR` defaults to `<repository>/data`; the included Render Blueprint sets
it to `/var/data` for email-outbox operational copies and local staging. It is
instance-local and is not shared. Runtime artwork and admin-uploaded images
use configured object storage, so object storage and PostgreSQL references
must be recoverable together. Source-controlled `public/assets/images/` stays
in the application release.

For coordinated recovery, record the PostgreSQL recovery point and object
provider recovery/versioning point. Restore into isolated targets first, then
run the storage migration audit and verify missing-object and unreferenced-
object counts. Do not automatically delete unreferenced objects: legacy order
rows may lack references. Local email-outbox files are not a mail queue and do
not participate in order correctness; apply host retention and privacy controls
if they are retained.

### Runtime object-storage migration and recovery

The provider is not selected by this repository. Before launch, choose an
S3-compatible service and verify its private-bucket policy, server-side
Get/Put/Head/Delete/List permissions, HTTPS endpoint, versioning/recovery
capabilities, and lifecycle policy. Set the `OBJECT_STORAGE_*` variables from
the [pre-production checklist](PRODUCTION_ENVIRONMENT_CHECKLIST.md) in private
deployment configuration. Never configure browser credentials or anonymous
bucket reads. Product images are public only via the app route; customer artwork
is always authorization-checked and streamed by the app.

Migration is an explicit operator action. First take/record a consistent DB
backup and preserve the local source disk. From an approved maintenance
environment that can access both the database and files, run:

```sh
npm run storage:migrate -- --dry-run
npm run storage:migrate -- --execute
npm run storage:migrate -- --audit
```

Dry-run makes no changes. Execution copies and validates each referenced file,
checks the remote bytes, then transactionally changes matching database
references to a namespaced object key. It is resumable: if the object copy
succeeded but the DB update failed, a retry verifies the existing object before
updating the reference. The script never removes local files or unreferenced
objects. Stop cutover for any nonzero `missingLocalAndRemote`, `unverified`, or
`failed` count, or any `missingObjects` audit result. Review unreferenced object
counts manually; do not auto-delete historical files.

For disaster recovery, restore PostgreSQL and the provider's object version/
backup into isolated targets, deploy compatible code/configuration there, and
run `npm run storage:migrate -- --audit`. Verify catalog uploads, cart artwork,
historical order artwork, private owner/admin authorization, product image
MIME/`nosniff`, and representative invoice pages from their immutable DB
snapshots. Reconcile the database recovery point with object recovery before
traffic cutover. There is no cross-system transaction: a DB restore and object
restore from mismatched times can produce missing or orphaned objects.

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

### Production SMTP decision

No provider has been selected or verified. Before enabling production email,
the deployment owner must obtain from the chosen provider: SMTP hostname, port,
security mode (implicit TLS or STARTTLS), credentials if required, sender
address/name, sending limits, and account/domain approval. Authenticate the
sender domain using the provider's documented SPF and DKIM records and define
an appropriate DMARC policy/reporting address. Do not invent DNS records or
reuse example values; have the domain owner publish the exact provider-supplied
records.

Test only through a staging/non-production configuration and a controlled
mailbox: email verification, password reset, order confirmation, and shipping/
delivery notification. Check both rendered links (canonical `BASE_URL`) and
the recipient's spam/delivery diagnostics. `npm run ops:check` is a fake
transport test, not evidence of deliverability. Then exercise one explicitly
approved production test email to an owner-controlled mailbox. A failure is
visible in logs/notification status, but automatic SMTP retries are not
implemented; plan a manual customer-support response and use available resend
flows. No customer mail should be generated by regression tests.

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

## Production Readiness Decisions

This section turns the remaining operational decisions into release actions.
Project-specific dashboard facts and business/provider values remain explicitly
unverified until the named owner records them.

| Decision | Current state | Production action required | Verification method | Owner/input required |
| --- | --- | --- | --- | --- |
| A. Database backups | PostgreSQL is authoritative. Supabase may provide plan-dependent backups; actual project plan/settings are **requires production verification**. The app does not schedule its own database backup. | Verify plan, visible backups, retention, PITR setting/retention/latest point; choose provider backup plus independent encrypted logical backup policy. | Supabase organization Billing/Subscription; project Database → Backups and PITR settings; record `SHOW server_version;` and latest point. | Supabase organization owner and database operator. |
| B. Database restore drill | Procedure is documented; no real production backup restore has been claimed or tested here. | Restore to a separate isolated project/target, verify schema/data, then test the application on a disposable second copy. Never overwrite production for a drill. | Follow “Isolated database restore drill”; retain an evidence record with recovery point, counts, migration ledger, and elapsed times. | Database operator; project-plan access and an isolated target. |
| C. RPO/RTO | Internal targets: DB RPO ≤24h with verified daily backup (≤15m only conditionally with fresh PITR); DB RTO ≤1 business day; files RPO ≤24h and RTO ≤1 business day. These are not customer SLAs and are not yet proven achievable. | Approve targets; configure backups/retention and file backup that meet them; revise targets if measured drills do not meet them. | Compare actual backup/recovery-point timestamps and file archive time; measure isolated restore drill. | Business owner approves risk; database and deployment operators provide evidence. |
| D. File/artwork recovery | Runtime artwork and uploaded product images use two configured object buckets; source-controlled image assets remain in the release. Provider durability/versioning/retention are not known until the actual provider is selected and verified. | Select/configure object storage with documented recovery controls; run dry-run, execute, then audit migration; retain local source files until all references verify. Keep outbox files under host retention because they are not required to deliver mail. | Restore a selected database/object point in isolation, run storage audit, and test customer/admin artwork access plus public product images. | Storage provider/account owner and privacy/business owner. |
| E. SMTP | Nodemailer SMTP is implemented, but provider, credentials, DNS authentication, and live deliverability are unverified. Sends are synchronous/best-effort with no automatic retry. | Select provider; privately supply host, port, TLS mode, conditional username/password, sender identity; publish provider-specific SPF/DKIM and choose DMARC policy. | Fake `npm run ops:check`, staging controlled-mailbox tests for verification/reset/order/shipment/delivery, then owner-approved production mailbox test. Inspect failure status/logs. | Business/domain owner selects and authorizes provider; deployment operator configures values. |
| F. Redis | Required for shared sessions and rate limits; outages fail closed. Production endpoint/TLS and recovery behavior require deployment verification. Redis is not authoritative for orders/inventory. | Configure separate managed production Redis, prefer TLS endpoint, choose namespace, document provider persistence/failover behavior; do not use test Redis. | `/healthz` Redis dependency check, controlled restart/outage test in staging, and confirm generic 503/fail-closed behavior. | Redis service owner and deployment operator. |
| G. Deployment | Render Blueprint runs Node with `/var/data` for operational outbox copies and configured object storage for uploads; `PORT` is host supplied. Startup gates on DB, migrations, Redis, and storage. | Configure object-storage variables/buckets privately, complete file migration/audit, and confirm HTTPS, proxy chain, outbox retention, and shutdown grace. Multiple instances can share uploads after cutover. | Review Blueprint/runtime config; confirm `/healthz`, storefront, login, admin, and private/public file access across separate instances. | Hosting and object-storage account owners; deployment operator. |
| H. Migration recovery | Numbered SQL migrations `001`–`008` run before listen, each transactionally and recorded in `schema_migrations`; there are no down migrations. | Back up before release; review schema compatibility. If a migration fails, keep traffic closed, inspect migration ledger/logs, and use a reviewed forward fix or restore matching DB/code/files. | Compare migration ledger to the release; run `npm run check`; validate on an isolated restored copy before retry. | Database operator and release owner. |
| I. Payment-provider outage | Razorpay integration is configuration-dependent. State is persisted; ambiguous provider results must not be manually marked paid. Reconciliation is callable, not scheduled. | Keep customer messaging/support procedure ready; preserve intent/provider/payment state, restore provider access, reconcile before acting. Do not issue unverified refunds. | Check provider dashboard against local checkout/payment/refund records; execute the callable reconciliation procedure in a controlled manner. No live calls are part of this runbook audit. | Merchant account owner and payment operations owner. |
| J. Rollback | Code rollback does not reverse migrations. Object keys use the storage interface; local legacy files are retained after migration. | Roll back only to a release supporting the object backend and namespaced references. Otherwise restore coordinated DB/object versions or use retained local sources and the migration tool; reconcile intervening orders/payments before traffic resumes. | Test rollback on isolated DB/storage copies and compare migration ledger, payment/order state, invoice snapshots, and file access. | Release owner, database/storage operators, and business approver for data-loss window. |

Do not mark a row complete based only on this documentation. Record the actual
configuration and evidence in the deployment/recovery record, without copying
connection strings or secrets into it.
