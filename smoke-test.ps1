$ErrorActionPreference = "Stop"
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required. The smoke suite only runs against an isolated PostgreSQL test database." }
node scripts/postgres-smoke.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }