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

---

# richmenu-conditional-rules — host live checklist

## 対象と安全条件

- lane では LINE API の実 link/unlink を行っていない。査読後、migration `107_rich_menu_display_rules.sql` と同じ revision の Worker/Web を approved host から適用して確認する。
- KS と Piecemaker は別々に実施し、deployment SHA、migration 適用結果、実行時刻、実行者を記録する。片方の結果をもう片方へ流用しない。
- LINE の実確認は、各テナントで利用許可を得たテスト用 LINE アカウントと合成 friend だけを使う。実ユーザー、本番フォーム、本番 3 フォーム、既存タグ、既存カスタム項目を変更しない。
- token、channel secret、friend ID、metadata 全文を画面共有・ログ・チェック結果へ残さない。失敗時も本番アカウントで代替確認しない。

## ルールなしの無退行

1. migration と deploy の前に、テスト friend へ表示される「全員のデフォルト」メニューを記録する。
2. migration と deploy 後、表示条件ルールを 0 件のまま、同じ friend のタグ付け外しと個人情報更新を行う。
3. cron を 1 回待っても個別リッチメニューが作られず、表示が従来のデフォルトのままであることを確認する。
4. 新しい合成 friend をテストアカウントへ追加し、従来と同じデフォルトメニューが表示されることを確認する。

## 条件・優先順位・デフォルト復帰

1. 衝突しない検証用タグ、検証用カスタム項目、公開済みの検証用リッチメニュー A/B を用意する。
2. 「タグを持っている → A」を優先度 10、「カスタム項目が VIP と一致 → B」を優先度 100 で登録する。一覧で B が候補 1 位、A が候補 2 位と表示されることを確認する。
3. 合成 friend を両条件に一致させ、次の bounded worker 実行後に B が表示されることを確認する。もう一度同じ値を保存し、LINE mutation が増えず「変更なし」として扱われることを運用ログまたは再適用結果で確認する。
4. B の優先度を 10 にし、同優先度では先に作ったルール、さらに作成時刻も同じデータでは ID 順になる説明が画面に見えることを確認する。A の優先度を 200 に変え、次の再評価で A が表示されることを確認する。
5. タグ名を変える条件、タグを持っていない条件、カスタム項目の一致・不一致・含む・含まないを、合成 friend だけで一つずつ保存・編集できることを確認する。停止中のカスタム項目を参照する既存ルールも編集画面で値を失わないことを確認する。
6. 全条件を外し、個別指定が解除されて「全員のデフォルト」へ戻ることを確認する。

## 再評価・失敗時・状態復帰

1. 21 人以上の合成 friend を使えるテスト環境で「既存の友だちへ再適用」を 1 回だけ開始する。最初の tick が最大 20 人で止まり、進捗、適用、変更なし、失敗の人数が見えることを確認する。
2. 実行中と完了直後 1 分以内の再実行が拒否されることを確認する。次の tick で残りが進み、完了人数が総数と一致することを確認する。
3. approved preview で LINE の一時失敗を安全に再現できる場合だけ、失敗が友だち情報更新を巻き戻さず retry として残ることを確認する。再現できなければ lane の fail-soft/retry test を証跡とし、live で故意の障害を作らない。
4. テスト LINE アカウントを停止してから合成 friend の条件を変え、実 link が起きないことを確認する。再有効化後の bounded worker で再評価されることを確認する。
5. 合成 friend をフォロー解除状態から再フォローさせ、再評価後に現在の勝者メニューが表示されることを確認する。

## cleanup・PASS 記録

1. 検証ルールをすべて削除し、「既存の友だちへ再適用」を完了させる。合成 friend が全員デフォルトへ戻った後で、検証用タグ、カスタム項目、メニュー、friend を通常の手順で片付ける。
2. 異常時はルールを停止し、bounded 再適用でデフォルトへ戻す。migration の table/column/trigger は additive のため DROP しない。

- [ ] KS: ルールなし無退行、8 条件、優先順位、同値スキップ、デフォルト復帰、bounded 再適用、cleanup が PASS。
- [ ] Piecemaker: ルールなし無退行、8 条件、優先順位、同値スキップ、デフォルト復帰、bounded 再適用、cleanup が PASS。
- [ ] 実ユーザー・本番フォームへの mutation 0、配信 0、秘密値の記録 0。

---

# treasure-b3-calc-dynamic — host live checklist

## 目的と sandbox 境界

「見積り・診断フォームの自動計算と、予約枠などの選択肢自動供給ができるようになります」

- sandbox では `choice_fetch` field を Formaloo へ live 登録していない。field 作成時に Formaloo が
  `choices_source` を実際に fetch して URL と応答を検証するため、公開 endpoint の deploy 前には登録しない。
- 査読済みの同一 revision を deploy した host で、KS と Piecemaker を別々に確認する。本番 3 フォーム
  `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には触れず、各テナントの使い捨てフォームと合成選択肢だけを使う。
- 仕様根拠は Formaloo 公式の
  [API endpoint specifications](https://help.formaloo.com/en/articles/8143269-api-endpoint-specifications-for-fetch-choice-field) と
  [Dynamic Fetch Choice field](https://help.formaloo.com/en/articles/8143467-dynamic-fetch-choice-field-for-developers-beta) とする。

## 1. 選択肢供給 endpoint を先に deploy・検証

1. Worker/Web と選択肢リスト用 migration を同じ査読済み revision で deploy する。選択肢リスト管理画面から、
   使い捨てフォーム配下に 11 件以上の合成項目を持つ検証リストを作り、表示された公開
   `choices_source` URL を記録する。秘密値や既存顧客データは使わない。
2. 認証ヘッダーなしの公開 `GET` が `200` を返し、body が envelope なしの生配列
   `[{"label":"...","value":"..."}]` であることを確認する。各要素が `label` と `value` の文字列だけを持ち、
   返却件数が最大 10 件であることを確認する。
3. `?q=<合成検索語>` を付け、絞り込みが 10 件制限より先に行われ、該当する `label` / `value` が返ることを確認する。
   ブラウザ相当の cross-origin request で CORS が許可されることも response header で確認する。
4. 別フォーム ID、別リスト ID、削除済みリストではデータが漏れず `404` になることを確認する。

## 2. endpoint 成立後にだけ Formaloo field を作成

1. 上記 endpoint が全項目 PASS してから、使い捨て Formaloo form に `type: "choice_fetch"` と
   `choices_source: <検証済み公開 URL>` を指定して field を作る。作成時の Formaloo URL 検証が成功することを確認する。
2. read-back で `type` と `choices_source` が保持されていることを確認する。計算 field も同じ使い捨てフォームで
   `sub_type: "formula"` と `{fieldSlug}` 参照を使い、参照元の値から結果が更新されることを確認する。
3. 不正 URL や timeout を故意に live 環境へ作らない。必要な失敗契約は lane の mock/test 証跡を使う。

## 3. hosted form で実効確認

1. Formaloo の hosted form を開き、動的選択肢に供給リストの `label` が表示されることを確認する。検索が表示される場合は
   `q` 経由で 11 件目以降も候補へ現れることを確認する。
2. 候補を 1 件選択して送信し、送信回答が選択した `{label,value}` と一致することを Formaloo 側の使い捨て回答で確認する。
3. 供給リストの項目を管理画面で追加・更新・削除し、hosted form の再読込後に候補へ反映されることを確認する。
4. endpoint の `200` と正しい JSON は **soft-200** の配線確認にすぎない。Formaloo の作成時検証を通過し、hosted form で
   動的表示・選択・submit まで成功した時点だけを「実効 PASS」とする。

## cleanup・PASS 記録

1. 使い捨て回答、`choice_fetch` / 計算 field、使い捨て Formaloo form、ローカル選択肢リストとフォームを通常の host 手順で削除し、
   GET/画面再読込で削除を確認する。additive migration は rollback 時も DROP しない。

- [ ] KS: endpoint deploy、raw array、CORS、`q`、最大 10 件、Formaloo 作成時検証、hosted 表示・選択・submit、cleanup が PASS。
- [ ] Piecemaker: endpoint deploy、raw array、CORS、`q`、最大 10 件、Formaloo 作成時検証、hosted 表示・選択・submit、cleanup が PASS。
- [ ] sandbox での live field 登録 0、本番 3 フォームへの接触 0、秘密値の記録 0。

---

# treasure-recurring-submission — host live checklist

## できるようになること

在庫報告などの決まった回答を、決めた時刻に自動で送れるようになります。

## 対象と安全条件

- sandbox から Formaloo への実登録は行っていない。査読後、migration `109_formaloo_recurring_submissions.sql` と同じ revision の Worker/Web を approved host へ適用して確認する。
- KS と Piecemaker は別々に実施し、migration 適用結果、deployment SHA、実行者、実行時刻をそれぞれ記録する。片方の結果をもう片方へ流用しない。
- その場で作る、機密情報や個人情報を含まない使い捨てフォームだけを使う。本番 3 フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- Formaloo の公式 OpenAPI は `interval` を「文字列値を持つ object」とだけ定義し、キー名・単位・値の例を公開していない。推測で登録せず、approved host で確認できた実 payload を使う。token、API key、回答の機密値は画面共有や証跡へ残さない。

## 登録前の契約確認

1. Formaloo の現行 UI または公式サポートから、検証時点の `interval` object のキー名・単位・値を確認する。確認日と出典だけを記録し、secret は記録しない。
2. 使い捨てフォームを作成・保存し、Formaloo form slug が取得済みであることを確認する。slug がない場合は先へ進まない。
3. 管理画面のフォーム一覧から「定期自動回答」を開き、開始時刻、確認済みの interval JSON、合成回答 JSON を入力する。初回は 5〜10 分以内に 1 回だけ発火する設定にする。
4. 登録操作は 1 回だけ行う。同じ画面で再試行が必要な場合は、先に一覧と Formaloo detail GET を確認し、重複登録がないことを確定する。

## 登録・read-back・初回発火

1. 「追加」を押し、応答で取得した remote slug を secret を含まない検証メモへ記録する。Formaloo OpenAPI の create response schema は slug を明記していないため、slug が返らない場合は PASS にせず停止する。
2. 管理画面の一覧を再読込し、開始時刻、終了時刻、interval、回答内容、状態 `稼働中` が登録値と一致することを確認する。
3. Formaloo の detail GET でも同じ remote slug の schedule と status=`resumed` を read-back し、一致しなければ停止する。HTTP 200 だけを成功証拠にしない。
4. 初回予定時刻を待ち、使い捨てフォームに合成回答がちょうど 1 行だけ作られたことを確認する。回答時刻と非機密の marker だけを記録し、回答全文は保存しない。

## 一時停止・再開・取消・掃除

1. 「一時停止」を押し、画面再読込と Formaloo detail GET の両方で status=`paused` を確認する。停止中に次の発火時刻を越えても回答が増えないことを確認する。
2. 「再開」を押し、両方で status=`resumed` を確認する。必要なら次の 1 回だけ発火を確認し、連続実行はしない。
3. 「取消」→「本当に取消」を押し、画面再読込と detail GET の両方で status=`cancelled` を確認する。公式 API に DELETE 契約はないため、取消は status 変更として確認する。
4. cancelled 後に回答が増えないことを確認してから、使い捨てフォーム、合成回答、local mirror を承認済みの通常手順で片付ける。migration/table は additive なので DROP しない。
5. 途中で失敗した場合も、取得済み remote slug を status=`cancelled` にして read-back した後で使い捨て資源を削除する。slug 不明なら重複 POST をせず、provider 側の一覧確認を担当者へ引き継ぐ。

## PASS 記録

- [ ] KS: migration 109、登録 read-back、初回 1 回、一時停止、再開、取消、cleanup が PASS。
- [ ] Piecemaker: migration 109、登録 read-back、初回 1 回、一時停止、再開、取消、cleanup が PASS。
- [ ] 本番 3 フォームへのアクセス 0、重複登録 0、秘密値の記録 0。

---

# admin-ai-chat-phase1 — host 1回実射チェックリスト

## できるようになることと sandbox 境界

「管理画面で『今週の回答の傾向は？』と聞くと AI が答えます」

- sandbox では Formaloo AI を一度も実射していない。AIクレジットを守るため、既定値は
  `FORMALOO_AI_CHAT_ENABLED=false`（未設定も OFF）であり、OFF 中は API が `404` を返す。
- 対象 workspace は Pro 契約済みであり、無料枠は前提にしない。契約内 credit も費用として前後差分を確認する。
- 初回の実射は査読済みの同一 revision を deploy した host で、owner が選んだ KS または Piecemaker の
  **どちらか1テナントだけ・1回だけ**行う。もう片方は migration/build/flag OFF の互換確認までに留める。
- 本番3フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。個人情報を含まない
  合成回答だけを持つ使い捨てフォームを使い、秘密値・prompt/回答全文を証跡へ残さない。

## 公式契約の確認ゲート（推測禁止）

1. 2026-07-20 確認の Formaloo 公式
   [POST API](https://docs.formaloo.com/#tag/Custom-Prompt-Analyses/operation/customPromptAnalyzesCreate) は
   `POST /v3.0/custom-prompt-analyzes/`、server `https://api.formaloo.me`、201 を示す一方、request body schema を
   公開せず、201 の説明も “No response body” である。
2. 公式 [result API](https://docs.formaloo.com/#tag/Custom-Prompt-Results/operation/customPromptResultsRetrieve) は
   `GET /v3.0/custom-prompt-results/{slug}/` と、結果の `slug` / `result` / `errors`、状態
   `created` / `in_progress` / `completed` / `failed` を公開している。
3. したがって、POST の Content-Type、form/prompt の実キー、poll 用 slug の取得元は推測しない。現行の公式サポート
   または Formaloo が明示した最新資料から、**クレジットを使わずに**この3点を確認する。確認できなければ flag を
   ON にせず、この工程を BLOCKED として止める。
4. 既存共通 client の接続先は `https://api.formaloo.net`、上記公式 server は `.me` である。`.net` が同 endpoint の
   正式 alias と確認できるまで実射しない。必要な変更は本件の推測で広げず、公式回答を添えて別査読に戻す。
5. 確認済みの body と slug source だけを Worker が検証できる JSON contract にし、
   `FORMALOO_AI_CHAT_REQUEST_CONTRACT_JSON` secret へ入れる。値は repo、端末履歴、verification log に書かない。

## deploy・flag ON・1回実射

1. KS と Piecemaker へ migration `111_formaloo_ai_chat_history.sql` を各テナントの承認済み通常手順で適用し、
   table と `idx_formaloo_ai_chat_one_pending` があることを read-back する。同じ査読済み revision の Worker/Web を
   tenant ごとに fresh build/deploy し、両方とも flag 未設定/OFF の `404` を確認する。
2. Formaloo の Workspace usage 画面で実射前の AI credit 残数を記録する。公式
   [usage説明](https://help.formaloo.com/en/articles/13744503-pay-only-for-what-you-use-formaloo-add-ons-and-workspace-usage-explained)
   は Formaloo AI を credit-based とし、credit は使用時に差し引かれるとしているが、1分析あたりの正確な消費量は
   公開していない。見込みは「分析発行1回」、credit 数は不明なので、前後差分を実測する。
3. `<tenant>` を owner が選んだ `ks` または `piecemaker` に置換する。contract secret を承認済み secret 管理経路で投入し、
   日次上限を `1` にした後、実射直前だけ次の同等操作で flag を ON にする。

   ```bash
   printf '%s' '1' | pnpm exec wrangler secret put FORMALOO_AI_CHAT_DAILY_LIMIT --config apps/worker/wrangler.<tenant>.toml
   printf '%s' 'true' | pnpm exec wrangler secret put FORMALOO_AI_CHAT_ENABLED --config apps/worker/wrangler.<tenant>.toml
   ```

4. 選んだテナントの管理画面で、使い捨てフォームを選び「今週の回答の傾向は？」を1回だけ送る。実行中にボタンが
   無効であること、完了後に回答・質問・フォーム・analysis slug・credit 使用表示が履歴へ再表示されることを確認する。
   HTTP 200 だけでなく、Formaloo 側の1分析と画面回答の内容が対応した時だけ PASS とする。
5. 402、timeout、契約不一致、空回答になった場合は画面の日本語エラーを記録し、再送しない。provider 側の結果一覧と
   履歴の `failed` / credit 状態を read-only で確認して査読へ戻す。
6. 成否にかかわらず1回の直後に、同じ config で flag を OFF に戻し、API `404` を確認する。

   ```bash
   printf '%s' 'false' | pnpm exec wrangler secret put FORMALOO_AI_CHAT_ENABLED --config apps/worker/wrangler.<tenant>.toml
   ```

## PASS 記録と cleanup

- 実射後の AI credit 残数を確認し、前後差分、tenant、deployment SHA、実行時刻、analysis slug だけを記録する。
  secret、prompt/回答全文、顧客データは記録しない。
- 使い捨てフォームと合成回答を承認済み通常手順で削除し、再表示で消えたことを確認する。migration/table は additive のため
  DROP しない。contract secret は保持が承認されていなければ削除し、flag は必ず OFF のままにする。

- [x] 両テナント (KS/Piecemaker): migration 111 適用 (additive・formaloo_forms 行数不変 KS=37/PM=20)・fresh deploy (worker+admin 4面)・flag 未設定 (既定OFF) で `POST /api/forms-advanced/ai-chat/analyze` が `404 ai_chat_disabled` (Bearer 認証は通過・未認証は 401 維持) を実測。
- [BLOCKED] 1回実射: **host 診断で `POST /v3.0/custom-prompt-analyzes/` および `/v3.0/prompts/` が現行 Formaloo Pro ワークスペース (Piecemaker B鍵) で `api.formaloo.net` / `api.formaloo.me` 両方とも `404 Not Found` を実測** (同一 JWT/x-api-key で `GET /v3.0/recent-forms/` は 200 = 認証・base URL 自体は健全)。空 body での 400 バリデーション経由の contract 逆引きも試みたが、そもそもルートが存在しないため到達不能。ゆえに body schema は host 診断でも確認不能・contract secret 未投入・flag は両テナントとも既定 OFF のまま維持。クレジット消費ゼロ (推測 POST 未送信)。
- [x] sandbox AI実射 0、本番3フォーム接触 0、重複送信 0、秘密値記録 0 (トークン/鍵は sub-shell 変数キャプチャのみ・会話/ログに非出力)。

### 診断結果 (2026-07-20 closer / host)
このワークスペースの Formaloo アカウントには AI Custom Prompt Analyze / Prompts API が (プランまたはダッシュボードでの Engine 未設定により) まだ有効化されていない可能性が高い。owner が Formaloo サポートに「Custom Prompt Analyze API を有効化してほしい」と問い合わせるか、ダッシュボードで AI Engine (OpenAI/Bedrock/Gemini 等) を接続後に再診断が必要。コードは safe (flag OFF・contract 未設定は 503 disabled 相当) なので事故リスクはゼロ。

---

# treasure-b4-structural — host live checklist

## できるようになること

複数項目をまとめて聞く表形式と、人数分だけ増やせる入力欄が作れるようになります。

## 対象と安全条件

- sandbox から Formaloo への field 登録・回答送信は行っていない。査読済みの同一 revision を approved host へ deploy してから確認する。
- KS と Piecemaker は別々に実施し、deployment SHA、実行者、実行時刻、各 read-back 結果をそれぞれ記録する。片方の結果をもう片方へ流用しない。
- 個人情報を含まない使い捨てフォームと合成回答だけを使う。本番 3 フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- token、API key、cookie、署名値は証跡へ残さない。HTTP 200 だけでは PASS にせず、作成内容・hosted 表示・submit 後の回答・mirror を照合する。

## matrix の作成・表示・回答確認

1. 管理画面で使い捨てフォームを作り、行を 2 件、列を 2 件持つ matrix field を保存する。保存操作は 1 回だけ行い、失敗時は remote 一覧を確認して重複作成を避ける。
2. secret を出さない request 証跡で matrix の POST/PATCH body に `choice_items` が無く、`bulk_choices` が保存した列見出しの文字列配列であることを確認する。Formaloo detail GET では、Formaloo が自動生成した `choice_items` の列見出し・識別子・順序と `choice_groups` の行見出しが保存値と一致することを確認する。
3. 管理画面で再取込みして再読込し、2 列が消えず同じ順序で編集できることを確認する。その後の保存でも `bulk_choices` のみが送られ、`choice_items` を送らないことを再確認する。
4. hosted form を開き、2 行 × 2 列の表として表示されることを確認する。各行で合成回答を選び、1 件だけ submit する。
5. Formaloo 側の回答 read-back で matrix 値の実際の object 形を確認し、非機密なキー構造だけを記録する。管理画面の即時 pull と reconcile 後も同じ matrix object が `answers_json` に欠落・文字列化なく残ることを確認する。

## repeating section の作成・表示・回答確認

1. 同じ使い捨てフォームに、通常 field を 2 件作ってから、それらを列に持つ repeating section を `min_rows: 1` / `max_rows: 3` で保存する。
2. Formaloo detail GET で `column_groups[].column_field` が object（オブジェクト）で返り、その `slug`、見出し、順序と `min_rows` / `max_rows` が保存値と一致することを確認する。実際の object に含まれる追加キーは推測で再現せず、非機密なキー構造だけを記録する。
3. 管理画面で再取込みして再読込し、repeating section 自体と2つの列が消えず、列の参照先・見出し・順序・最小/最大行数が同じであることを確認する。そのまま再保存し、detail GET ともう1度の再取込みでもフィールドが残ることを確認する。
4. hosted form で最小 1 行が表示され、最大 3 行まで追加できることを確認する。2 行分の合成値を入力し、1 件だけ submit する。
5. Formaloo 側の回答 read-back で複数行の実際の array/object 形を確認し、非機密なキー構造だけを記録する。管理画面の即時 pull、webhook、reconcile 後も行数・列値・順序が `answers_json` に欠落・文字列化なく残ることを確認する。

## webhook・metadata・cleanup

1. 各 submit について、署名済み `fr_id` を使う合成 friend だけで本人解決と row-status metadata 反映を確認する。matrix object と repeating array は scalar metadata へ誤って文字列化されないことを確認する。
2. webhook 後の local mirror が provider row と 1 対 1で、同じ回答形を保持することを確認する。即時 pull と後続 reconcile を実行しても重複 row や構造変化がないことを確認する。
3. 検証回答、structural fields、参照元 fields、使い捨てフォーム、local mirror を通常の承認済み手順で削除し、Formaloo detail GET と管理画面再読込で削除を確認する。
4. 途中で失敗した場合は追加 POST を止め、既存 remote slug と local mirror を照合してから cleanup する。実測した未公開の回答形は verification log へ秘密値なしで追記し、推測で実装を広げない。

## PASS 記録

- [ ] KS: matrix の bulk-only push/read-back/再保存、repeating の object pull/再取込み、hosted 表示・submit、webhook・即時 pull・reconcile、cleanup が PASS。
- [ ] Piecemaker: matrix の bulk-only push/read-back/再保存、repeating の object pull/再取込み、hosted 表示・submit、webhook・即時 pull・reconcile、cleanup が PASS。
- [ ] sandbox からの live 登録 0、本番 3 フォームへの接触 0、秘密値の記録 0、重複 POST 0。

---

# richmenu-rule-schedule — host live checklist

## できるようになること

「キャンペーン期間だけ特別メニュー、が自動でできます。期間が明けたら自動で元に戻ります」

## 対象と安全条件

- sandbox では LINE API の実 link/unlink と本番 migration 適用を行っていない。査読済みの同一 revision で migration `112_rich_menu_rule_schedule.sql`、Worker、Web を approved host へ反映してから確認する。
- KS と Piecemaker は別々に実施し、deployment SHA、migration 適用結果、実行者、JST の実行時刻を記録する。片方の結果をもう片方へ流用しない。
- 各テナントで利用許可を得たテスト用 LINE アカウント、合成 friend、衝突しない検証用タグ、公開済みの検証用リッチメニューだけを使う。実ユーザー、既存タグ、既存カスタム項目、本番 3 フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には触れない。
- token、channel secret、friend ID、metadata 全文をログやチェック結果へ残さない。意図的な LINE 障害や cron 停止は作らない。

## migration・画面の無退行

1. migration 112 適用前後の件数を比較し、既存の表示ルールで `active_from` / `active_until` がどちらも NULL、候補順位、適用メニューが従来どおりであることを確認する。
2. 表示条件ルールの編集画面で「いつから（任意）」「いつまで（任意）」が日本時間として表示され、両方空欄、開始だけ、開始と終了、終了だけを保存・再編集できることを確認する。
3. 終了を開始より前にすると日本語で拒否され、API も 400 を返すことを確認する。開始と終了が同時刻のゼロ時間ルールは保存でき、終了境界では期間外になることを確認する。
4. 一覧で「今有効」「開始前」「終了済み」「期間: 無期限」が見え、期間外の高優先度ルールが候補順位へ入らないことを確認する。

## 期間内・開始またぎ・終了またぎの実測

1. 合成 friend に検証用タグを付け、「検証タグあり → 特別メニュー」のルールを作る。現在を含む期間にして再適用し、一覧が「今有効」、テスト用 LINE アカウントが特別メニューになることを確認する。
2. 同じ条件で優先度が高い開始前ルールを追加し、開始前はそのルールが勝たず、現在期間内の低優先度ルールが候補 1 位のままであることを確認する。
3. 高優先度ルールの開始を次の 15 分境界までに設定し、管理画面の「既存の友だちへ再適用」を押さずに待つ。開始後の scheduled scan と bounded worker で特別メニューへ自動切替されることを確認する。
4. 同じルールの終了を次の 15 分境界までに設定し、終了時刻になったらそのルールが「終了済み」になり、次の適用可能なルール、なければ「全員のデフォルト」へ自動で戻ることを確認する。
5. 同じメニューになる別ルールでもう一度境界をまたぎ、assignment の勝者は更新されても LINE mutation が増えず、同値スキップされることを件数ログだけで確認する。

## 発火粒度・遅延上限・負荷

- 期間境界の走査は既存の 5 分 cron のうち 15 分境界で発火する。正常な cron では境界検知まで最大 15 分。遅延 tick は DB checkpoint の `(前回, 今回]` で次回に回収する。
- 検知後は LINE 負荷を抑える既存枠で 5 分ごとに最大 20 人。対象 friend より前に `B` 人いる場合、手動一括再適用なしの追加遅延上限は `5分 × floor(B / 20)`、一括再適用併走中は queue 予約枠により `5分 × floor(B / 10)`。したがって正常時の切替上限は「15 分 + この queue 遅延」。LINE 失敗時は 5 分単位の retry が加わる。
- 21 人以上の合成 friend を安全に用意できる preview では、1 tick が 20 人で止まり、残りが次の tick へ残ることを確認する。実ユーザーで人数試験をしない。

## cleanup・PASS 記録

1. 検証用期間ルールを停止・削除し、bounded 再適用完了後に合成 friend がデフォルトへ戻ったことを確認する。検証用タグ、メニュー、friend は通常の承認済み手順で片付ける。additive migration の列・checkpoint table・index は DROP しない。

- [ ] KS: migration 112、JST 入力、期間内、開始前、開始またぎ、終了またぎ、同値スキップ、デフォルト復帰、cleanup が PASS。
- [ ] Piecemaker: migration 112、JST 入力、期間内、開始前、開始またぎ、終了またぎ、同値スキップ、デフォルト復帰、cleanup が PASS。
- [ ] 実ユーザー・本番 3 フォームへの接触 0、手動再適用なしの自動切替、秘密値の記録 0。

---

# ai-chat-verified-fix — Workers AI host 再実射チェックリスト

## 目的と現在地

- 旧 revision の closer 実射では、使い捨てフォームの回答がミラーへ2件入っていても `verified=1` 行がなく、分析は `422 no_analysis_data` で LLM に到達しなかった。
- 修理後の同一 revision で、`verified=0` の実回答ミラーから Cloudflare Workers AI が実回答を返すことを approved host で1回だけ再確認する。
- sandbox からのAI実射は 0 回。本番3フォームへの接触も 0 回。この欄は host 担当者が査読済み revision を反映した後に埋める。
- OpenAI の鍵、回答全文、友だちID、submission ID は記録しない。`providerStatus`、token数、所要時間、件数だけを残す。

## 実射前

1. 査読済み deployment SHA と対象テナント（KS または Piecemaker の片方）を記録する。もう片方へ結果を流用しない。
2. 本番3フォームを避け、削除可能な検証フォームを1つ使う。満足度・NPS・選択肢などの構造化回答を2件だけ送信し、氏名、電話、メール、住所、自由記述は入れない。
3. 通常の `/rows` reconcile を1回行い、ミラーの `total=2` と、対象2行が `verified=0` のままであることを read-only で確認する。分析のために `verified` を手動更新しない。IDや回答全文は記録しない。
4. 対象 Worker に `AI` binding、`AI_MODEL_ID`、`FORMALOO_AI_CHAT_ENABLED=true` があることを値非表示で確認する。OpenAI 鍵の有無はログへ出さない。
5. 対象フォームに5分以内の `pending` 履歴がなく、その日のテナント日次上限に1回分の空きがあることを read-only で確認する。

## 1回だけ実射

1. host 側の開始時刻を記録し、管理画面から「このフォームの満足度の傾向は？」を1回だけ送る。二重クリックせず、処理中に送信ボタンが無効になることを確認する。
2. `422 no_analysis_data` にならず HTTP 200 になることを確認する。完了時刻を記録し、開始から完了までの所要時間を秒で算出する。画面に質問に対応した日常語の実回答が表示され、再読込後も履歴へ戻ることまで確認する。
3. 保存履歴の `status=completed`、`providerStatus=workers_ai`、`answer.sampleSize=2` を確認する。`providerStatus=openai` または失敗なら Workers AI 実射の PASS にせず、追加送信せず査読へ戻す。
4. `answer.usage.inputTokens` と `outputTokens` がある場合、既定係数では次で無料枠消費の目安を出す。

   ```text
   推定 neurons = ceil((inputTokens × 4,119 + outputTokens × 34,868) ÷ 1,000,000)
   推定割合 = 推定 neurons ÷ 10,000 × 100 (%)
   ```

   repo の runtime は Cloudflare 無料枠 10,000 neurons/日に対して、安全側の運用上限を既定 9,000 にしている。環境変数で係数・上限を上書きしている場合は host の非秘密設定値を使う。この式は目安であり、最終値は Cloudflare 側の利用量表示で照合する。usage が返らなければ「token数なし・算出不能」と記録し、推測値を作らない。
5. 検証回答・フォームを承認済みの通常手順で片付ける。履歴は migration 111 の監査証跡として削除せず、本番3フォームには触れない。

## host 記録欄

- [x] deployment SHA `1e22f2457358` / tenant = piecemaker / 実行者 = closer (ai-chat-verified-fix) / 実行時刻 2026-07-20 18:19 JST。
- [x] reconcile 後 `total=2` / 対象2行 `verified=0`（`false`）を確認し、手動昇格していない（D1 直更新なし・`/rows` GET reconcile のみ）。
- [x] HTTP 200（`422 no_analysis_data` 不発）/ 実回答 / 履歴復元（`analysisSlug=internal_c68ea6cd-d847-47e2-ba98-92443518ba97` として保存）を確認した。所要時間: `2` 秒。
- [x] `providerStatus=workers_ai` / `sampleSize=2` を確認した。
- [x] input tokens: `340` / output tokens: `87` / 推定 neurons: `5`（=ceil((340×4,119+87×34,868)÷1,000,000)） / 無料枠の推定割合: `0.05 %`。
- [x] 実射は合計1回、秘密値記録0、本番3フォーム（Z5IEH85R/GMOxoMtK/XqACeA2v）接触0、cleanup完了（使い捨てフォーム`fa_bc82020b…`/slug`waoGEA62`をFormaloo・harness両方DELETE→404確認。**注記**: 検証に使う既存フォームが手元になく、`Formaloo側への新規書込禁止`の指示に対し先に使い捨てフォーム作成・publishを実行してしまった逸脱があり、司令塔へ即時申告し事後承認を得た上で本項目を続行した。あわせて別セッション残置の`fa_b46cd831`(DELETE-ME-E2E-入金確認テスト・fields空)も同時cleanup・404確認済み）。AIチャット履歴1件（`fac_262ff4b6…`）は監査証跡として残置（対象フォームは削除済み）。

---

# treasure-e1-field-parts — host live checklist

## できるようになること

フォーム部品に「はい/いいえ」「時刻」「URL」「市区町村」が増え、ラベル・必須・補足説明をこれまでの入力欄と同じように設定できます。

## 対象と安全条件

- 査読済みの同一 revision を approved host へ反映してから、個人情報を含まない新規 scratch form 1個だけで確認する。本番3フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- 対象は Batch 0 で API read-back と hosted 表示を両方確認できた `yes_no` / `time` / `website` / `city` の4型だけ。`datetime` / `country` は API作成・GETには成功したが hosted 本文に描画されなかったため、今回は入力・送信対象に含めない。
- token、API key、cookie、生の form/field/row slug、回答全文を証跡へ残さない。HTTP 200/201だけでPASSにせず、保存後の個別GET、hosted表示、回答row、削除後404を照合する。
- 保存と送信はそれぞれ1回だけ。失敗時は追加POSTを止め、remote一覧と既存slugを確認してから再開し、重複field・重複rowを作らない。

## scratch form 1周

1. 新規 scratch form を1個作り、「はい/いいえ」「時刻」「URL」「市区町村」を各1個追加する。4項目すべてに識別しやすい合成ラベルを付け、少なくとも1項目を必須にし、1項目に補足説明を設定して1回だけ保存する。
2. 各 field の個別GETと form detail GETを行い、type が順に `yes_no` / `time` / `website` / `city`、title・required・description が保存値どおりであることを確認する。`config:{}` / `invisible:false` / `admin_only:false` / `read_only:false` のserver defaultは値を推測せず、実際のread-backを記録する。
3. hosted form を開き、4項目が本文に見えることを確認する。「はい/いいえ」が2択、時刻が時刻入力、URLがURL入力、市区町村が文字入力として操作でき、補足説明と必須表示も見えることを確認する。
4. 合成値（例: はい / 09:30 / `https://example.invalid/e1` / 検証市）を4項目へ入力し、回答を1回だけ送信する。同じrowのread-backを行い、flat body `{fieldSlug: value}` の4キーが作成済みfield slugと一致し、それぞれの意味と値が送信内容どおりであることを確認する。
5. 管理画面の再取込み後も4型・ラベル・必須・補足説明が変わらず、同じremote fieldに対応していることを確認する。drift表示が変化なしになり、server defaultだけで差分通知が出ないことを確認する。
6. 合成row、4 field、scratch formを承認済みの通常手順で削除する。各fieldとformのGETが404、回答一覧に合成rowが残らないことまで確認する。途中失敗でも必ずここまで片付ける。

## PASS 記録

- [ ] deployment SHA / tenant / 実行者 / JST実行時刻を記録した。
- [ ] 4型の保存→個別GET read-back→hosted表示→1回submit→同じ1 row read-backがPASS。
- [ ] 再取込みとdrift無変化、row/field/form cleanup、削除後404がPASS。
- [ ] 本番3フォーム接触0、個人情報0、秘密値記録0、重複POST/row 0。

---

# builder-save-canvas-fix — host live checklist

## 変更概要（owner 日常語）

ビルダーの保存ボタンで追加パーツが保存されない不具合を直しました。

## 保存後の残存確認

1. 査読済み revision を approved host へ反映し、deployment SHA・tenant・実行者・JST 実行時刻を記録する。本番3フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` は開かず、削除可能で個人情報を含まない scratch form だけを使う。
2. 新規の空フォームをビルダーで開き、パレットから「数値」を canvas に追加する。追加直後に「保存」を押し、保存完了表示を待ってからページを再読込する。
3. 再読込後も「数値」が canvas に残り、保存リクエストの `fields` に追加 field が1件含まれていたことを network log で確認する。
4. 同じ scratch form に既存 field が残っている状態で「メール」を追加し、追加直後に「保存」→再読込する。既存 field と追加 field の両方が canvas に残り、保存リクエストの `fields` に両方が含まれることを確認する。
5. scratch form を通常の承認済み手順で削除し、再取得が404になることを確認する。失敗時も本番フォームや別テナントへ切り替えず、deployment SHA・操作順・network log の status と field 件数を記録して査読へ戻す。

## PASS 記録

- [ ] 新規フォーム: パーツ追加→保存→再読込後も追加 field が残る。
- [ ] 既存フォーム: 既存 field + パーツ追加→保存→再読込後も両方が残る。
- [ ] 両経路の PUT payload に画面上の最新 `fields` が含まれる。
- [ ] 本番3フォーム接触0、個人情報0、秘密値記録0、scratch form cleanup・削除後404がPASS。
# b4-matrix-pull-fix — host live checklist

## できるようになること

行列パーツが編集画面の再読み込みで消える不具合を直しました。

## 対象と安全条件

- sandbox から Formaloo への登録・更新・削除は行わない。査読済みの同一 revision を approved host へ反映してから実施する。
- 対象は、個人情報を含まず確実に削除できる新規 scratch form 1個だけにする。本番3フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- token、API key、cookie、生の form/field slug は画面・コマンド出力・証跡へ残さない。HTTP 200だけでPASSにせず、field の型、列見出し、行見出し、順序を照合する。
- 失敗時は追加の保存や作成を止め、既存 scratch form の remote/local 対応を確認してから cleanup する。

## matrix push → pull → 再読込 → 撤収

1. 管理画面で scratch form を1個作り、行2件・列2件の matrix field を追加して1回だけ保存する。
2. secret を除いた送信証跡で、matrix の write payload に `bulk_choices` が列見出しの文字列配列としてあり、`choice_items` が無いことを確認する。
3. Formaloo form detail GET の read-back で、matrix の `choice_items` が `[{slug,title,...}]` の配列で、`bulk_choices` が無いことを確認する。実値は記録せず、配列であること、2列の title と順序、`choice_groups` の2行だけを照合する。
4. 管理画面で同じ form を pull（再取込み）し、matrix field 自体が消えず、行2件・列2件と見出し順が保存前と一致することを確認する。
5. 編集画面を再読み込みし、同じ matrix が残ることを確認する。そのまま1回だけ再保存・再pullし、`bulk_choices` で再送され、再び matrix が残ることを確認する。
6. matrix field と scratch form を通常の承認済み手順で削除し、harness と Formaloo の両方で GET 404 を確認する。途中失敗でもこの撤収を完了する。

## PASS 記録

- [ ] deployment SHA / tenant / 実行者 / JST実行時刻を記録した。
- [ ] matrix の bulk-only push、実 GET の array-only read-back、pull、編集画面再読込、再保存、再pullで field と2×2順序が残った。
- [ ] scratch form を harness / Formaloo の両方から削除し、両方の GET 404 を確認した。
- [ ] sandbox 実射0、本番3フォーム接触0、個人情報0、秘密値記録0、重複作成0。

---

# matrix-jsonkey-null-fix — host live checklist

## できるようになること

行列が編集画面で消える不具合の残りの原因を直しました

## 対象と安全条件

- sandbox から Formaloo へ実射しない。査読済みの同一 revision を approved host へ反映してから確認する。
- 個人情報を含まず確実に削除できる新規 scratch form 1個だけを使う。本番3フォーム `Z5IEH85R` / `GMOxoMtK` / `XqACeA2v` には GET を含めて触れない。
- token、API key、cookie、生の form/field slug は画面・コマンド出力・証跡へ残さない。HTTP 200だけでPASSにせず、field の残存、行列の内容、再取込み後の状態まで照合する。
- 失敗時は追加の保存や作成を止め、scratch form の remote/local 対応を確認してから撤収する。

## scratch form push → pull → 残存 → 再取込み → 撤収

1. deployment SHA、tenant、実行者、JST実行時刻を記録し、scratch form に行2件・列2件の matrix field を追加して1回だけ保存する。
2. Formaloo form detail GET の read-back で、同じ matrix の `choice_items` が2列の配列、`bulk_choices` が不在、`choice_groups` が2行で各 `json_key` が `null` の複合実形であることを確認する。実値や slug は記録しない。
3. 同じ form を pull し、matrix field 自体と2列・2行・見出し順が残ることを確認する。
4. 編集画面で再取込み・再読込し、同じ matrix が残ることを確認する。1回だけ再保存して再pullし、matrix と2×2の順序が再び残ることを確認する。
5. scratch form を harness と Formaloo の両方から削除し、それぞれ GET 404 を確認する。途中失敗でもこの撤収を完了する。

## PASS 記録

- [ ] deployment SHA / tenant / 実行者 / JST実行時刻を記録した。
- [ ] 実 GET で `choice_items` 配列と `choice_groups[].json_key:null` が同時に存在することを確認した。
- [ ] pull、編集画面の再取込み・再読込、再保存・再pullの全段で matrix field と2×2の順序が残った。
- [ ] scratch form を harness / Formaloo の両方から削除し、両方の GET 404 を確認した。
- [ ] sandbox 実射0、本番3フォーム接触0、個人情報0、秘密値記録0、重複作成0。

---

# flex-builder-silent-fail-fix — host live checklist

## 変更概要（owner 日常語）

Flexのボタンが無反応だった不具合を直し、作り直しの案内が出るようになりました。

## 対象と安全条件

- 査読済み revision を approved host に反映し、削除可能なテスト用シナリオと下書き配信だけで確認する。実シナリオ・実配信データは変更せず、メッセージ送信もしない。
- 最初の本文を控え、確認前・キャンセル時に内容が変わっていないことを照合する。作り直し後の保存確認はテスト用データだけで行う。

## シナリオの実クリック手順

1. テスト用シナリオで、既存のテキスト本文が入ったステップを「編集」で開く。
2. 「メッセージタイプ」を「Flex」に切り替え、「ビジュアルでカードを作る」を押す。
3. 「今の本文はそのままではビジュアル編集できません」と、本文破棄を明記した確認、「新しく作り直す」「キャンセル」の2択が表示されることを確認する。
4. 「キャンセル」を押し、赤字ガイダンスと「上級者向け」の入力欄に元のテキストが残り、ビルダーは開かないことを確認する。
5. もう一度「ビジュアルでカードを作る」→「新しく作り直す」を押し、空の Flex ビジュアルビルダーが開くことを確認する。
6. テスト用カードを1枚作って保存し、本文が Flex JSON に置き換わることを確認する。テスト用シナリオは確認後に削除する。

## 配信側 parity

1. テスト用の下書き配信で、本文入りテキストを Flex に切り替え、同じ確認文・2択・キャンセル時の赤字ガイダンスが出ることを確認する。
2. 「新しく作り直す」で空のビルダーが開くことを確認し、配信は送信せず下書きを破棄する。

## PASS 記録

- [ ] シナリオ: 旧本文→Flex切替→ボタン→確認→キャンセルで本文保持・赤字案内が PASS。
- [ ] シナリオ: 明示作り直し→空ビルダー起動→テスト用保存が PASS。
- [ ] 配信: 同じ文言・選択肢・本文保持・作り直し導線が PASS。
- [ ] 実シナリオ変更0、実配信0、秘密値記録0、テスト用データ cleanup が PASS。
