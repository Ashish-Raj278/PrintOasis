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
| Runtime files/artwork RPO | At most 24 hours. | Not currently met/verified: `/var/data` is instance-local and this repository does not configure off-instance file backups. Requires an encrypted off-instance daily backup until Stage 7 storage is implemented. |
| Runtime files/artwork RTO | Restore references and files within one business day. | Internal target only; requires a file archive, matching database recovery point, and a successful isolated restore drill. Object storage with a tested recovery/versioning policy is a Stage 7 dependency, not present today. |

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
| D. File/artwork recovery | Customer artwork and admin-uploaded product images live under instance-local `DATA_DIR`; `/var/data` is not shared and no verified off-instance backup is configured. | Until Stage 7, configure and test a protected off-instance backup of `uploads/` coordinated with a DB point. Stage 7 will move persistent files to durable object storage. Include customer artwork, uploaded product images, retained generated invoice PDFs, and email logs/outbox only if retention is required. Keep release/source-controlled `public/assets/images/` in the release artifact. | Restore files and DB references together in an isolated drill; compare stored filenames/references and test authorized download. | Deployment operator and privacy/business owner set retention/access policy. |
| E. SMTP | Nodemailer SMTP is implemented, but provider, credentials, DNS authentication, and live deliverability are unverified. Sends are synchronous/best-effort with no automatic retry. | Select provider; privately supply host, port, TLS mode, conditional username/password, sender identity; publish provider-specific SPF/DKIM and choose DMARC policy. | Fake `npm run ops:check`, staging controlled-mailbox tests for verification/reset/order/shipment/delivery, then owner-approved production mailbox test. Inspect failure status/logs. | Business/domain owner selects and authorizes provider; deployment operator configures values. |
| F. Redis | Required for shared sessions and rate limits; outages fail closed. Production endpoint/TLS and recovery behavior require deployment verification. Redis is not authoritative for orders/inventory. | Configure separate managed production Redis, prefer TLS endpoint, choose namespace, document provider persistence/failover behavior; do not use test Redis. | `/healthz` Redis dependency check, controlled restart/outage test in staging, and confirm generic 503/fail-closed behavior. | Redis service owner and deployment operator. |
| G. Deployment | Render Blueprint runs one Node service with local `/var/data`; `PORT` is host supplied. Startup gates on DB, migrations, and Redis. | Set every required value in the [environment checklist](PRODUCTION_ENVIRONMENT_CHECKLIST.md); confirm HTTPS, canonical domain, proxy chain/hop count, persistent disk, one-instance limit, and termination grace. Verify optional email/payment features only when enabled. | Review Render service/Blueprint diff; confirm `/healthz`, storefront, login, admin, and file access after a controlled deploy. | Hosting account owner and deployment operator; real domain and proxy topology. |
| H. Migration recovery | Numbered SQL migrations `001`–`008` run before listen, each transactionally and recorded in `schema_migrations`; there are no down migrations. | Back up before release; review schema compatibility. If a migration fails, keep traffic closed, inspect migration ledger/logs, and use a reviewed forward fix or restore matching DB/code/files. | Compare migration ledger to the release; run `npm run check`; validate on an isolated restored copy before retry. | Database operator and release owner. |
| I. Payment-provider outage | Razorpay integration is configuration-dependent. State is persisted; ambiguous provider results must not be manually marked paid. Reconciliation is callable, not scheduled. | Keep customer messaging/support procedure ready; preserve intent/provider/payment state, restore provider access, reconcile before acting. Do not issue unverified refunds. | Check provider dashboard against local checkout/payment/refund records; execute the callable reconciliation procedure in a controlled manner. No live calls are part of this runbook audit. | Merchant account owner and payment operations owner. |
| J. Rollback | Code rollback does not reverse migrations. Restoring a point loses later writes; local runtime files must match DB references. | Prefer a compatible code rollback only after schema compatibility review. Otherwise use an approved forward fix or restore DB and file set from a coordinated point; reconcile intervening orders/payments before traffic resumes. | Stage the rollback/restore on an isolated target and compare migration ledger, order/payment state, invoice snapshots, and files. | Release owner, database operator, and business approver for data-loss window. |

Do not mark a row complete based only on this documentation. Record the actual
configuration and evidence in the deployment/recovery record, without copying
connection strings or secrets into it.
