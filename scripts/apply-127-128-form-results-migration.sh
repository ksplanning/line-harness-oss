#!/usr/bin/env bash
# apply-127-128-form-results-migration.sh — migration 127(form_results_sync)+128(sheets_sync_jobs_target)を
# 本番 D1 に安全適用。additive のみ(ADD COLUMN / DROP+CREATE TRIGGER / CREATE INDEX IF NOT EXISTS)= 既存データ無改変。
# owner_role: infra-ops/closer 工程。
# 両テナント: 既定=KS。piecemaker は DB_NAME/WRANGLER_CONFIG override + SKIP_LEDGER=1。
set -euo pipefail
DB="${DB_NAME:-line-harness-ks}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-apps/worker/wrangler.ks.toml}"
SKIP_LEDGER="${SKIP_LEDGER:-0}"
MIG_DIR="$REPO/packages/db/migrations"
MIGRATIONS=(127_form_results_sync.sql 128_sheets_sync_jobs_target.sql)
WR() { npx wrangler "$@" --config "$REPO/$WRANGLER_CONFIG"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/4] 事前 assert (line_accounts>=1)"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
echo "    line_accounts=$ACCTS (config=$WRANGLER_CONFIG db=$DB)"
[ -n "$ACCTS" ] && [ "$ACCTS" -ge 1 ] || { echo "!!! ABORT: line_accounts=$ACCTS" >&2; exit 1; }

echo "==> [1/4] migration 127+128 適用 (benign 'already exists/duplicate column' 許容)"
for m in "${MIGRATIONS[@]}"; do
  echo "    -- $m"
  if out="$(WR d1 execute "$DB" --remote --file "$MIG_DIR/$m" 2>&1)"; then
    echo "       OK applied"
  elif echo "$out" | tr '[:upper:]' '[:lower:]' | grep -qE 'duplicate column|already exists'; then
    echo "       benign (already applied) — skip"
  else
    echo "!!! FATAL $m: $out" >&2; exit 1
  fi
done

if [ "$SKIP_LEDGER" = "1" ]; then
  echo "==> [2/4] _migrations 台帳: SKIP (piecemaker)"
else
  echo "==> [2/4] _migrations 台帳へ 127+128 記録"
  for m in "${MIGRATIONS[@]}"; do WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"; done
fi

echo "==> [3/4] 列/索引 verify"
WR d1 execute "$DB" --remote --command "SELECT name FROM pragma_table_info('sheets_connections') WHERE name IN ('form_results_enabled','form_results_sheet_name','form_results_headers_json')" | tee /tmp/127-cols.txt
for c in form_results_enabled form_results_sheet_name form_results_headers_json; do
  grep -q "\"name\": \"$c\"" /tmp/127-cols.txt || { echo "!!! sheets_connections.$c 不在" >&2; exit 1; }
done
WR d1 execute "$DB" --remote --command "SELECT name FROM pragma_table_info('sheets_sync_jobs') WHERE name='target'" | tee /tmp/128-col.txt
grep -q '"name": "target"' /tmp/128-col.txt || { echo "!!! sheets_sync_jobs.target 不在" >&2; exit 1; }
echo "    form_results 3列 + target 列 present"

echo "==> [4/4] DONE: migration 127+128 を D1 ($DB) に安全適用しました。"
[ "$SKIP_LEDGER" = "1" ] || echo "      piecemaker へは DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml SKIP_LEDGER=1 で再実行。"
