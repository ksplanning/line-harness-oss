#!/usr/bin/env bash
# apply-formaloo-post-edit-migration-ks.sh — migration 099 (formaloo_forms.allow_post_edit 列 /
# form-media-limits ③ 編集禁止トグル・弾M 前提スイッチ) を本番 D1 に安全適用する。
# additive のみ (ALTER TABLE ADD COLUMN INTEGER NOT NULL DEFAULT 0 = 定数 DEFAULT)。両テナント適用は closer が dual。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(099_formaloo_post_edit.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] TRINA 事前 assert (line_accounts=1 / friends>=1) + formaloo_forms 行数記録"
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

echo "==> [1/5] migration 099 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [2/5] _migrations 台帳に 099 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [3/5] TRINA 事後 assert (line_accounts/friends/formaloo_forms 行数不変 = 無破壊)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
FORMS_AFTER="$(count_of 'SELECT COUNT(*) FROM formaloo_forms')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2 formaloo_forms=$FORMS_AFTER"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ] || [ "$FORMS_AFTER" != "$FORMS_BEFORE" ]; then
  echo "!!! WARN: 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi

echo "==> [4/5] allow_post_edit 列 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM pragma_table_info('formaloo_forms')" | tee /tmp/099-formaloo_forms-pragma.txt
grep -q "\"name\": \"allow_post_edit\"" /tmp/099-formaloo_forms-pragma.txt && echo "    column allow_post_edit present" \
  || { echo "!!! allow_post_edit 列が見えない" >&2; exit 1; }

echo "==> [5/5] 既存行の allow_post_edit が既定 0 verify (NOT NULL DEFAULT 0)"
WR d1 execute "$DB" --remote --command \
  "SELECT COUNT(*) FROM formaloo_forms WHERE allow_post_edit IS NULL" | grep -q '"COUNT\(\*\)": 0' \
  && echo "    all rows allow_post_edit NOT NULL (既定 0)" \
  || { echo "!!! allow_post_edit に NULL 行あり = 想定外" >&2; exit 1; }

echo "DONE: migration 099 (formaloo_forms.allow_post_edit / form-media-limits ③) を本番 D1 ($DB) に安全適用しました。"
echo "      formaloo_forms 行数不変確認: before=$FORMS_BEFORE after=$FORMS_AFTER"
