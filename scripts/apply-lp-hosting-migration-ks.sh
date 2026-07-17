#!/usr/bin/env bash
# apply-lp-hosting-migration-ks.sh — migration 102 (harness-lp-hosting: lp_pages + lp_views) を
# 本番 D1 に安全適用する。additive のみ (CREATE TABLE IF NOT EXISTS + CREATE INDEX) = 既存テーブル
# 無改変・冪等 (再 apply 安全)。owner_role: infra-ops (closer 工程で実行 / generator は実行しない)。
#
# 両テナント適用: 既定 = KS (line-harness-ks / wrangler.ks.toml)。piecemaker mirror へは
#   DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml で再実行する
#   (closer チェックリスト = 両テナントに apply / R-g 片テナントのみ適用の防止)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-apps/worker/wrangler.ks.toml}"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(102_lp_hosting.sql)

WR() { npx wrangler "$@" --config "$REPO_ROOT/$WRANGLER_CONFIG"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] 事前 assert (line_accounts>=1 = 対象 DB が実テナントであること)"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
echo "    line_accounts=$ACCTS (config=$WRANGLER_CONFIG db=$DB)"
if [ -z "$ACCTS" ] || [ "$ACCTS" -lt 1 ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 >=1) = 空 DB / 想定外テナント。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] migration 102 を適用 (benign 'already exists' は許容 = 冪等 IF NOT EXISTS)"
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

echo "==> [2/5] _migrations 台帳に 102 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [3/5] lp_pages / lp_views テーブル verify (sqlite_master)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('lp_pages','lp_views') ORDER BY name" \
  | tee /tmp/102-lp-tables.txt
grep -q '"name": "lp_pages"' /tmp/102-lp-tables.txt && grep -q '"name": "lp_views"' /tmp/102-lp-tables.txt \
  && echo "    lp_pages + lp_views present" \
  || { echo "!!! lp_pages / lp_views が見えない" >&2; exit 1; }

echo "==> [4/5] lp_pages 列 verify (pragma_table_info: slug/status/entry_key)"
WR d1 execute "$DB" --remote --command "SELECT name FROM pragma_table_info('lp_pages')" | tee /tmp/102-lp-pages-pragma.txt
for col in slug title status entry_key; do
  grep -q "\"name\": \"$col\"" /tmp/102-lp-pages-pragma.txt || { echo "!!! lp_pages.$col が見えない" >&2; exit 1; }
done
echo "    slug/title/status/entry_key present"

echo "==> [5/5] _migrations 台帳 verify (102 記録済み)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM _migrations WHERE name='102_lp_hosting.sql'" | tee /tmp/102-migrations-ledger.txt
grep -q '102_lp_hosting.sql' /tmp/102-migrations-ledger.txt && echo "    ledger entry present" \
  || { echo "!!! _migrations 台帳に 102 が見えない" >&2; exit 1; }

echo "DONE: migration 102 (lp_pages + lp_views / harness-lp-hosting) を D1 ($DB) に安全適用しました。"
echo "      両テナント適用リマインド: piecemaker へは DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml で再実行。"
