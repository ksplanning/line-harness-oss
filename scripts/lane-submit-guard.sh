#!/usr/bin/env bash
# lane-submit-guard.sh — レーン発射前の発注書ガードレール (2026-07-23 owner 承認・正本)
#   G1: 設定/フラグ/ボタン/削除系の案件なのに done_conditions に「往復(保存→再取得→一致)」検証が無い → 発射拒否
#   G2: done_conditions にレーン内で実行不可能な条件(deployed スクショ/owner 確認等) → 発射拒否
#   通過時のみ lane-drive.sh submit へ透過 pass-through。
#   強制迂回: LANE_GUARD_ACK=1 (理由を必ず宣言してから使う / 濫用禁止)
# 使い方: bash scripts/lane-submit-guard.sh --handoff <path> --repo <abs> [--detach ...]
set -uo pipefail

LANE_DRIVE="${LANE_SUBMIT_GUARD_DRIVE:-/root/.openclaw/workspace/scripts/sola-run/lane-drive.sh}"
HANDOFF=""
ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$HANDOFF" ] && [ -f "$HANDOFF" ] || { echo "❌ [lane-guard] --handoff <path> 必須" >&2; exit 64; }

TASKS="$(jq -r '.tasks_ref // empty' "$HANDOFF")"
[ -n "$TASKS" ] && [ -f "$TASKS" ] || { echo "❌ [lane-guard] handoff の tasks_ref が実在しない: $TASKS" >&2; exit 64; }

if [ "${LANE_GUARD_ACK:-0}" = "1" ]; then
  echo "⚠️ [lane-guard] LANE_GUARD_ACK=1 — ガード迂回 (理由の宣言必須)" >&2
else
  # done_conditions 節を抽出 (## done_conditions 見出し以降)
  DONE_SECTION="$(awk '/^## done_conditions/{f=1} f' "$TASKS")"
  [ -n "$DONE_SECTION" ] || { echo "❌ [lane-guard] G0: tasks.md に '## done_conditions' 節が無い: $TASKS" >&2; exit 65; }

  # G1: 状態を保存する UI/設定系キーワードを含む案件は往復検証必須
  if grep -qE "設定|フラグ|トグル|チェックボックス|チェックを|スイッチ|保存|削除|ボタン" "$TASKS"; then
    if ! echo "$DONE_SECTION" | grep -qE "往復|再取得|開き直|再読み?込|round.?trip|→一致|一致を(確認|assert)|reload"; then
      cat >&2 <<'MSG'
❌ [lane-guard] G1: 設定/保存/削除系の案件なのに done_conditions に往復検証が無い。
   必須: 「操作(保存/削除)→再取得(GET/一覧/詳細)→値/状態の一致」をテストする done 条件を追加すること。
   由来: feedback_roundtrip_parity_test (allowBranchEdit 保存漏れ・削除→シート未反映 実事故)。
   意図的に不要な場合のみ LANE_GUARD_ACK=1 で迂回 (理由を宣言)。
MSG
      exit 65
    fi
  fi

  # G2: レーン内で実行不可能な done 条件の混入 (host closer 工程の誤混入)
  BAD_LINE="$(echo "$DONE_SECTION" | grep -nE "deployed.{0,12}(スクショ|screenshot)|実機スクショ|owner.{0,8}(確認|承認)|本番で実測" | grep -vE "host|closer 工程|後工程" | head -3 || true)"
  if [ -n "$BAD_LINE" ]; then
    echo "❌ [lane-guard] G2: done_conditions にレーン内で実行不可能な条件がある (rc=2 空回りの原因):" >&2
    echo "$BAD_LINE" >&2
    echo "   → 『host closer の後工程』として本文へ移し、done_conditions からは外すこと。feedback_lane_brief_scope_and_retry 参照。" >&2
    exit 65
  fi
fi

echo "✅ [lane-guard] 通過 → lane-drive submit へ"
exec bash "$LANE_DRIVE" submit "${ARGS[@]}"
