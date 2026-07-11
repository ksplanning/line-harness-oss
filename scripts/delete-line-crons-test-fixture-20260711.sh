#!/usr/bin/env bash
# delete-line-crons-test-fixture-20260711.sh — owner 承認済み (2026-07-11 22:2x / case line-crons-enable)
# の単発クリーンアップ。deploy 前 D1 安全確認で検出した仕掛品 1 行のみを削除する。
# バックアップ済 (workspace .ars-state/rollback/line-crons-enable-friend-scenario-backup-20260711.json)。
# 対象: friend_scenarios id=947267ac-3f8f-4b17-8305-a7c67369e00d
#       scenario_id=scenario_step1_delayed_20260629 (E2E テストフィクスチャと確定
#       — friends.line_user_id='Ustep1synthetic20260629blocked001' / metadata.e2e_test='xyz')
# 影響行数=1 のみを assert。id と scenario_id の複合 WHERE + 事前/事後 COUNT 検証。
set -euo pipefail

DB="${DB_NAME:-line-harness-ks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ID="947267ac-3f8f-4b17-8305-a7c67369e00d"
TARGET_SCENARIO="scenario_step1_delayed_20260629"

WR() { npx wrangler "$@" --config "$REPO_ROOT/apps/worker/wrangler.ks.toml"; }
count_of() { WR d1 execute "$DB" --remote --command "$1" 2>/dev/null | grep -oE '"COUNT\(\*\)": [0-9]+' | grep -oE '[0-9]+' | head -1; }

echo "==> [0/3] 事前確認: 対象行が exactly 1 件存在するか"
PRE="$(count_of "SELECT COUNT(*) FROM friend_scenarios WHERE id='$TARGET_ID' AND scenario_id='$TARGET_SCENARIO'")"
echo "    pre_count=$PRE"
if [ "$PRE" != "1" ]; then
  echo "!!! ABORT: 対象行が 1 件でない (pre_count=$PRE)。想定外のため削除しない。" >&2
  exit 1
fi

echo "==> [1/3] 削除 (id + scenario_id 複合 WHERE / friend_scenarios 単一行のみ)"
WR d1 execute "$DB" --remote --command \
  "DELETE FROM friend_scenarios WHERE id='$TARGET_ID' AND scenario_id='$TARGET_SCENARIO'"

echo "==> [2/3] 事後確認: 対象行が 0 件になったか"
POST="$(count_of "SELECT COUNT(*) FROM friend_scenarios WHERE id='$TARGET_ID' AND scenario_id='$TARGET_SCENARIO'")"
echo "    post_count=$POST"
if [ "$POST" != "0" ]; then
  echo "!!! FATAL: 削除後も行が残存 (post_count=$POST)。要調査。" >&2
  exit 1
fi

echo "==> [3/3] friends / scenarios 定義行は不触 (意図的に削除しない) — 完了"
