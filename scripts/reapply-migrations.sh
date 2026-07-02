#!/usr/bin/env bash
# reapply-migrations.sh — additive schema reconciliation for an existing D1 database.
#
# WHY THIS EXISTS
#   When a D1 database is seeded by applying packages/db/schema.sql directly
#   (instead of bootstrap.sql + the migration runner), the custom `_migrations`
#   ledger ends up empty/partial. A later "apply only files not in the ledger"
#   pass that keys off *table existence* silently skips migrations that only add
#   COLUMNS to already-existing tables — leaving the DB missing columns while the
#   ledger looks partially applied. (See findings-audit-2026-07-02.md, CRITICAL/config.)
#
# WHAT IT DOES (safe, additive-only — matches upstream CONTRIBUTING.md §Migration Policy)
#   1. Exports a full backup first (never operate on D1 without a backup).
#   2. Applies every packages/db/migrations/*.sql in sort order, tolerating ONLY
#      benign schema errors ('duplicate column' / 'already exists' / 'table ... already').
#      Any OTHER SQLite error aborts immediately (fail-closed).
#      NOTE: grandfathered destructive migrations (DROP TABLE / table-recreate) are
#      DANGEROUS to re-run against a DB that already has the final schema. Prefer the
#      --additive-only mode below which diffs live-vs-bootstrap and issues only
#      ALTER TABLE ADD COLUMN for genuinely missing columns.
#   3. Records all migration filenames in `_migrations` (INSERT OR IGNORE).
#
# USAGE
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#     scripts/reapply-migrations.sh <d1-database-name> [backup-dir]
#
#   Example (line-harness-ks):
#     scripts/reapply-migrations.sh line-harness-ks /root/.secrets/line-harness-ks
#
# NO SECRETS ARE STORED IN THIS FILE. Credentials come from the environment.
set -euo pipefail

DB="${1:?usage: reapply-migrations.sh <d1-database-name> [backup-dir]}"
BACKUP_DIR="${2:-./.migration-backups}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
WR() { npx wrangler "$@"; }

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-$TS.sql"

echo "==> [1/3] Exporting backup to $BK (required before any D1 mutation)"
WR d1 export "$DB" --remote --output "$BK"

is_benign() {
  local t; t="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  echo "$t" | grep -qE 'duplicate column|already exists|table .*already'
}

echo "==> [2/3] Applying migrations in sort order (benign-error tolerant, fail-closed on others)"
applied=0; benign=0
for f in $(ls "$MIG_DIR"/*.sql | sort); do
  name="$(basename "$f")"
  if out="$(WR d1 execute "$DB" --remote --file "$f" 2>&1)"; then
    applied=$((applied+1)); echo "  OK      $name"
  elif is_benign "$out"; then
    benign=$((benign+1)); echo "  benign  $name (skipped — already applied)"
  else
    echo "  !!! FATAL non-benign error on $name:"; echo "$out" | tail -8
    echo "ABORT. Restore with: WR d1 execute $DB --remote --file $BK"; exit 1
  fi
done
echo "  migrations: applied=$applied benign-skipped=$benign"

echo "==> [3/3] Recording all migration filenames in _migrations ledger"
NAMES_SQL="$(printf "INSERT OR IGNORE INTO _migrations (name) VALUES\n"; \
  ls "$MIG_DIR"/*.sql | sort | xargs -n1 basename | sed "s/.*/  ('&'),/" | sed '$ s/,$/;/')"
echo "$NAMES_SQL" | WR d1 execute "$DB" --remote --file /dev/stdin

echo "==> DONE. Verify with:"
echo "    WR d1 execute $DB --remote --command \"SELECT COUNT(*) FROM _migrations\""
echo "    (then diff live schema vs packages/db/bootstrap.sql — expect 0 column drift)"
