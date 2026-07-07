#!/usr/bin/env bash
# apply-roles-migrations-ks.sh — migration 086-088 (カスタムロール + 機能単位権限 / G64) を本番 D1 に安全適用する。
#
# 適用は closer / deploy 経路で実行する (本 script は generator が用意した runbook / apply-076-prod.sh と同型)。
# 全て additive migration (CREATE TABLE IF NOT EXISTS / ADD COLUMN nullable / CREATE INDEX IF NOT EXISTS) なので
# 既存行・既存 api_key/ID-PASS 認証には無影響 (roles/role_permissions は新規空テーブル・staff.role_id は NULL)。
#
# 安全規律 (M-6):
#   1. TRINA 事前 assert (line_accounts=1 = 対象 DB が TRINA である確証 / friends>=1 = 空 DB でない) — fail-closed。
#   2. バックアップ先行 (never operate on D1 without a backup)。
#   3. 086/087/088 を順に一回だけ適用 (benign 'duplicate column'/'already exists' は二重適用に安全)。
#   4. _migrations 台帳に 086/087/088 を記録。
#   5. TRINA 事後 assert (line_accounts/friends 行数不変 = additive の証跡) + 新テーブル/列 verify。
#
# USAGE (credentials は環境変数から / このファイルに秘密は書かない):
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=8afbae04688d10af42d2d4ab5a323019 \
#     bash scripts/apply-roles-migrations-ks.sh
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(086_roles.sql 087_role_permissions.sql 088_staff_role_id.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-roles-$TS.sql"
mkdir -p "$BACKUP_DIR"

WR() { npx wrangler "$@"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '[0-9]+' | head -1; }

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

echo "==> [2/5] migration 086-088 を順に適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/5] _migrations 台帳に 086/087/088 を記録"
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

echo "==> [5/5] 新テーブル/列 verify (roles / role_permissions / staff_members.role_id)"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('roles','role_permissions')" \
  | grep -E "roles|role_permissions" && echo "    tables present" \
  || { echo "!!! roles/role_permissions が見えない" >&2; exit 1; }
WR d1 execute "$DB" --remote --command "PRAGMA table_info(staff_members)" | grep -E "\brole_id\b" \
  && echo "    staff_members.role_id present" \
  || { echo "!!! staff_members.role_id が見えない" >&2; exit 1; }

echo "DONE: migration 086-088 (G64 roles) を本番 D1 ($DB) に安全適用しました。backup=$BK"
