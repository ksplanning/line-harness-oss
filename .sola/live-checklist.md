# treasure-b5-webhook-instant — host live checklist

## 目的と境界

この lane の sandbox では `/root` 配下の秘密値を読まず、外部 Formaloo へ mutation しない。その代わり、lane 内では
`formaloo-instant-webhook.mock-pin.test.ts` が「登録 → submit event 受信 → bounded pull → mirror upsert → 解除 → 旧 URL 404」
を固定する。以下は、査読後に秘密値を既に管理している trusted host でだけ実行する実射手順である。

- 対象は、その場で作る使い捨てフォームだけ。
- 本番 3 フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- callback secret、Formaloo JWT、API key/secret は表示・保存・貼付しない。`set +x` を維持する。
- KS と PIECE MAKER を混ぜず、各テナントの env/config でこの手順を最初から別々に実行する。
- `GET /api/forms-advanced/:id/rows` は reconcile を起こすため、即時反映の成立確認が終わるまで呼ばない。

## 0. 査読済み revision と環境を固定

migration 106 と worker/web を、査読者が許可した preview または対象環境へ deploy 済みにする。次の値は trusted host の既存 secret
管理から渡す。値そのものは手順書やログへ貼らない。

```bash
set +x
set -euo pipefail
umask 077

: "${TENANT_NAME:?ks または piecemaker}"
: "${HARNESS_BASE_URL:?対象 harness の https origin}"
: "${WORKER_PUBLIC_ORIGIN:?WORKER_PUBLIC_URL と同じ https origin}"
: "${HARNESS_API_KEY:?owner API token}"
: "${TENANT_ENV_FILE:?対象テナントの Formaloo secret env file}"

case "$TENANT_NAME" in
  ks) WRANGLER_CONFIG='apps/worker/wrangler.ks.toml' ;;
  piecemaker) WRANGLER_CONFIG='apps/worker/wrangler.piecemaker.toml' ;;
  *) exit 64 ;;
esac
test -r "$WRANGLER_CONFIG"
test -r "$TENANT_ENV_FILE"
set -a
source "$TENANT_ENV_FILE"
set +a
: "${FORMALOO_API_KEY:?missing FORMALOO_API_KEY}"
: "${FORMALOO_API_SECRET:?missing FORMALOO_API_SECRET}"

FORMALOO_BASE='https://api.formaloo.net'
BROWSER_UA='Mozilla/5.0 webhook-live-check'
DISPOSABLE_TITLE="b5-webhook-disposable-${TENANT_NAME}-$(date +%Y%m%d%H%M%S)"
FORM_ID=''
FORM_SLUG=''
PUBLIC_URL=''
FORMALOO_JWT=''
readonly PROD_DENY_RE='^(Z5IEH85R|GMOxoMtK|XqACeA2v)$'
```

Formaloo token は shell 変数だけに置く。

```bash
refresh_formaloo_token() {
  FORMALOO_JWT=$(curl -fsS -A "$BROWSER_UA" \
    -H "Authorization: Basic $FORMALOO_API_SECRET" \
    -H "x-api-key: $FORMALOO_API_KEY" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -X POST "$FORMALOO_BASE/v1.0/oauth2/authorization-token/" \
    --data 'grant_type=client_credentials' | jq -er '.authorization_token')
}
refresh_formaloo_token
```

## 1. cleanup を先に定義

途中失敗でも、生成した ID が安全な文字列で本番 denylist 外のときだけ cleanup する。

```bash
cleanup() {
  set +e
  set +x
  if [[ "$FORM_ID" =~ ^[A-Za-z0-9_-]+$ ]] && [[ ! "$FORM_ID" =~ $PROD_DENY_RE ]]; then
    curl -fsS -A "$BROWSER_UA" \
      -H "Authorization: Bearer $HARNESS_API_KEY" -H 'Content-Type: application/json' \
      -X PUT "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/instant-webhook" \
      --data '{"enabled":false}' >/dev/null
  fi
  if [[ "$FORM_SLUG" =~ ^[A-Za-z0-9_-]+$ ]] && [[ ! "$FORM_SLUG" =~ $PROD_DENY_RE ]]; then
    curl -fsS -A "$BROWSER_UA" \
      -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
      -X DELETE "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" >/dev/null
  fi
  if [[ "$FORM_ID" =~ ^[A-Za-z0-9_-]+$ ]] && [[ ! "$FORM_ID" =~ $PROD_DENY_RE ]]; then
    curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
      -X DELETE "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" >/dev/null
  fi
  FORMALOO_JWT=''
}
trap cleanup EXIT INT TERM

curl -fsS -A "$BROWSER_UA" "$HARNESS_BASE_URL/health" >/dev/null
curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced" >/dev/null
```

## 2. 使い捨てフォームを作成・保存・公開

`LINE_ACCOUNT_ID` / `WORKSPACE_ID` は必要なテナントだけ既存台帳から渡す。workspace は server が検証する。

```bash
CREATE_BODY=$(jq -nc \
  --arg title "$DISPOSABLE_TITLE" \
  --arg account "${LINE_ACCOUNT_ID:-}" \
  --arg workspace "${WORKSPACE_ID:-}" \
  '{title:$title}
   + (if $account == "" then {} else {lineAccountId:$account} end)
   + (if $workspace == "" then {} else {workspaceId:$workspace} end)')

CREATE_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" -H 'Content-Type: application/json' \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced" --data "$CREATE_BODY")
FORM_ID=$(jq -er '.data.id' <<<"$CREATE_JSON")
[[ "$FORM_ID" =~ ^[A-Za-z0-9_-]+$ ]]
[[ ! "$FORM_ID" =~ $PROD_DENY_RE ]]
unset CREATE_JSON

FIELD_ID="b5-marker-$(date +%s)"
SAVE_BODY=$(jq -nc --arg field "$FIELD_ID" '{
  fields:[{id:$field,type:"text",label:"即時反映確認",required:true,position:0,config:{}}],
  logic:[], formType:"simple", localizationJa:true
}')
SAVE_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" -H 'Content-Type: application/json' \
  -X PUT "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" --data "$SAVE_BODY")
jq -e '.success == true and .data.syncStatus == "idle"' <<<"$SAVE_JSON" >/dev/null
FORM_SLUG=$(jq -er '.data.formalooSlug' <<<"$SAVE_JSON")
[[ "$FORM_SLUG" =~ ^[A-Za-z0-9_-]+$ ]]
[[ ! "$FORM_SLUG" =~ $PROD_DENY_RE ]]
unset SAVE_JSON

curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/submit-for-review" >/dev/null
curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/publish" >/dev/null
PUBLIC_URL=$(curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" | jq -er '.data.publicUrl')
```

## 3. Webhook を ON にし、remote read-back を検証

管理 API が secret/URL を返さないことも同時に確認する。

```bash
ENABLE_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" -H 'Content-Type: application/json' \
  -X PUT "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/instant-webhook" \
  --data '{"enabled":true}')
jq -e '.success == true and .data.enabled == true
       and (has("secret")|not) and (has("url")|not)
       and (.data|has("secret")|not) and (.data|has("url")|not)' \
  <<<"$ENABLE_JSON" >/dev/null
unset ENABLE_JSON

WEBHOOKS_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/webhooks/")
jq -e --arg prefix "$WORKER_PUBLIC_ORIGIN/formaloo/instant/$FORM_ID/" '
  [.. | objects
    | select(((.url? // "") | startswith($prefix)) and .form_submit_events == true)]
  | length == 1' <<<"$WEBHOOKS_JSON" >/dev/null
unset WEBHOOKS_JSON

BASE_COUNT=$(curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" | jq -er '.data.submitCount')
```

## 4. hosted submit → callback → mirror の即時反映を確認

1. trusted host のブラウザで `$PUBLIC_URL` を開く。
2. 「即時反映確認」に `b5-live-<現在時刻>` を入れ、1 回だけ送信する。
3. 次の loop をすぐ実行する。この GET は D1 の件数を読むだけで Formaloo reconcile を起こさない。

```bash
DEADLINE=$((SECONDS + 45))
while (( SECONDS < DEADLINE )); do
  CURRENT_COUNT=$(curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
    "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" | jq -er '.data.submitCount')
  if (( CURRENT_COUNT >= BASE_COUNT + 1 )); then break; fi
  sleep 1
done
test "${CURRENT_COUNT:-$BASE_COUNT}" -ge "$((BASE_COUNT + 1))"
```

45 秒以内に増えれば、最大 6 時間の cron や管理画面 reconcile を待たず webhook の targeted pull が mirror upsert まで到達した。
同 form の連打抑止は lane の mock pin で `pullInputs` 1 回を固定しているため、live で大量送信しない。

## 5. Webhook 解除と使い捨て資源の DELETE→404

```bash
curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" -H 'Content-Type: application/json' \
  -X PUT "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/instant-webhook" \
  --data '{"enabled":false}' | jq -e '.success == true and .data.enabled == false' >/dev/null

WEBHOOKS_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/webhooks/")
jq -e --arg prefix "$WORKER_PUBLIC_ORIGIN/formaloo/instant/$FORM_ID/" '
  [.. | objects | select((.url? // "") | startswith($prefix))] | length == 0' \
  <<<"$WEBHOOKS_JSON" >/dev/null
unset WEBHOOKS_JSON

curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  -X DELETE "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" >/dev/null
FORM_GET_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/")
test "$FORM_GET_STATUS" = 404

curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X DELETE "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" >/dev/null
LOCAL_GET_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID")
test "$LOCAL_GET_STATUS" = 404

FORM_SLUG=''
FORM_ID=''
trap - EXIT INT TERM
FORMALOO_JWT=''
```

KS が完了したら shell を閉じ、PIECE MAKER の secret/env と `wrangler.piecemaker.toml` で新しい shell から同じ手順を繰り返す。
