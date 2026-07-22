#!/usr/bin/env bash
# apply-126-sheets-sync-jobs-migration.sh — migration 126 (sheets-sync-scale: sheets_sync_jobs) を
# 本番 D1 に安全適用する。additive のみ (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS) =
# 既存テーブル無改変・冪等 (再 apply 安全)。owner_role: infra-ops (closer 工程で実行 / generator は実行しない)。
#
# 両テナント適用: 既定 = KS (line-harness-ks / wrangler.ks.toml)。piecemaker mirror へは
#   DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml SKIP_LEDGER=1 で再実行する
#   (piecemaker は _migrations 台帳テーブル不在: app-profile 既知ギャップ。sqlite_master verify のみ)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-apps/worker/wrangler.ks.toml}"
SKIP_LEDGER="${SKIP_LEDGER:-0}"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(126_sheets_sync_jobs.sql)

WR() { npx wrangler "$@" --config "$REPO_ROOT/$WRANGLER_CONFIG"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] 事前 assert (line_accounts>=1 = 対象 DB が実テナントであること)"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
echo "    line_accounts=$ACCTS (config=$WRANGLER_CONFIG db=$DB)"
if [ -z "$ACCTS" ] || [ "$ACCTS" -lt 1 ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 >=1) = 空 DB / 想定外テナント。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] migration 126 を適用 (benign 'already exists' は許容 = 冪等 IF NOT EXISTS)"
for m in "${MIGRATIONS[@]}"; do
  echo "    -- $m"
  if out="$(WR d1 execute "$DB" --remote --file "$MIG_DIR/$m" 2>&1)"; then
    echo "       OK applied"
  elif echo "$out" | tr '[:upper:]' '[:lower:]' | grep -qE 'duplicate column|already exists'; then
    echo "       benign (already applied) — skip"
  else
    echo "!!! FATAL applying $m: $out" >&2
    exit 1
  fi
done

if [ "$SKIP_LEDGER" = "1" ]; then
  echo "==> [2/5] _migrations 台帳: SKIP (piecemaker は台帳テーブル不在の既知ギャップ)"
else
  echo "==> [2/5] _migrations 台帳に 126 を記録"
  for m in "${MIGRATIONS[@]}"; do
    WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
  done
fi

echo "==> [3/5] sheets_sync_jobs テーブル verify (sqlite_master)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE name IN ('sheets_sync_jobs','idx_sheets_sync_jobs_one_running','idx_sheets_sync_jobs_runnable','idx_sheets_sync_jobs_connection_history') ORDER BY name" \
  | tee /tmp/126-tables.txt
for obj in sheets_sync_jobs idx_sheets_sync_jobs_one_running idx_sheets_sync_jobs_runnable idx_sheets_sync_jobs_connection_history; do
  grep -q "\"name\": \"$obj\"" /tmp/126-tables.txt || { echo "!!! $obj が見えない" >&2; exit 1; }
done
echo "    sheets_sync_jobs + index 3 本 present"

echo "==> [4/5] sheets_sync_jobs 列 verify (pragma_table_info: status/processed_count/lock_token)"
WR d1 execute "$DB" --remote --command "SELECT name FROM pragma_table_info('sheets_sync_jobs')" | tee /tmp/126-pragma.txt
for col in status total_count processed_count last_friend_created_at last_record_key lock_token locked_until; do
  grep -q "\"name\": \"$col\"" /tmp/126-pragma.txt || { echo "!!! sheets_sync_jobs.$col が見えない" >&2; exit 1; }
done
echo "    主要列 present"

if [ "$SKIP_LEDGER" = "1" ]; then
  echo "==> [5/5] _migrations 台帳 verify: SKIP (piecemaker)"
else
  echo "==> [5/5] _migrations 台帳 verify (126 記録済み)"
  WR d1 execute "$DB" --remote --command \
    "SELECT name FROM _migrations WHERE name='126_sheets_sync_jobs.sql'" | tee /tmp/126-ledger.txt
  grep -q '126_sheets_sync_jobs.sql' /tmp/126-ledger.txt && echo "    ledger entry present" \
    || { echo "!!! _migrations 台帳に 126 が見えない" >&2; exit 1; }
fi

echo "DONE: migration 126 (sheets_sync_jobs / sheets-sync-scale) を D1 ($DB) に安全適用しました。"
echo "      両テナント適用リマインド: piecemaker へは DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml SKIP_LEDGER=1 で再実行。"
