#!/usr/bin/env bash
# backup-d1-tables-json-ks.sh — テーブル単位 SELECT * → JSON 方式での本番D1バックアップ。
#
# WHY: `wrangler d1 export` は FTS5 仮想表を含む DB では動作しない
# ("D1 Export error: cannot export databases with Virtual Tables (fts5)")。
# migration 091 (faqs_fts) 適用以降、本番 line-harness-ks DB は恒久的にこの制約下にある。
# docs/wiki/22-Operations.md の「バックアップ戦略」節に記載のテーブル単位 SELECT*→JSON 方式を
# 汎用化 (sqlite_master から実表を動的列挙・FTS5仮想表/shadow表/sqlite内部表/_cf_内部表を除外)。
#
# USAGE: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bash scripts/backup-d1-tables-json-ks.sh
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_DIR/d1-json-backup-$TS"
mkdir -p "$OUT_DIR"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }

echo "==> [1/2] 実表(FTS5仮想表/shadow表/sqlite内部表を除外)を列挙"
TABLES_JSON="$(WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%' ORDER BY name" \
  --json)"
mapfile -t TABLES < <(printf '%s' "$TABLES_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(r['name'] for r in d[0]['results']))")
echo "    ${#TABLES[@]} tables"

echo "==> [2/2] 各テーブルを SELECT * → JSON dump"
for T in "${TABLES[@]}"; do
  WR d1 execute "$DB" --remote --command "SELECT * FROM \"$T\"" --json > "$OUT_DIR/$T.json"
done

echo "DONE: $OUT_DIR に ${#TABLES[@]} テーブル分の JSON backup を保存しました。"
