#!/usr/bin/env bash
# apply-formaloo-row-slug-edits-migration-ks.sh — migration 100 (あと編集 / 弾M form-post-edit) を本番 D1 に安全適用する。
#   (a) formaloo_submissions.formaloo_row_slug TEXT (NULL 可) / (b) formaloo_submission_edits 表 + index。
#   additive のみ (ADD COLUMN nullable + CREATE TABLE/INDEX)。両テナント適用は closer が dual (ks + piecemaker)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(100_formaloo_row_slug_and_edits.sql)
WRANGLER_CONFIG="${WRANGLER_CONFIG:-$REPO_ROOT/apps/worker/wrangler.ks.toml}"

WR() { npx wrangler "$@" --config "$WRANGLER_CONFIG"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] TRINA 事前 assert (line_accounts=1 / friends>=1) + formaloo_submissions 行数記録"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
SUBS_BEFORE="$(count_of 'SELECT COUNT(*) FROM formaloo_submissions')"
echo "    line_accounts=$ACCTS friends=$FRIENDS formaloo_submissions=$SUBS_BEFORE"
if [ "$ACCTS" != "1" ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 1) = 対象 DB が TRINA でない恐れ。適用しない。" >&2
  exit 1
fi
if [ -z "$FRIENDS" ] || [ "$FRIENDS" -lt 1 ]; then
  echo "!!! ABORT: friends=$FRIENDS (期待 >=1) = 空 DB / 想定外。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] migration 100 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [2/5] _migrations 台帳に 100 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [3/5] TRINA 事後 assert (line_accounts/friends/formaloo_submissions 行数不変 = 無破壊)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
SUBS_AFTER="$(count_of 'SELECT COUNT(*) FROM formaloo_submissions')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2 formaloo_submissions=$SUBS_AFTER"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ] || [ "$SUBS_AFTER" != "$SUBS_BEFORE" ]; then
  echo "!!! WARN: 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi

echo "==> [4/5] formaloo_row_slug 列 + formaloo_submission_edits 表 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM pragma_table_info('formaloo_submissions')" | tee /tmp/100-formaloo_submissions-pragma.txt
grep -q "\"name\": \"formaloo_row_slug\"" /tmp/100-formaloo_submissions-pragma.txt && echo "    column formaloo_row_slug present" \
  || { echo "!!! formaloo_row_slug 列が見えない" >&2; exit 1; }
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='formaloo_submission_edits'" | grep -q formaloo_submission_edits \
  && echo "    table formaloo_submission_edits present" \
  || { echo "!!! formaloo_submission_edits 表が見えない" >&2; exit 1; }

echo "==> [5/5] 既存 submission 行の formaloo_row_slug が全て NULL verify (nullable additive)"
WR d1 execute "$DB" --remote --command \
  "SELECT COUNT(*) FROM formaloo_submissions WHERE formaloo_row_slug IS NOT NULL" | grep -q '"COUNT\(\*\)": 0' \
  && echo "    既存行 formaloo_row_slug は全て NULL (legacy = backfill 対象)" \
  || echo "    (note) 一部行に row_slug 既存値あり = 適用後の再実行 or backfill 済"

echo "DONE: migration 100 (formaloo_row_slug + formaloo_submission_edits / 弾M あと編集) を本番 D1 ($DB) に安全適用しました。"
echo "      formaloo_submissions 行数不変確認: before=$SUBS_BEFORE after=$SUBS_AFTER"
