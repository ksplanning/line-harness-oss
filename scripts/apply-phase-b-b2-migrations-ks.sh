#!/usr/bin/env bash
# apply-phase-b-b2-migrations-ks.sh — migration 091 (Phase B batch B-2: FTS5 全文検索) を本番 D1 に安全適用する。
# 同型: apply-phase-b-b1-migrations-ks.sh / apply-formaloo-migrations-ks.sh を踏襲。additive
# (ADD COLUMN default '' / CREATE VIRTUAL TABLE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS) で
# 既存行・既存認証には無影響。B-2 も dark-ship 継続 (FAQ_BOT_ENABLED=false / crons=[] 不変) — 索引
# 構築だけでは AI 経路は起動しない。
#
# ⚠️ FTS5 仮想表を含む DB では `wrangler d1 export` が失敗する (docs/wiki/22-Operations.md)。
#    本 script は migration 091 適用「前」にバックアップを取るため faqs_fts はまだ存在せず、
#    通常の `wrangler d1 export` で問題なく動作する。適用「後」に別途バックアップが必要な場合は
#    テーブル単位 SELECT * → JSON 方式に切り替えること (仮想表は export 対象外)。
#
# 安全規律 (M-6):
#   1. TRINA 事前 assert (line_accounts=1 / friends=1) — fail-closed。
#   2. バックアップ先行 (migration 091 適用前 = FTS5 仮想表がまだ無い状態で export)。
#   3. 091 を一回だけ適用 (benign 'duplicate column'/'already exists' は二重適用に安全)。
#   4. _migrations 台帳に記録。
#   5. TRINA 事後 assert (行数不変) + 新テーブル/列 verify + faqs/faqs_fts 件数一致確認。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(091_phase_b_faq_fts.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-phaseb-b2-$TS.sql"
mkdir -p "$BACKUP_DIR"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/6] TRINA 事前 assert (line_accounts=1 / friends=1)"
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

echo "==> [1/6] バックアップ export (migration 091 適用前 = FTS5 仮想表なし) → $BK"
WR d1 export "$DB" --remote --output "$BK"

echo "==> [2/6] migration 091 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/6] _migrations 台帳に 091 を記録"
for m in "${MIGRATIONS[@]}"; do
  WR d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO _migrations (name) VALUES ('$m')"
done

echo "==> [4/6] TRINA 事後 assert (line_accounts/friends 行数不変)"
ACCTS2="$(count_of 'SELECT COUNT(*) FROM line_accounts')"
FRIENDS2="$(count_of 'SELECT COUNT(*) FROM friends')"
echo "    line_accounts=$ACCTS2 friends=$FRIENDS2"
if [ "$ACCTS2" != "$ACCTS" ] || [ "$FRIENDS2" != "$FRIENDS" ]; then
  echo "!!! WARN: 行数が変化した (additive migration では起きないはず)。要確認。復元候補=$BK" >&2
  exit 1
fi

echo "==> [5/6] faqs_fts 仮想表 verify + faqs.search_text 列 verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='faqs_fts'" \
  | grep -E "faqs_fts" && echo "    faqs_fts table present" \
  || { echo "!!! faqs_fts が見えない" >&2; exit 1; }
WR d1 execute "$DB" --remote --command "PRAGMA table_info(faqs)" | grep -E "\bsearch_text\b" \
  && echo "    faqs.search_text present" \
  || { echo "!!! faqs.search_text が見えない" >&2; exit 1; }

echo "==> [6/6] count(faqs) == count(faqs_fts) (T-B5-e / backfill 健全性)"
FAQS_CNT="$(count_of 'SELECT COUNT(*) FROM faqs')"
FTS_CNT="$(count_of 'SELECT COUNT(*) FROM faqs_fts')"
echo "    faqs=$FAQS_CNT faqs_fts=$FTS_CNT"
if [ "$FAQS_CNT" != "$FTS_CNT" ]; then
  echo "!!! WARN: count(faqs)!=count(faqs_fts) — backfillFaqsSearchText の実行が必要な可能性" >&2
  exit 1
fi

echo "DONE: migration 091 (Phase B B-2 FTS5) を本番 D1 ($DB) に安全適用しました。backup=$BK"
