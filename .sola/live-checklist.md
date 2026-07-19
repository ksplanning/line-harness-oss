# form-jp-reapply-impl — host live checklist

この lane は外部通信不可なので、ここに記載した live 実測は実行していない。land 後に infra-ops が **ks / piecemaker の各テナントで別々に**実行する。対象はその場で自作した使い捨てフォームだけとし、既存フォームは GET 以外禁止する。

## 変更概要と rollback

- `POST /api/forms-advanced/:id/reapply-hosted` は、D1 に保存済みの form slug / workspace / field map だけを使う。request body の slug / workspace は使わない。
- form meta は `color / star / copy / localization` の管理キーだけを 1 PATCH に束ねる。動画 field は remote URL と foreign config を GET して保持し、`config.height` だけを意図的に補完する。field 構造、logic、回答は変更しない。
- `localizationJa=true` は管理対象の UI chrome キーだけを日本語化し、`false` は管理キーだけを解除する。foreign `localized_content` は保持する。文字数カウントダウンと文字数 validation 文言は Formaloo hosted の制約で対象外。
- `FORMALOO_REAPPLY_DISABLE='1'` は再反映 endpoint 全体を DB lookup より前に 503 で短絡する。
- `FORMALOO_LOCALIZATION_DISABLE='1'` は localization の保存・GET/PATCH/confirm だけを短絡し、color/star/copy/video は継続する。

緊急停止はテナントごとに独立して設定する。値は非秘密だが、既存の secret 運用に合わせれば repo 変更なしで即時反映できる。

```bash
set +x
cd /root/.openclaw/line-harness-ks

# endpoint 全体だけを停止
for cfg in apps/worker/wrangler.ks.toml apps/worker/wrangler.piecemaker.toml; do
  printf '1' | pnpm exec wrangler secret put FORMALOO_REAPPLY_DISABLE --config "$cfg"
done

# 日本語化だけを停止（他の再反映は継続）
for cfg in apps/worker/wrangler.ks.toml apps/worker/wrangler.piecemaker.toml; do
  printf '1' | pnpm exec wrangler secret put FORMALOO_LOCALIZATION_DISABLE --config "$cfg"
done
```

復帰は該当 secret を削除して再 deploy する。まず片テナントで使い捨てフォームを再検証し、成功後にもう片方へ広げる。

```bash
set +x
cd /root/.openclaw/line-harness-ks
pnpm exec wrangler secret delete FORMALOO_REAPPLY_DISABLE --config apps/worker/wrangler.ks.toml
pnpm exec wrangler secret delete FORMALOO_LOCALIZATION_DISABLE --config apps/worker/wrangler.ks.toml
pnpm --filter worker exec vite build
pnpm --filter worker exec wrangler deploy --config apps/worker/wrangler.ks.toml
# piecemaker は ks の使い捨て実測 PASS 後に同じ 3 コマンドを wrangler.piecemaker.toml で実行する。
```

## 0. テナントごとの入力と安全ガード

このブロック以降は 1 テナントずつ新しい shell で実行する。credential 値を echo、`set -x`、ログ、証跡へ出さない。`TENANT_ENV_FILE` はそのテナントの `FORMALOO_API_KEY` / `FORMALOO_API_SECRET` を持つ host 上のファイルを指定する（例: `/root/.secrets/formaloo/api-credentials.env` または `/root/.secrets/formaloo.env`）。

```bash
set +x
umask 077

export TENANT_NAME='ks'                         # 2 回目は piecemaker
export HARNESS_BASE_URL='https://<worker-host>' # 末尾 slash なし
export TENANT_ENV_FILE='/root/.secrets/<tenant-formaloo-env>'
export HARNESS_API_KEY='<host secret store から shell env へ投入>'
# registry が複数ある場合だけ infra 台帳の値を指定。値はログへ出さない。
export LINE_ACCOUNT_ID=''
export WORKSPACE_ID=''

test "$TENANT_NAME" = 'ks' || test "$TENANT_NAME" = 'piecemaker'
test -n "$HARNESS_BASE_URL"
test -n "$HARNESS_API_KEY"
test -r "$TENANT_ENV_FILE"
set -a
source "$TENANT_ENV_FILE"
set +a
: "${FORMALOO_API_KEY:?missing FORMALOO_API_KEY}"
: "${FORMALOO_API_SECRET:?missing FORMALOO_API_SECRET}"

export FORMALOO_BASE='https://api.formaloo.net'
export BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
export DISPOSABLE_TITLE="infra-reapply-${TENANT_NAME}-$(date +%Y%m%d%H%M%S)"
export FORM_ID=''
export FORM_SLUG=''
export HOSTED_URL=''

# 絶対に mutation しない既存/本番 Formaloo ID。
readonly PROD_DENY_RE='^(GMOxoMtK|Z5IEH85R|puw7lh)$'
```

health と認証だけを先に確認する。応答 body に secret は残さない。

```bash
curl -fsS -A "$BROWSER_UA" "$HARNESS_BASE_URL/health" >/dev/null
curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced" >/dev/null
```

## 1. 使い捨てフォーム作成と初回保存

作成先 workspace は server 権威で決める。複数 registry のテナントだけ、infra 台帳の `LINE_ACCOUNT_ID` / `WORKSPACE_ID` を body に載せる。

```bash
CREATE_BODY=$(jq -nc \
  --arg title "$DISPOSABLE_TITLE" \
  --arg account "$LINE_ACCOUNT_ID" \
  --arg workspace "$WORKSPACE_ID" \
  '{title:$title}
   + (if $account == "" then {} else {lineAccountId:$account} end)
   + (if $workspace == "" then {} else {workspaceId:$workspace} end)')

CREATE_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced" \
  --data "$CREATE_BODY")
export FORM_ID=$(jq -er '.data.id' <<<"$CREATE_JSON")
test -n "$FORM_ID"
if [[ "$FORM_ID" =~ $PROD_DENY_RE ]]; then exit 90; fi
```

rating、video、multi-step、日本語 UI、dark-sumi、送信文言を一度保存する。動画 URL は使い捨てフォームの表示確認専用で、送信や回答は行わない。

```bash
RATING_ID="rating-$(date +%s)"
VIDEO_ID="video-$(date +%s)"
SAVE_BODY=$(jq -nc \
  --arg rating "$RATING_ID" \
  --arg video "$VIDEO_ID" \
  '{
    fields: [
      {id:$rating,type:"rating",label:"満足度",required:false,position:0,config:{}},
      {id:$video,type:"video",label:"案内動画",required:false,position:1,
       config:{videoUrl:"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}}
    ],
    logic: [],
    formType: "multi_step",
    design: {
      themeColor:"#06C755",backgroundColor:"#1A1917",buttonColor:"#06C755",
      textColor:"#F2EFE9",fieldColor:"#262523",borderColor:"#3A3835",
      submitTextColor:"#0A1F14",ratingStarColor:"#F5B301",presetId:"dark-sumi"
    },
    formCopy: {buttonText:"送信する",successMessage:"ご回答ありがとうございました"},
    localizationJa: true
  }')

SAVE_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -H 'Content-Type: application/json' \
  -X PUT "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID" \
  --data "$SAVE_BODY")
jq -e '.success == true and .data.syncStatus == "idle"' <<<"$SAVE_JSON" >/dev/null
export FORM_SLUG=$(jq -er '.data.formalooSlug' <<<"$SAVE_JSON")
test -n "$FORM_SLUG"
if [[ "$FORM_SLUG" =~ $PROD_DENY_RE ]]; then exit 91; fi

curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/submit-for-review" >/dev/null
curl -fsS -A "$BROWSER_UA" -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/publish" >/dev/null
```

## 2. disposable remote を旧状態へ戻し、reapply を実行

Formaloo token は shell 変数だけに置き、表示しない。

```bash
refresh_formaloo_token() {
  FORMALOO_JWT=$(curl -fsS -A "$BROWSER_UA" \
    -H "Authorization: Basic $FORMALOO_API_SECRET" \
    -H "x-api-key: $FORMALOO_API_KEY" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -X POST "$FORMALOO_BASE/v1.0/oauth2/authorization-token/" \
    --data 'grant_type=client_credentials' | jq -er '.authorization_token')
  export FORMALOO_JWT
}
refresh_formaloo_token

REMOTE_STALE=$(mktemp)
curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" >"$REMOTE_STALE"

VIDEO_SLUG=$(jq -er '.data.form.fields_list[] | select(.type == "oembed") | .slug' "$REMOTE_STALE" | head -1)
REMOTE_VIDEO_URL=$(jq -er --arg slug "$VIDEO_SLUG" \
  '.data.form.fields_list[] | select(.slug == $slug) | .url' "$REMOTE_STALE")
REMOTE_VIDEO_CONFIG=$(jq -c --arg slug "$VIDEO_SLUG" \
  '.data.form.fields_list[] | select(.slug == $slug) | (.config // {})' "$REMOTE_STALE")
test -n "$VIDEO_SLUG"

# stale video: remote URL/foreign config はそのまま、高さだけ 100px へ戻す。
STALE_VIDEO_BODY=$(jq -nc --arg url "$REMOTE_VIDEO_URL" --argjson config "$REMOTE_VIDEO_CONFIG" \
  '{url:$url,config:($config + {height:"100px"})}')
curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  -H 'Content-Type: application/json' \
  -X PATCH "$FORMALOO_BASE/v3.0/fields/$VIDEO_SLUG/" \
  --data "$STALE_VIDEO_BODY" >/dev/null

# stale form: legacy hex、英語、foreign CSS/localization sentinel を置く。すべて disposable slug 限定。
STALE_META_BODY=$(jq -nc '{
  background_color:"#1A1917",
  button_text:"Submit",
  custom_css:".infra-foreign{display:block}",
  localized_content:{infra_foreign:"keep"}
}')
curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  -H 'Content-Type: application/json' \
  -X PATCH "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" \
  --data "$STALE_META_BODY" >/dev/null

BEFORE_JSON=$(mktemp)
curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" >"$BEFORE_JSON"
jq -S '.data.form.logic' "$BEFORE_JSON" >"$BEFORE_JSON.logic"
jq -S '[.data.form.fields_list[] | del(.updated_at, .config.height)]' "$BEFORE_JSON" >"$BEFORE_JSON.fields"

REAPPLY_JSON=$(curl -fsS -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID/reapply-hosted")
jq -e '
  .success == true and .data.ok == true and
  ([.data.parts[] | .ok] | all) and
  .data.parts.color.skipped == false and
  .data.parts.star.skipped == false and
  .data.parts.copy.skipped == false and
  .data.parts.localization.skipped == false and
  .data.parts.videoHeight.skipped == false
' <<<"$REAPPLY_JSON" >/dev/null
```

## 3. API GET-after の非破壊・反映確認

```bash
AFTER_JSON=$(mktemp)
curl -fsS -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/" >"$AFTER_JSON"

# JSON-string RGBA、星 managed CSS、copy、日本語管理 key、foreign sentinel、250px を確認。
jq -e '(.data.form.background_color | fromjson) == {r:26,g:25,b:23,a:1}' "$AFTER_JSON" >/dev/null
jq -e '.data.form.custom_css | contains(".infra-foreign{display:block}") and contains("#F5B301")' "$AFTER_JSON" >/dev/null
jq -e '.data.form.button_text == "送信する"' "$AFTER_JSON" >/dev/null
jq -e '.data.form.localized_content.infra_foreign == "keep"' "$AFTER_JSON" >/dev/null
jq -e '.data.form.localized_content.next_btn == "次へ" and .data.form.localized_content.back_btn == "戻る"' "$AFTER_JSON" >/dev/null
jq -e --arg slug "$VIDEO_SLUG" --arg url "$REMOTE_VIDEO_URL" \
  '.data.form.fields_list[] | select(.slug == $slug) | .url == $url and .config.height == "250px"' \
  "$AFTER_JSON" >/dev/null

# video height と timestamp 以外の field 構造、logic は byte-equivalent canonical JSON。
jq -S '.data.form.logic' "$AFTER_JSON" >"$AFTER_JSON.logic"
jq -S '[.data.form.fields_list[] | del(.updated_at, .config.height)]' "$AFTER_JSON" >"$AFTER_JSON.fields"
cmp "$BEFORE_JSON.logic" "$AFTER_JSON.logic"
cmp "$BEFORE_JSON.fields" "$AFTER_JSON.fields"

export HOSTED_URL=$(jq -er '.data.form.full_form_address // .data.form.address' "$AFTER_JSON")
test -n "$HOSTED_URL"
```

## 4. hosted DOM / computed style（cache-bust + 9 秒）

raw CDP を使い、multi-step を回答送信せずに進めながら各画面で観測する。`送信する` ボタンはクリックしない。

```bash
CDP_DIR=$(mktemp -d)
CDP_LOG=$(mktemp)
/snap/bin/chromium --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir="$CDP_DIR" about:blank >"$CDP_LOG" 2>&1 &
CHROMIUM_PID=$!
export CDP_URL='http://127.0.0.1:9222'

node --input-type=module <<'NODE'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const version = await (await fetch(`${process.env.CDP_URL}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const created = await send('Target.createTarget', { url: 'about:blank' });
const targetId = created.result.targetId;
const attached = await send('Target.attachToTarget', { targetId, flatten: true });
const sessionId = attached.result.sessionId;
const command = (method, params = {}) => send(method, params, sessionId);
await command('Page.enable');
await command('Runtime.enable');
await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await command('Network.setUserAgentOverride', { userAgent: process.env.BROWSER_UA });
const separator = process.env.HOSTED_URL.includes('?') ? '&' : '?';
await command('Page.navigate', { url: `${process.env.HOSTED_URL}${separator}_cb=${Date.now()}` });
await sleep(9000);

const seen = { star: [], iframeHeights: [], backgrounds: [], buttons: [] };
for (let step = 0; step < 10; step += 1) {
  const evaluated = await command('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const star = [...document.querySelectorAll('[class*="nps-icon-star"],.react-rater-star')]
        .filter(visible).map((el) => { const s = getComputedStyle(el); return s.stroke || s.color || s.fill; });
      const iframeHeights = [...document.querySelectorAll('iframe')].filter(visible)
        .map((el) => Math.round(el.getBoundingClientRect().height));
      const full = document.querySelector('div.full-height,.full-height');
      const backgrounds = full ? [getComputedStyle(full).backgroundColor] : [];
      const buttons = [...document.querySelectorAll('button,input[type="submit"]')].filter(visible)
        .map((el) => (el.textContent || el.value || '').trim()).filter(Boolean);
      const advance = [...document.querySelectorAll('button')].filter(visible)
        .find((el) => /^(開始|次へ|続ける)$/.test((el.textContent || '').trim()) && !el.disabled);
      if (advance) advance.click();
      return { star, iframeHeights, backgrounds, buttons };
    })()`,
  });
  const snapshot = evaluated.result.result.value;
  for (const key of Object.keys(seen)) seen[key].push(...snapshot[key]);
  await sleep(900);
}

const normalized = (value) => String(value).replaceAll(' ', '').toLowerCase();
if (!seen.star.some((value) => normalized(value).includes('rgb(245,179,1)'))) throw new Error(`star color mismatch: ${JSON.stringify(seen.star)}`);
if (!seen.iframeHeights.includes(250)) throw new Error(`video height mismatch: ${JSON.stringify(seen.iframeHeights)}`);
if (!seen.backgrounds.some((value) => normalized(value) === 'rgb(26,25,23)')) throw new Error(`dark background mismatch: ${JSON.stringify(seen.backgrounds)}`);
if (!seen.buttons.includes('送信する')) throw new Error(`submit copy mismatch: ${JSON.stringify(seen.buttons)}`);
if (!seen.buttons.some((value) => ['開始', '次へ', '戻る', '前へ', '続ける'].includes(value))) throw new Error(`Japanese chrome missing: ${JSON.stringify(seen.buttons)}`);

await send('Target.closeTarget', { targetId });
ws.close();
console.log('PASS: star/video/dark/copy/localized chrome rendered');
NODE

kill "$CHROMIUM_PID"
wait "$CHROMIUM_PID" 2>/dev/null || true
```

## 5. 必須 cleanup — Formaloo と Harness の DELETE→404

途中で assert が失敗しても、このブロックは必ず実行する。denylist を再確認してから削除する。

```bash
set +x
test -n "$FORM_ID"
test -n "$FORM_SLUG"
if [[ "$FORM_ID" =~ $PROD_DENY_RE ]] || [[ "$FORM_SLUG" =~ $PROD_DENY_RE ]]; then exit 92; fi
refresh_formaloo_token

REMOTE_DELETE_CODE=$(curl -sS -o /tmp/formaloo-reapply-delete.json -w '%{http_code}' -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  -X DELETE "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/")
test "$REMOTE_DELETE_CODE" = '200' || test "$REMOTE_DELETE_CODE" = '204'
REMOTE_GET_CODE=$(curl -sS -o /tmp/formaloo-reapply-after-delete.json -w '%{http_code}' -A "$BROWSER_UA" \
  -H "x-api-key: $FORMALOO_API_KEY" -H "Authorization: JWT $FORMALOO_JWT" \
  "$FORMALOO_BASE/v3.0/forms/$FORM_SLUG/")
test "$REMOTE_GET_CODE" = '404'

HARNESS_DELETE_CODE=$(curl -sS -o /tmp/harness-reapply-delete.json -w '%{http_code}' -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -X DELETE "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID")
test "$HARNESS_DELETE_CODE" = '200'
HARNESS_GET_CODE=$(curl -sS -o /tmp/harness-reapply-after-delete.json -w '%{http_code}' -A "$BROWSER_UA" \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  "$HARNESS_BASE_URL/api/forms-advanced/$FORM_ID")
test "$HARNESS_GET_CODE" = '404'

unset FORMALOO_JWT FORMALOO_API_KEY FORMALOO_API_SECRET HARNESS_API_KEY
rm -f "$REMOTE_STALE" "$BEFORE_JSON" "$BEFORE_JSON.logic" "$BEFORE_JSON.fields" \
  "$AFTER_JSON" "$AFTER_JSON.logic" "$AFTER_JSON.fields" "$CDP_LOG" \
  /tmp/formaloo-reapply-delete.json /tmp/formaloo-reapply-after-delete.json \
  /tmp/harness-reapply-delete.json /tmp/harness-reapply-after-delete.json
rm -rf "$CDP_DIR"
```

## 6. 合否記録

テナントごとに次だけを記録し、token/key/secret/API 応答全体は貼らない。

- tenant 名
- disposable の Harness ID / Formaloo slug（cleanup 済みと併記）
- reapply response の 5 part が全て `ok:true`
- API GET-after: color JSON-string、foreign CSS/localization/config 保持、video 250px、logic/field 構造 cmp PASS
- hosted: star `rgb(245,179,1)`、iframe `250px`、背景 `rgb(26,25,23)`、`送信する`、日本語 chrome の 5 assert PASS
- Formaloo DELETE→GET 404 / Harness DELETE→GET 404
- 本番 ID `GMOxoMtK / Z5IEH85R / puw7lh` mutation 0

ks が全 PASS して cleanup 済みになってから、同じ手順を piecemaker の credential / worker URL で繰り返す。
