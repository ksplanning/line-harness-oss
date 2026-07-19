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
同 form の連打抑止は lane の route concurrency test で「同時 pull は 1 件、末尾世代は後続 1 回」を固定しているため、live で大量送信しない。

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

---

# friend-fields-global-schema — host live checklist

## 対象と安全条件

- sandbox では live 操作をしていない。land と migration 適用後、host 担当者が **KS と Piecemaker を別々に**検証する。片方の結果をもう片方の証跡として流用しない。
- 各 deployment で migration `105_friend_field_definitions.sql`、Worker/Web の deployment SHA、実行者、実行時刻を記録する。項目定義は deployment の D1 全体に効くため、LINE アカウントを切り替えても同じ定義が見えることを前提にする。
- 項目名は衝突しない `live確認_<tenant>_<timestamp>`、friend と form/row は PII を含まない合成データだけを使う。本番フォームや既存 friend を変更しない。
- 配信セグメントは「該当人数を計算」までとし、メッセージ配信は実行しない。token、署名済み `fr_id`、friend ID、metadata 全文は証跡へ残さない。

## CRUD・全友だち表示・個別編集

1. 友だち画面の「友だち項目定義」で、検証項目を `既定値=未`、他と重ならない表示順、有効で追加する。画面再読込後も同じ名前・既定値・表示順・有効状態で取得できることを確認する。
2. 同じ deployment 内で LINE アカウントを切り替え、両方の友だち画面に同じ定義が見えることを確認する。別 deployment には同名定義を作るまで現れないことも確認する。
3. このキーを metadata に持たない合成 friend A/B の個人情報欄を開き、両方に検証項目が `未` と表示されることを確認する。既存の friend 固有キーは残り、内部 marker は表示されないことも確認する。
4. A だけを `済` に編集して再読込し、A は `済`、B は `未` のままであることを確認する。定義の既定値を一時的に `未確認` へ更新すると B だけが `未確認` になり、A の明示値 `済` は変わらないことを確認してから、既定値を `未` へ戻す。
5. 定義を無効にして保存し、form mapping の候補から消えることを確認する。キー未設定の B からは既定値だけの行が消える一方、A の明示値 `済` は定義外の個別項目として保持表示されることを確認する。再び有効にすると B の既定値行が戻り、A の明示値も保持されていることを確認する。

## form mapping・reconcile

1. 既存フォームではなく合成 friend 専用の disposable form を作る。form builder の「友だち個人情報への反映」で、検証項目が「個人情報の項目名」の候補に出ること、候補外の自由文字も引き続き入力できることを確認する。
2. disposable field → 検証項目の mapping を保存して画面を再読込し、設定が保持されることを確認する。
3. host の secret-safe な手順で合成 friend B 用の署名済み `fr_id` を disposable row にだけ設定する。field を `確認済` にし、回答データまたは統計画面を開いて reconcile を発火する。
4. B の個人情報欄を再読込し、既定値 `未` ではなく `確認済` と表示されることを確認する。A、mapping 外の friend 固有キー、内部 marker の非表示は変わらないことも確認する。

## 配信出し分け条件

1. 対象 LINE アカウントの friend 総数を先に記録する。配信セグメントで `metadata_equals` 相当の「検証項目 = 未」を指定し、キー未設定の friend が既定値 `未` として人数へ含まれることを確認する。
2. 「検証項目 = 済」では A が、「検証項目 = 確認済」では reconcile 後の B が含まれることを、該当人数だけで確認する。配信は行わない。
3. 定義を一時的に無効にした場合、未設定 friend を既定値 `未` とみなさないことを確認する。確認後は有効へ戻す。

## cleanup・rollback

1. disposable form の mapping と row/form を通常の host cleanup 手順で削除する。合成 friend A/B を削除または検証前の状態へ戻し、その後で検証項目を削除する。削除後の GET/画面再読込で定義が消えたことを確認する。
2. 定義の削除や無効化は既存 `friend.metadata` を書き換えない。明示編集や reconcile 済みの値は自動では元に戻らないため、合成 friend 以外を復元対象にしない。
3. 異常時の即時停止は、対象定義を無効にして mapping を外す。code rollback が必要なら承認済みの直前 deployment へ戻すが、additive migration/table は drop せず、既存 metadata の変換・移行もしない。
4. KS を全項目 PASS・cleanup 済みにしてから Piecemaker を同じ手順で検証する。どちらか一方でも未確認なら live PASS にせず、FAIL または BLOCKED として返す。

## PASS 記録

- [ ] KS: CRUD、deployment 全体表示、既定値、個別編集、無効/再有効、mapping/reconcile、segment count、cleanup が PASS。
- [ ] Piecemaker: CRUD、deployment 全体表示、既定値、個別編集、無効/再有効、mapping/reconcile、segment count、cleanup が PASS。
- [ ] 本番フォーム・既存 friend の mutation 0、配信 0、秘密値の記録 0。
