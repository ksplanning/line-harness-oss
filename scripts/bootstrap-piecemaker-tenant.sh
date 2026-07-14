#!/usr/bin/env bash
# bootstrap-piecemaker-tenant.sh — 空 D1 に Piecemaker テナントのスキーマを安全に bootstrap する
#   (P3-1 / plan.md §3-B / §10 B-1・B-2 反映)。冪等・fail-closed。
#
# ★ このスクリプトは「書くだけ」の成果物。実行は provisioning (P4a: D1 create → 実 id を
#   wrangler.piecemaker.toml に記入) 完了後の infra-ops run で行う。
#   provisioning 前 (database_id が placeholder) に実行すると guard3 で fail-closed する。
#
# 隔離性: 全 D1 コマンドは `--config wrangler.piecemaker.toml` を通る (WR ラッパ)。
#   ks の config を 1 度も参照しない = ks 本番 D1 不可触の構造保証。
#   prod-db-write-gate は `wrangler d1 execute --remote` を DB executor と認識せず素通り (L-7) のため、
#   config 取り違えをコードで防げない → 下の 3 重ガードが唯一の砦。
#
# 3 重ガード (§10 B-1: 空 D1 assert は line_accounts でなく sqlite_master で行う):
#   guard1: 対象 D1 が完全に空 (user table count = 0) — 既存 DB への誤 bootstrap を防止。
#   guard2: config の database_name == line-harness-piecemaker。
#   guard3: config の database_id が ks D1 id でない かつ placeholder でない (実 id 記入済)。
#   3 つ全 AND で通過。1 つでも崩れたら非ゼロ exit。
#
# USAGE (provisioning 完了後):
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/bootstrap-piecemaker-tenant.sh
#   GUARD_ONLY=1 scripts/bootstrap-piecemaker-tenant.sh   # ガードのみ (bootstrap 未実行の事前確認)
#
# 上書き env: REPO_ROOT / PIECEMAKER_TOML / DB_NAME / WRANGLER_BIN。NO SECRETS。
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PIECEMAKER_TOML="${PIECEMAKER_TOML:-$REPO_ROOT/apps/worker/wrangler.piecemaker.toml}"
DB_NAME="${DB_NAME:-line-harness-piecemaker}"
WRANGLER_BIN="${WRANGLER_BIN:-npx wrangler}"
GUARD_ONLY="${GUARD_ONLY:-0}"
KS_D1_ID="8367d856-4aa6-4a5a-9d76-6d8cf4997284"  # 誤適用ガード用: piecemaker config がこの id なら中止
PLACEHOLDER_D1='<PIECEMAKER_D1_ID>'

BOOTSTRAP_SQL="$REPO_ROOT/packages/db/bootstrap.sql"
BOOTSTRAP_META="$REPO_ROOT/packages/db/bootstrap-meta.json"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
REP_TABLES=(line_accounts friends formaloo_forms knowledge_chunks account_migrations)

# 全 D1 コマンドはこのラッパ経由 = 常に piecemaker config を通す。
WR() { $WRANGLER_BIN "$@" --config "$PIECEMAKER_TOML"; }

d1_count() {
  WR d1 execute "$DB_NAME" --remote --command "$1" 2>/dev/null \
    | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1
}

# toml から key の値 (最初の 1 件・"..." の中身) を取り出す簡易 parser。
toml_val() {
  grep -E "^$1[[:space:]]*=" "$PIECEMAKER_TOML" | head -1 \
    | sed -E 's/^[^=]+=[[:space:]]*"?([^"]*)"?.*/\1/'
}

# ─────────────────────────── 3 重ガード ───────────────────────────
echo "==> [guard 1/3] 対象 D1 が完全に空か (sqlite_master user table count)"
TCOUNT="$(d1_count "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'")"
if [ -z "${TCOUNT:-}" ]; then
  echo "!! ABORT: table count を取得できない (D1 未 provisioning / config 誤り / token 不正)。" >&2
  exit 1
fi
if [ "$TCOUNT" != "0" ]; then
  echo "!! ABORT: 対象 D1 に user table が $TCOUNT 個存在 = 空でない。既存 DB への誤 bootstrap を防止。" >&2
  exit 1
fi

echo "==> [guard 2/3] config の database_name == $DB_NAME"
DBN="$(toml_val database_name)"
if [ "$DBN" != "$DB_NAME" ]; then
  echo "!! ABORT: wrangler.piecemaker.toml の database_name='$DBN' が期待値 '$DB_NAME' と不一致。" >&2
  exit 1
fi

echo "==> [guard 3/3] config の database_id が ks D1 id でない / placeholder でない"
DID="$(toml_val database_id)"
if [ "$DID" = "$KS_D1_ID" ]; then
  echo "!! ABORT: database_id が ks の D1 id と一致 = 顧客 DB 取り違え。絶対に適用しない。" >&2
  exit 1
fi
if [ "$DID" = "$PLACEHOLDER_D1" ] || [ -z "$DID" ]; then
  echo "!! ABORT: database_id が placeholder ($PLACEHOLDER_D1) のまま = provisioning (P4a) 未実施。実 id 記入後に実行。" >&2
  exit 1
fi

echo "    guards OK: empty=0 / database_name=$DBN / database_id=$DID"
if [ "$GUARD_ONLY" = "1" ]; then
  echo "GUARD-ONLY: 3 重ガード通過 (bootstrap 未実行)。"
  exit 0
fi

# ─────────────────────────── bootstrap 本体 ───────────────────────────
echo "==> [1/3] bootstrap.sql (全 migration 焼込済) を空 D1 に適用"
if [ ! -f "$BOOTSTRAP_SQL" ]; then echo "!! bootstrap.sql が無い: $BOOTSTRAP_SQL" >&2; exit 1; fi
WR d1 execute "$DB_NAME" --remote --file "$BOOTSTRAP_SQL"

echo "==> [2/3] pending migration (bootstrap-meta.includedMigrations に無い分) を順に適用"
INCLUDED="$(grep -oE '"[0-9][^"]+\.sql"' "$BOOTSTRAP_META" | tr -d '"' | sort -u)"
PENDING=()
for f in $(ls "$MIG_DIR"/*.sql 2>/dev/null | sort | xargs -n1 basename); do
  if ! printf '%s\n' "$INCLUDED" | grep -qx "$f"; then PENDING+=("$f"); fi
done
if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "    pending 0 件 (bootstrap.sql が最新まで焼込済)。"
else
  for m in "${PENDING[@]}"; do
    echo "    -- apply $m"
    if out="$(WR d1 execute "$DB_NAME" --remote --file "$MIG_DIR/$m" 2>&1)"; then
      echo "       OK"
    elif echo "$out" | tr '[:upper:]' '[:lower:]' | grep -qE 'duplicate column|already exists'; then
      echo "       benign (already applied) — skip"
    else
      echo "!! FATAL applying $m: $out" >&2; exit 1
    fi
  done
fi

echo "==> [3/3] 代表テーブル存在 verify (${REP_TABLES[*]})"
IN_LIST="$(printf "'%s'," "${REP_TABLES[@]}" | sed 's/,$//')"
VOUT="$(WR d1 execute "$DB_NAME" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ($IN_LIST)" 2>/dev/null)"
for t in "${REP_TABLES[@]}"; do
  if ! printf '%s' "$VOUT" | grep -q "$t"; then
    echo "!! verify FAIL: 代表テーブル '$t' が見えない = スキーマ bootstrap 不完全。" >&2
    exit 1
  fi
done
echo "    代表テーブル 5/5 present。"

echo "DONE: Piecemaker テナント D1 ($DB_NAME) を空から bootstrap しました (config=$PIECEMAKER_TOML)。"
