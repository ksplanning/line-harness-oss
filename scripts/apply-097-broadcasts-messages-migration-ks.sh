#!/usr/bin/env bash
# apply-097-broadcasts-messages-migration-ks.sh — migration 097 (broadcasts.messages additive column /
# combo messages C1) を本番 D1 に安全適用する。additive のみ (ALTER TABLE ADD COLUMN NULL) で
# 既存 broadcasts 行・既存 single 配信には無影響 (messages NULL=従来 single・後方互換)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(097_broadcasts_messages_column.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/6] TRINA 事前 assert (line_accounts=1 / friends>=1) + broadcasts 行数記録"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
BC_BEFORE="$(count_of 'SELECT COUNT(*) FROM broadcasts')"
echo "    line_accounts=$ACCTS friends=$FRIENDS broadcasts=$BC_BEFORE"
if [ "$ACCTS" != "1" ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 1) = 対象 DB が TRINA でない恐れ。適用しない。" >&2
  exit 1
fi
if [ -z "$FRIENDS" ] || [ "$FRIENDS" -lt 1 ]; then
  echo "!!! ABORT: friends=$FRIENDS (期待 >=1) = 空 DB / 想定外。適用しない。" >&2
  exit 1
fi

echo "==> [1/6] バックアップは closer が本スクリプト実行前に backup-d1-tables-json-ks.sh で先行済 (BACKUP_DIR=$BACKUP_DIR)"

echo "==> [2/6] migration 097 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/6] _migrations 台帳に 097 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/6] TRINA 事後 assert (line_accounts/friends 行数不変) + broadcasts 行数不変 (無破壊)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
BC_AFTER="$(count_of 'SELECT COUNT(*) FROM broadcasts')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2 broadcasts=$BC_AFTER"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: line_accounts/friends 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi
if [ "$BC_AFTER" != "$BC_BEFORE" ]; then
  echo "!!! WARN: broadcasts 行数が変化した ($BC_BEFORE -> $BC_AFTER)。additive migration では起きないはず。要確認。" >&2
  exit 1
fi

echo "==> [5/6] broadcasts.messages 列 verify (pragma_table_info)"
WR d1 execute "$DB" --remote --command \
  "SELECT name, type FROM pragma_table_info('broadcasts')" | tee /tmp/097-broadcasts-pragma.txt
grep -q '"name": "messages"' /tmp/097-broadcasts-pragma.txt && echo "    column messages present" \
  || { echo "!!! messages 列が見えない" >&2; exit 1; }

echo "==> [6/6] _migrations 台帳 verify (097 記録済み)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM _migrations WHERE name='097_broadcasts_messages_column.sql'" | tee /tmp/097-migrations-ledger.txt
grep -q '097_broadcasts_messages_column.sql' /tmp/097-migrations-ledger.txt && echo "    ledger entry present" \
  || { echo "!!! _migrations 台帳に 097 が見えない" >&2; exit 1; }

echo "DONE: migration 097 (broadcasts.messages additive column / combo C1) を本番 D1 ($DB) に安全適用しました。"
echo "      broadcasts 行数不変確認: before=$BC_BEFORE after=$BC_AFTER"
