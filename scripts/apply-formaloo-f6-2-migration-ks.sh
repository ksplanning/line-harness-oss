#!/usr/bin/env bash
# apply-formaloo-f6-2-migration-ks.sh — migration 095 (formaloo_forms 表示スコープ列
# line_account_id/workspace_id + formaloo_account_bindings 台帳 / F6-2 本柱②④) を本番 D1 に
# 安全適用する。additive のみ (ALTER TABLE ADD COLUMN [NULL] / CREATE INDEX/TABLE IF NOT EXISTS)
# で既存行・既存認証には無影響 (NULL 既定 = 後方互換 / F6-2 D-1)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(095_formaloo_forms_account_workspace.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] TRINA 事前 assert (line_accounts=1 / friends=1) + formaloo_forms 行数記録"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
FORMS_BEFORE="$(count_of 'SELECT COUNT(*) FROM formaloo_forms')"
echo "    line_accounts=$ACCTS friends=$FRIENDS formaloo_forms=$FORMS_BEFORE"
if [ "$ACCTS" != "1" ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 1) = 対象 DB が TRINA でない恐れ。適用しない。" >&2
  exit 1
fi
if [ -z "$FRIENDS" ] || [ "$FRIENDS" -lt 1 ]; then
  echo "!!! ABORT: friends=$FRIENDS (期待 >=1) = 空 DB / 想定外。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] バックアップは closer が本スクリプト実行前に backup-d1-tables-json-ks.sh で先行済 (BACKUP_DIR=$BACKUP_DIR)"

echo "==> [2/5] migration 095 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/5] _migrations 台帳に 095 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/5] TRINA 事後 assert (line_accounts/friends 行数不変) + formaloo_forms 行数不変 (無破壊)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
FORMS_AFTER="$(count_of 'SELECT COUNT(*) FROM formaloo_forms')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2 formaloo_forms=$FORMS_AFTER"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: line_accounts/friends 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi
if [ "$FORMS_AFTER" != "$FORMS_BEFORE" ]; then
  echo "!!! WARN: formaloo_forms 行数が変化した ($FORMS_BEFORE -> $FORMS_AFTER)。additive migration では起きないはず。要確認。" >&2
  exit 1
fi

echo "==> [5/5] formaloo_forms 新列 + formaloo_account_bindings 存在 + pragma_table_info verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='formaloo_account_bindings'" \
  | grep -q "formaloo_account_bindings" && echo "    table formaloo_account_bindings present" \
  || { echo "!!! formaloo_account_bindings が見えない" >&2; exit 1; }
WR d1 execute "$DB" --remote --command \
  "SELECT name, type FROM pragma_table_info('formaloo_forms')" | tee /tmp/f6-2-formaloo_forms-pragma.txt
grep -q '"name": "line_account_id"' /tmp/f6-2-formaloo_forms-pragma.txt && echo "    column line_account_id present" \
  || { echo "!!! line_account_id 列が見えない" >&2; exit 1; }
grep -q '"name": "workspace_id"' /tmp/f6-2-formaloo_forms-pragma.txt && echo "    column workspace_id present" \
  || { echo "!!! workspace_id 列が見えない" >&2; exit 1; }

echo "DONE: migration 095 (F6-2 formaloo_forms scope + account_bindings) を本番 D1 ($DB) に安全適用しました。"
echo "      formaloo_forms 行数不変確認: before=$FORMS_BEFORE after=$FORMS_AFTER"
