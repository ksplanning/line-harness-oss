#!/usr/bin/env bash
# apply-phase-b-b3-migrations-ks.sh — migration 092 (Phase B batch B-3: 取込ナレッジ基盤/SSRFガード) を本番 D1 に安全適用する。
# 同型: apply-phase-b-b2-migrations-ks.sh を踏襲。additive
# (CREATE TABLE/INDEX/VIRTUAL TABLE/TRIGGER IF NOT EXISTS) で既存行・既存認証には無影響。
# B-3 も dark-ship 継続 (FAQ_BOT_ENABLED=false / crons=[] 不変)。knowledge_chunks は live RAG
# 未結線 (取込資料が回答に出ない) — 索引構築だけでは AI 経路は起動しない。
#
# ⚠️ knowledge_chunks_fts も FTS5 仮想表のため、migration 092 適用「前」(仮想表がまだ無い状態)
#    でバックアップを取る (091 と同じ理由 / docs/wiki/22-Operations.md)。
#
# 安全規律 (M-6):
#   1. TRINA 事前 assert (line_accounts=1 / friends=1) — fail-closed。
#   2. バックアップ先行 (migration 092 適用前)。
#   3. 092 を一回だけ適用 (benign 'duplicate column'/'already exists' は二重適用に安全)。
#   4. _migrations 台帳に記録。
#   5. TRINA 事後 assert (行数不変) + 新テーブル/列 verify。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/packages/db/migrations"
MIGRATIONS=(092_phase_b_knowledge_chunks.sql)
BACKUP_DIR="${BACKUP_DIR:-/root/.secrets/line-harness-ks}"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_DIR/d1-backup-phaseb-b3-$TS.sql"
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

echo "==> [1/6] バックアップ (テーブル単位 SELECT*→JSON方式)"
# ⚠️ `wrangler d1 export` は本番DBが既に FTS5 仮想表(faqs_fts / migration 091)を含むため
# 恒久的に失敗する ("cannot export databases with Virtual Tables (fts5)" / live実測 2026-07-11)。
# migration 092 適用前でも export 不可(faqs_fts が既存のため)。docs/wiki/22-Operations.md の
# テーブル単位 SELECT*→JSON 方式(backup-d1-tables-json-ks.sh)に切替。
bash "$REPO_ROOT/scripts/backup-d1-tables-json-ks.sh"
BK="(JSON backup — 上記 backup-d1-tables-json-ks.sh の出力ディレクトリ参照)"

echo "==> [2/6] migration 092 を適用 (benign 'duplicate column'/'already exists' は許容)"
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

echo "==> [3/6] _migrations 台帳に 092 を記録"
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

echo "==> [5/6] knowledge_documents / knowledge_chunks / knowledge_chunks_fts verify"
WR d1 execute "$DB" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('knowledge_documents','knowledge_chunks','knowledge_chunks_fts')" \
  | grep -E "knowledge_documents|knowledge_chunks|knowledge_chunks_fts" && echo "    tables present" \
  || { echo "!!! knowledge tables が見えない" >&2; exit 1; }

echo "==> [6/6] count(knowledge_chunks) == count(knowledge_chunks_fts) (T-C live-check / backfill 健全性)"
DOC_CNT="$(count_of 'SELECT COUNT(*) FROM knowledge_documents')"
CHUNK_CNT="$(count_of 'SELECT COUNT(*) FROM knowledge_chunks')"
FTS_CNT="$(count_of 'SELECT COUNT(*) FROM knowledge_chunks_fts')"
echo "    knowledge_documents=$DOC_CNT knowledge_chunks=$CHUNK_CNT knowledge_chunks_fts=$FTS_CNT"
if [ "$CHUNK_CNT" != "$FTS_CNT" ]; then
  echo "!!! WARN: count(knowledge_chunks)!=count(knowledge_chunks_fts) — backfill の実行が必要な可能性" >&2
  exit 1
fi

echo "DONE: migration 092 (Phase B B-3 取込ナレッジ基盤) を本番 D1 ($DB) に安全適用しました。backup=$BK"
