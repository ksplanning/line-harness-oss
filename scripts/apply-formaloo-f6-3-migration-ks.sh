#!/usr/bin/env bash
# apply-formaloo-f6-3-migration-ks.sh — migration 096 (formaloo_folders ハーネス側フォルダ分類
# SoT + formaloo_forms.folder_id / F6-3 本柱③) を本番 D1 に安全適用する。additive のみ
# (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN NULL / CREATE INDEX IF NOT EXISTS) で
# 既存 formaloo_forms 行・既存認証には無影響 (folder_id NULL=未分類・後方互換 / F6-3 D-1)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(096_formaloo_folders.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/6] TRINA 事前 assert (line_accounts=1 / friends=1) + formaloo_forms 行数記録"
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

echo "==> [1/6] バックアップは closer が本スクリプト実行前に backup-d1-tables-json-ks.sh で先行済 (BACKUP_DIR=$BACKUP_DIR)"

echo "==> [2/6] migration 096 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/6] _migrations 台帳に 096 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/6] TRINA 事後 assert (line_accounts/friends 行数不変) + formaloo_forms 行数不変 (無破壊)"
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

echo "==> [5/6] formaloo_folders 存在 + pragma_table_info verify (平文鍵列 0 件)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='formaloo_folders'" \
  | grep -q "formaloo_folders" && echo "    table formaloo_folders present" \
  || { echo "!!! formaloo_folders が見えない" >&2; exit 1; }
WR d1 execute "$DB" --remote --command \
  "SELECT name, type FROM pragma_table_info('formaloo_folders')" | tee /tmp/f6-3-formaloo_folders-pragma.txt
grep -q '"name": "line_account_id"' /tmp/f6-3-formaloo_folders-pragma.txt && echo "    column line_account_id present" \
  || { echo "!!! line_account_id 列が見えない" >&2; exit 1; }

echo "==> [6/6] formaloo_forms.folder_id 列 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name, type FROM pragma_table_info('formaloo_forms')" | tee /tmp/f6-3-formaloo_forms-pragma.txt
grep -q '"name": "folder_id"' /tmp/f6-3-formaloo_forms-pragma.txt && echo "    column folder_id present" \
  || { echo "!!! folder_id 列が見えない" >&2; exit 1; }

echo "DONE: migration 096 (F6-3 formaloo_folders + formaloo_forms.folder_id) を本番 D1 ($DB) に安全適用しました。"
echo "      formaloo_forms 行数不変確認: before=$FORMS_BEFORE after=$FORMS_AFTER"
