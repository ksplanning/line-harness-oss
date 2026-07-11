#!/usr/bin/env bash
# apply-formaloo-auto-pull-migration-ks.sh — migration 098 (formaloo_sync_state drift 追跡列 +
# formaloo_drift_events 監査履歴 / formaloo-auto-pull・owner 必須発注) を本番 D1 に安全適用する。
# additive のみ (ALTER TABLE ADD COLUMN / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(098_formaloo_drift.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/6] TRINA 事前 assert (line_accounts=1 / friends=1) + formaloo_forms/sync_state 行数記録"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
FORMS_BEFORE="$(count_of 'SELECT COUNT(*) FROM formaloo_forms')"
SYNC_BEFORE="$(count_of 'SELECT COUNT(*) FROM formaloo_sync_state')"
echo "    line_accounts=$ACCTS friends=$FRIENDS formaloo_forms=$FORMS_BEFORE formaloo_sync_state=$SYNC_BEFORE"
if [ "$ACCTS" != "1" ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 1) = 対象 DB が TRINA でない恐れ。適用しない。" >&2
  exit 1
fi
if [ -z "$FRIENDS" ] || [ "$FRIENDS" -lt 1 ]; then
  echo "!!! ABORT: friends=$FRIENDS (期待 >=1) = 空 DB / 想定外。適用しない。" >&2
  exit 1
fi

echo "==> [1/6] バックアップは closer が本スクリプト実行前に backup-d1-tables-json-ks.sh で先行済 (BACKUP_DIR=$BACKUP_DIR)"

echo "==> [2/6] migration 098 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/6] _migrations 台帳に 098 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/6] TRINA 事後 assert (line_accounts/friends 行数不変) + formaloo_forms/sync_state 行数不変 (無破壊)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
FORMS_AFTER="$(count_of 'SELECT COUNT(*) FROM formaloo_forms')"
SYNC_AFTER="$(count_of 'SELECT COUNT(*) FROM formaloo_sync_state')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2 formaloo_forms=$FORMS_AFTER formaloo_sync_state=$SYNC_AFTER"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: line_accounts/friends 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi
if [ "$FORMS_AFTER" != "$FORMS_BEFORE" ] || [ "$SYNC_AFTER" != "$SYNC_BEFORE" ]; then
  echo "!!! WARN: formaloo_forms/formaloo_sync_state 行数が変化した。additive migration では起きないはず。要確認。" >&2
  exit 1
fi

echo "==> [5/6] formaloo_sync_state drift 5 列 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM pragma_table_info('formaloo_sync_state')" | tee /tmp/098-formaloo_sync_state-pragma.txt
for col in remote_definition_hash pending_remote_hash drift_status drift_detected_at remote_updated_at; do
  grep -q "\"name\": \"$col\"" /tmp/098-formaloo_sync_state-pragma.txt && echo "    column $col present" \
    || { echo "!!! $col 列が見えない" >&2; exit 1; }
done

echo "==> [6/6] formaloo_drift_events テーブル存在 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='formaloo_drift_events'" \
  | grep -q "formaloo_drift_events" && echo "    table formaloo_drift_events present" \
  || { echo "!!! formaloo_drift_events が見えない" >&2; exit 1; }

echo "DONE: migration 098 (formaloo-auto-pull drift追跡+監査履歴) を本番 D1 ($DB) に安全適用しました。"
echo "      formaloo_forms/sync_state 行数不変確認: forms before=$FORMS_BEFORE after=$FORMS_AFTER / sync_state before=$SYNC_BEFORE after=$SYNC_AFTER"
