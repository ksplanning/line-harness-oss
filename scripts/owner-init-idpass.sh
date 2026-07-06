#!/usr/bin/env bash
#
# owner 初期アカウント発行 (batch F / T-F5)。
#
# ID/PASS ログイン移行にあたり、owner ロールの staff 行を作り login_id + password を設定する。
# 平文パスワードは **この repo にも引数にも書かない** — 環境変数で渡し、HTTPS 越しに endpoint へ送る
# (server 側で即 PBKDF2 ハッシュ化・DB/ログに平文は残らない)。実際の値は Box BOLT に保管する。
#
# 使い方 (値はシェル履歴に残さないよう read で入力):
#   export API_URL="https://<worker>"          # 例: https://line-crm-api...workers.dev
#   read -rs ADMIN_API_KEY;  export ADMIN_API_KEY   # env API_KEY (owner break-glass Bearer)
#   read -r  OWNER_LOGIN_ID; export OWNER_LOGIN_ID
#   read -rs OWNER_PASSWORD; export OWNER_PASSWORD
#   bash scripts/owner-init-idpass.sh
#
# 冪等性: OWNER_LOGIN_ID が既存なら login-id 設定は 409 になる (その場合はパスワードのみ再設定)。
set -euo pipefail

: "${API_URL:?API_URL を設定してください}"
: "${ADMIN_API_KEY:?ADMIN_API_KEY (owner Bearer) を設定してください}"
: "${OWNER_LOGIN_ID:?OWNER_LOGIN_ID を設定してください}"
: "${OWNER_PASSWORD:?OWNER_PASSWORD を設定してください (シェル履歴に残さないこと)}"
OWNER_NAME="${OWNER_NAME:-Owner}"

AUTH=(-H "Authorization: Bearer ${ADMIN_API_KEY}" -H "Content-Type: application/json")

echo "[1/3] owner ロールの staff 行を作成 (name=${OWNER_NAME}) ..."
CREATE_RES=$(curl -fsS -X POST "${API_URL}/api/staff" "${AUTH[@]}" \
  -d "$(jq -nc --arg n "$OWNER_NAME" '{name:$n, role:"owner"}')")
STAFF_ID=$(printf '%s' "$CREATE_RES" | jq -r '.data.id')
if [ -z "$STAFF_ID" ] || [ "$STAFF_ID" = "null" ]; then
  echo "ERROR: staff 作成に失敗: $CREATE_RES" >&2; exit 1
fi
echo "  -> staff_id=${STAFF_ID} (この行の api_key は SDK/Bearer 用。ID/PASS ログインとは別)"

echo "[2/3] ログインID を設定 (${OWNER_LOGIN_ID}) ..."
curl -fsS -X PUT "${API_URL}/api/staff/${STAFF_ID}/login-id" "${AUTH[@]}" \
  -d "$(jq -nc --arg l "$OWNER_LOGIN_ID" '{loginId:$l}')" >/dev/null && echo "  -> OK"

echo "[3/3] パスワードを設定 (平文はサーバで即ハッシュ化) ..."
curl -fsS -X PUT "${API_URL}/api/staff/${STAFF_ID}/password" "${AUTH[@]}" \
  -d "$(jq -nc --arg p "$OWNER_PASSWORD" '{password:$p}')" >/dev/null && echo "  -> OK"

# 平文は変数から即消す (プロセス残留を最小化)。
unset OWNER_PASSWORD
echo "完了: login_id=${OWNER_LOGIN_ID} で ID/PASS ログインできます。実パスワードは Box BOLT に保管してください。"
