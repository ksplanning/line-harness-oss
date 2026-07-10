#!/usr/bin/env bash
# apply-formaloo-migrations-ks.sh — migration 079-083 (Formaloo forms 統合) を本番 D1 に安全適用する。
# 同型: apply-roles-migrations-ks.sh (086-088) を踏襲。全て additive
# (CREATE TABLE IF NOT EXISTS / ADD COLUMN nullable / CREATE INDEX IF NOT EXISTS) で
# 既存行・既存認証には無影響。
#
# 安全規律 (M-6):
#   1. TRINA 事前 assert (line_accounts=1 / friends>=1) — fail-closed。
#   2. バックアップ先行。
#   3. 079-083 を順に一回だけ適用 (benign 'duplicate column'/'already exists' は二重適用に安全)。
#   4. _migrations 台帳に記録。
#   5. TRINA 事後 assert (行数不変) + 新テーブル/列 verify。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(079_formaloo_forms.sql 080_formaloo_publish_gate.sql 081_formaloo_answer_path.sql 082_formaloo_saved_filters.sql 083_formaloo_sheets.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-formaloo-$TS.sql"
mkdir -p "$BACKUP_DIR"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] TRINA 事前 assert (line_accounts=1 / friends>=1)"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
echo "    line_accounts=$ACCTS friends=$FRIENDS"
if [ "$ACCTS" != "1" ]; then
  echo "!!! ABORT: line_accounts=$ACCTS (期待 1) = 対象 DB が TRINA でない恐れ。適用しない。" >&2
  exit 1
fi
if [ -z "$FRIENDS" ] || [ "$FRIENDS" -lt 1 ]; then
  echo "!!! ABORT: friends=$FRIENDS (期待 >=1) = 空 DB / 想定外。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] バックアップ export → $BK"
WR d1 export "$DB" --remote --output "$BK"

echo "==> [2/5] migration 079-083 を順に適用 (benign 'duplicate column'/'already exists' は許容)"
for m in "${MIGRATIONS[@]}"; do
  echo "    -- $m"
  if out="$(WR d1 execute "$DB" --remote --file "$MIG_DIR/$m" 2>&1)"; then
    echo "       OK applied"
  elif echo "$out" | tr '[:upper:]' '[:lower:]' | grep -qE 'duplicate column|already exists'; then
    echo "       benign (already applied) — skip"
  else
    echo "!!! FATAL applying $m: $out" >&2
    echo "    復元: WR d1 execute $DB --remote --file $BK" >&2
    exit 1
  fi
done

echo "==> [3/5] _migrations 台帳に 079-083 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/5] TRINA 事後 assert (line_accounts/friends 行数不変)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: 行数が変化した (additive migration では起きないはず)。要確認。復元候補=$BK" >&2
  exit 1
fi

echo "==> [5/5] 新テーブル/列 verify (formaloo_forms / formaloo_submissions / formaloo_field_map / formaloo_sync_state)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('formaloo_forms','formaloo_submissions','formaloo_field_map','formaloo_sync_state','saved_filters')" \
  | grep -E "formaloo_forms|formaloo_submissions|formaloo_field_map|formaloo_sync_state|saved_filters" && echo "    tables present" \
  || { echo "!!! formaloo tables が見えない" >&2; exit 1; }

echo "DONE: migration 079-083 (Formaloo forms) を本番 D1 ($DB) に安全適用しました。backup=$BK"
