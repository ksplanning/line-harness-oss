#!/usr/bin/env bash
# apply-076-prod.sh — migration 076 (staff_members ID/PASS 列) を本番 D1 に安全適用する (batch F / M-6)。
#
# 適用は closer / deploy 経路で実行する (本 script は generator が用意した runbook)。
# additive migration なので既存行・既存 api_key 認証には無影響 (login_id/password は NULL のまま)。
#
# 安全規律 (M-6):
#   1. TRINA 事前 assert (line_accounts=1 / friends=1) — 想定外の DB を触らない fail-closed ガード。
#   2. バックアップ先行 (never operate on D1 without a backup)。
#   3. 076 を一回だけ適用 (benign 'duplicate column' は許容 = 二重適用に安全)。
#   4. _migrations 台帳に 076 を記録。
#   5. TRINA 事後 assert (行数不変 = additive の証跡) + 列存在 verify。
#
# USAGE (credentials は環境変数から / このファイルに秘密は書かない):
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#     bash scripts/apply-076-prod.sh
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/packages/db/migrations/076_staff_password_auth.sql"
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-flexidpass-$TS.sql"
mkdir -p "$BACKUP_DIR"

WR() { npx wrangler "$@"; }
# --command の 1 行目 (ヘッダ/枠) を除いた最初の数値を取り出す簡易パーサ。
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '[0-9]+' | head -1; }

echo "==> [0/5] TRINA 事前 assert (line_accounts=1 / friends=1)"
ACCTS="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS="$(count_of 'SELECT COUNT(*) FROM friends')"
echo "    line_accounts=$ACCTS friends=$FRIENDS"
if [ "$ACCTS" != "1" ] || [ "$FRIENDS" != "1" ]; then
  echo "!!! ABORT: 想定 (accts=1, friends=1) と不一致 = 対象 DB が違う恐れ。適用しない。" >&2
  exit 1
fi

echo "==> [1/5] バックアップ export → $BK"
WR d1 export "$DB" --remote --output "$BK"

echo "==> [2/5] migration 076 を適用 (benign 'duplicate column' は許容)"
if out="$(WR d1 execute "$DB" --remote --file "$MIG" 2>&1)"; then
  echo "    OK applied"
elif echo "$out" | tr '[:upper:]' '[:lower:]' | grep -qE 'duplicate column|already exists'; then
  echo "    benign (already applied) — skip"
else
  echo "!!! FATAL: $out" >&2
  echo "    復元: WR d1 execute $DB --remote --file $BK" >&2
  exit 1
fi

echo "==> [3/5] _migrations 台帳に 076 を記録"
WR d1 execute "$DB" --remote --command \
  "INSERT OR IGNORE INTO _migrations (name) VALUES ('076_staff_password_auth.sql')"

echo "==> [4/5] TRINA 事後 assert (行数不変)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: 行数が変化した (additive migration では起きないはず)。要確認。" >&2
  exit 1
fi

echo "==> [5/5] 列存在 verify (login_id / password_hash)"
WR d1 execute "$DB" --remote --command "PRAGMA table_info(staff_members)" | grep -E "login_id|password_hash" \
  && echo "    columns present" || { echo "!!! login_id/password_hash が見えない" >&2; exit 1; }

echo "DONE: migration 076 を本番 D1 ($DB) に安全適用しました。backup=$BK"
