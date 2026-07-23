#!/usr/bin/env bash
# discord-forum-post.sh — line-harness フォーラム(1516596330691301428)に「1案件=1投稿」を作成する。
#   owner 指定(2026-07-23): 完了報告は旧チャンネルでなくフォーラムへ。
# 使い方: bash scripts/discord-forum-post.sh "<タイトル>" "<本文>"
#   出力: 作成された thread_id (成功時) / エラー内容 (失敗時 rc=1)
set -euo pipefail
TITLE="${1:?タイトル必須}"
BODY="${2:?本文必須}"
FORUM_ID="1516596330691301428"
set -a; . /root/.openclaw/credentials/line-harness-ks-bootstrap-secrets.env 2>/dev/null; set +a
TOKEN="${DISCORD_BOT_TOKEN:-${DISCORD_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "❌ bot token 不明" >&2; exit 1; }
PAYLOAD=$(jq -nc --arg n "$TITLE" --arg c "$BODY" '{name: $n, message: {content: $c}}')
RES=$(curl -sS -X POST "https://discord.com/api/v10/channels/$FORUM_ID/threads" \
  -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" -d "$PAYLOAD")
TID=$(echo "$RES" | jq -r '.id // empty')
if [ -n "$TID" ]; then
  echo "$TID"
else
  echo "❌ forum post 失敗: $(echo "$RES" | jq -r '.message // .')" >&2
  exit 1
fi
