#!/usr/bin/env bash
# closing-report-gate.sh — 完了報告のガードレール (PreToolUse hook / 2026-07-23 owner 承認・正本)
#   Discord 投稿 (discord-post.sh) を含む Bash コマンドを検査し、直近 120 分以内の最新 REPORT_*.md が
#   `status: completed` なのに `deployed_verify:` (本番実測記録) が空/欠落なら投稿を物理ブロックする。
#   由来: 殻完了禁止 (owner 恒久ルール) + feedback_deployed_live_verify_before_done。
#   強制迂回: コマンド文字列に CLOSING_GATE_ACK=1 を含める (理由の宣言必須 / 濫用禁止)。
set -uo pipefail

INPUT="$(cat)"
CMD="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# discord-post.sh を含まない Bash は素通し
case "$CMD" in
  *discord-post.sh*) : ;;
  *) exit 0 ;;
esac

# 明示迂回
case "$CMD" in
  *CLOSING_GATE_ACK=1*) exit 0 ;;
esac

WS="/root/.openclaw/line-harness-ks"
# 直近 120 分以内に更新された最新 REPORT
LATEST="$(find "$WS" -maxdepth 1 -name 'REPORT_*.md' -mmin -120 -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
[ -n "$LATEST" ] || exit 0

STATUS="$(grep -m1 '^status:' "$LATEST" | sed 's/^status:[[:space:]]*//')"
[ "$STATUS" = "completed" ] || exit 0

DV="$(grep -m1 '^deployed_verify:' "$LATEST" | sed 's/^deployed_verify:[[:space:]]*//')"
if [ -z "$DV" ]; then
  jq -nc --arg reason "🚫 [closing-gate] $(basename "$LATEST") は status: completed なのに deployed_verify:(本番実測の記録) が空/欠落。本番環境での実挙動確認を実施し REPORT frontmatter に deployed_verify: を記録してから投稿すること (殻完了禁止)。意図的な例外は CLOSING_GATE_ACK=1 を付けて理由を宣言。" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi
exit 0
