**ひとことで：おすすめは、LINE で本人確認できた人を「新しい回答フォーム」ではなく「前の回答を直す画面」へ案内する案Aです。重複はなくせますが、見た目はきれいな Formaloo フォームから素朴で編集項目も少ない画面へ変わります。**

# reentry-dedup-same-row — 同一 row 再入場編集の設計

- 作成日: 2026-07-19
- 種別: spike + 設計のみ。production code、deploy、本番 form は変更しない。
- 推奨: **案A（本人確認 proof を先に追加する条件付き）** — `/fo/:id` の再入場で、LINE ID token を server-side 検証して friend に束縛した短命 proof と本人に紐づく最新 row があれば、用途を署名した短命 token を発行して `/fe/:token` へ 302 する。現在の raw `?lu=` だけでは本番 ON にしない。
- rollout: 新規 env kill-switch は既定 OFF。OFF 時と初回回答時は既存 hosted/prefill 経路をそのまま使う。
- Sheets 結論: 実 Sheet の poll ではなく Formaloo 公式文書に基づく分類では、二方向同期は同じ `Formaloo Record ID` の行を in-place 更新し、DELETE は対応行を削除する。一方向同期は既存変更の `Resync data` が必要で、即時反映を保証しない。本番 ON 前の disposable Sheet 実測を rollout gate に残す。詳細は `spike-results.md`。

## 1. 目的と非交渉条件

owner の目的は、LINE から回答済みフォームへ戻って内容を直した時に、Formaloo と Google Sheets の両方で同じ人の回答が 1 件のままになることである。

非交渉条件は次のとおり。

1. 新規回答と既存回答の編集を明確に分け、既存 row がある再入場で新 submission を作らない。
2. 別 friend の row を見せたり書き換えたりしない。lookup は `form_id + friend_id` 完全一致を維持する。
3. 新機能が OFF の時は、今夜 owner 実機で成功した hosted prefill 経路を変えない。
4. env を OFF にした後は、新しい redirect だけでなく既発行 reentry token の GET/save も止まる。
5. メール用 token の「allow_edit_mail を OFF にすると失効する」既存契約を壊さない。
6. 本案件では本番 form、D1 schema、メール Phase B、deploy を触らない。

## 2. 現状のコードと実測事実

### `/fo/:id`

- 公開 form 解決: `apps/worker/src/routes/formaloo-public.ts:214-222`
- LINE/`lu`/`f` から friend 解決: 同 `:224-287`
- `form_opens` 記録: 同 `:289-296`
- 署名 `fr_id` と現行 prefill: 同 `:298-344`
- post-edit gate: `allow_post_edit===1 && FORM_POST_EDIT_ENABLED`, 同 `:309-312`
- bounded targeted pull: 同 `:313-328`
- 最新 row の hosted prefill: 同 `:329-344`
- 最新 row lookup: `packages/db/src/formaloo.ts:645-661`。`form_id + friend_id` 完全一致、時刻 DESC、1 件。

現状は answers を query parameter にして Formaloo hosted form をもう一度開くため、送信ボタンを押すと新 row になる。

### `/fe/:token`

- HMAC token: `apps/worker/src/services/formaloo-edit-token.ts:21-150`
- token は form、row、epoch、期限へ束縛される。既定 TTL はメール用途の 30 日。
- GET/save 共通 live gate: `apps/worker/src/routes/formaloo-public.ts:424-446`
- 編集 UI: 同 `:456-520`
- flat PATCH → FRESH GET → mirror 更新: 同 `:553-653`
- cache/referrer 防止: 同 `:373-378`

この器は同じ Formaloo row を更新できる。ただし現在の live gate は `allow_post_edit=1` **かつ** `allow_edit_mail=1` を要求する。LINE 再入場へ単純流用すると、メール toggle が OFF の form は `/fe` で 403 になる。逆に gate を単純 OR にすると、メール toggle を OFF にした旧メール token が reentry flag 経由で復活する。この衝突は token の用途分離で解く。

### Sheets spike

今回の sandbox では Formaloo OAuth request が `fetch failed` となり、Google editor credential/Sheet URL も無かったため完全 live poll はできなかった。D-1 の許容する docs fallback を使った。

- 既存 live evidence では、同じ row slug の flat PATCH 後に FRESH GET `data.row.data` が編集後値となる。
- Formaloo 公式の二方向同期仕様では、既存 submission の変更は対応する既存 Sheet 行へ自動反映され、submission DELETE は対応行を自動削除する。
- Sheet は `Formaloo Record ID` を system column として row 対応に使う。
- 標準一方向同期は、新規 submission の自動追記と、既存変更の手動 re-sync を区別する。re-sync 後も行数が 1 のままかは `Formaloo Record ID` の仕様からの推論であり、実 Sheet では未確認である。

よって案Aは Formaloo の重複を確実に作らない。公式文書ベースでは Sheet は二方向なら即時 in-place、一方向なら re-sync まで遅延して既存変更を送ると分類するが、一方向の行数不変は rollout 時の実測対象に残す。案Bの DELETE を採る場合、一方向同期では古い Sheet 行が残る可能性を消せない。

## 3. 案 A / B / C の比較

工数は実装、TDD、review までの概算で、owner 立会や Formaloo/Google の待ち時間を含めない。

| 観点 | 案A: `/fo` 再入場を `/fe` へ | 案B: 新 row 後に旧 row を整理 | 案C: 現状維持 + 最新だけ表示 |
|---|---|---|---|
| Formaloo の重複 | **作らない。** 同じ row slug を PATCH | 一度は必ず作る。旧 row DELETE/supersede 成功後だけ最終 1 件 | 残る。管理画面で隠すだけ |
| Sheets | 二方向は同じ Record ID 行を更新。一方向は re-sync まで旧値 | 新 row は新行追加。二方向でも旧行削除まで一時 2 行。一方向は旧行が残る恐れ | 追記ログとして複数行を保持 |
| 回答者 UX | **素朴な `/fe`。** text/textarea/number/email/phone/date のみ編集。choice/file/rating/signature 等は read-only | きれいな hosted form、全対応 field/logic を維持 | きれいな hosted form、全対応 field/logic を維持 |
| デザイン | Formaloo の theme/背景/分岐 UI ではなく worker の白い編集カード | 現行 hosted と同じ | 現行 hosted と同じ |
| PII/誤帰属 | LINE ID token を server verify → form-bound 短命 proof → form+friend 完全一致 → row-bound HMAC。proof/edit URL 共有は残余リスク | webhook/delete race で別 row を消す危険。supersede key の誤りは PII/履歴破壊へ直結 | 誤削除は無いが、古い PII row が長く残り、一覧の hide と実データが乖離 |
| 障害時 | eligible row で mint 不能なら 503 に倒し、新 row を作らせない。flag OFF で旧経路へ即 rollback | 新 row 成功・旧 row 整理失敗で重複が固定。再試行/冪等 job が必要 | 障害は少ないが owner の重複問題を解決しない |
| 並行操作 | optimistic version と FRESH GET が既存 | 同時再送信、webhook 順序、delete 順序の競合を新設 | 最新表示の tie-break だけで、元データ重複は増える |
| 実装範囲 | token用途 + `/fe` gate + `/fo` 分岐。DB migration 無し | webhook、supersede/delete、再試行、監査、Sheet整合。schema が必要になり得る | 管理画面 query/filter と説明。Sheets は変更無し |
| 概算 | 1.5〜2.5 人日 | 4〜7 人日 + 運用監視 | 0.5〜1.5 人日 |
| 目的達成 | **達成**。UI 制限を受け入れる | 最終的には可能だが transient/persistent 重複リスクが高い | **未達**。見えなくするだけ |

### 案Bで DELETE を使う場合の注意

公式二方向同期では Formaloo DELETE が対応 Sheet 行も削除するため、理論上は「新行追加 → 旧行削除」で最終 1 行になる。しかし次の窓が残る。

1. 新 row は respondent に成功表示済みだが、webhook がまだ来ない。
2. webhook は来たが旧 row 判定に失敗する。
3. Formaloo DELETE は成功したが Sheet 反映待ちで一時 2 行になる。
4. 標準一方向同期では旧行削除の自動反映が公式資料から確定できない。
5. 同時に 2 回再送信すると、どれを旧 row とするか競合する。

このため案Bは、hosted の見た目を守れる代わりに、owner が最も避けたい重複を一度作ってから後処理に賭ける設計になる。

### 案Cの位置づけ

案Cは監査ログを残す用途には分かりやすいが、「重複ゼロ」ではない。管理画面の最新表示と Formaloo/Sheets の実体が違うため、CSV、外部集計、Sheets 直閲覧では重複が再び見える。今回の目的に対する fallback にはできるが、推奨にはしない。

## 4. 推奨案 A の確定設計

### 4.1 正常フロー

1. 初回 `/fo/:id`: 本人 row が無いので、現在どおり Formaloo hosted form へ 302。ここだけが新 submission を作る入口。
2. LINE/LIFF から再入場: LIFF client が LINE ID token を既存 `/api/liff/link` で server-side 検証させる。同 route が検証済み `sub` から解決した friend id と form id を HMAC した 2 分の reentry proof を受け取る。
3. `/fo` は proof の署名・期限・form 束縛を検証し、その中の friend id を D1 で再存在確認する。query の raw `lu` は編集権限の根拠にしない。
4. 既存 gate と targeted pull を通し、`getFriendLatestSubmission(formId, friendId)` で最新 row を 1 件取得する。
5. 新 flag ON、proof 検証済み、最新 row 有りなら、`audience=reentry`、TTL 1 時間、form/row/epoch を署名した token を発行する。
6. worker canonical origin の `/fe/:token` へ 302 する。Formaloo hosted form は開かない。
7. `/fe` は既存 UI を描画し、保存時に同じ row slug を flat PATCH、FRESH GET で確認してから mirror を更新する。
8. Sheets は公式仕様上、二方向なら同じ Record ID 行を更新。一方向なら次回 re-sync で既存変更を送る。本番 ON 前に行数不変を実 Sheet で確認する。

### 4.2 LIFF reentry proof（本番 ON の前提）

既存 `apps/worker/src/client/main.ts:221-273` は ID token を `/api/liff/link` へ POST して LINE 側で検証した後、raw `lu` を `/fo` の query へ載せている。raw query は誰でも組み立てられるため、読み取り prefill より強い「同じ row を書き換える権限」には使わない。

最小の追加契約は次のとおり。

1. LIFF client は検証済み redirect が `/fo/:formId` の時だけ、`returnFormId` を既存 `/api/liff/link` body に加える。
2. `/api/liff/link` は既存どおり LINE verify が成功した `sub` から friend を完全一致で解決した後、`purpose=form-reentry-proof`、friend id、form id、発行時刻、2 分の期限を HMAC する。key は `FORMALOO_EDIT_TOKEN_SECRET` を domain separator 付きで使い、row edit token と署名文脈を分離する。
3. proof は新 flag ON かつ secret 有りの時だけ返す。client は proof を `rp` query として `/fo` に付ける。ID token 自体は URL に載せない。
4. `/fo` は reentry gate（`allow_post_edit=1`、既存 env ON、新 flag ON）が有効で `lu` が来た時、valid `rp` が無い・期限切れ・form 不一致なら 403、secret 不在なら 503。hosted form へ fallthrough しない。gate OFF の form は既存挙動を保つ。
5. valid proof の friend id を唯一の reentry identity として DB で再存在確認する。raw `lu` / raw `f` から reentry edit token は発行しない。
6. proof を含む `/api/liff/link` response と `/fo` redirect response に `Referrer-Policy: no-referrer` と `Cache-Control: no-store` を付け、proof の二次漏出を抑える。proof は bearer であり、2 分以内の共有・ログ露出という残余リスクは残る。

proof 発行を既存 `/api/liff/link` の LINE verify 成功分岐へ置くことで、ID token を URL へ出さず、追加の LINE API round-trip も作らない。client が古い、link が失敗、proof が失効した場合は「再度 LINE から開いてください」と止める。これは可用性より別人 row の閲覧・更新防止を優先する fail-closed である。

### 4.3 edit token 用途を署名対象にする

`EditTokenPayload` に `audience: 'mail' | 'reentry'` を additive 追加し、short key `a` を HMAC 対象 JSON に含める。

- 新規 mail token: `a='mail'`
- 新規 reentry token: `a='reentry'`
- 既存 token: `a` 欠落を `mail` と解釈し、既存互換を維持する。
- 不明な `a`: fail-closed で verify `null`。
- mail: `allow_post_edit=1 && allow_edit_mail=1`。既存どおり。
- reentry: `allow_post_edit=1 && FORM_POST_EDIT_ENABLED && FORM_REENTRY_SAME_ROW_EDIT_ENABLED`。
- epoch、form、row、exp の照合は両用途で共通。
- reentry TTL: 1 時間。`/fo` を開くたび再発行できるため、メール用 30 日を流用しない。

新 flag は `/fo` の発行条件だけでなく、`/fe` GET と save の live gate でも照合する。これにより env を OFF にした瞬間、既発行 reentry URL も使えなくなる。

### 4.4 既存 prefill 経路を壊さない fallthrough

次は現在の hosted/prefill 経路へそのまま進む。

- `FORM_REENTRY_SAME_ROW_EDIT_ENABLED` が未設定/OFF。
- `allow_post_edit=0` または `FORM_POST_EDIT_ENABLED` OFF。
- friend 未解決（新 flag OFF の legacy 経路）。
- 最新 row が無い初回回答。
- raw `?f=` だけで friend を指定した経路。

raw `?f=` は本人性が弱いため編集権限を増やさない。その代わり、この legacy 経路では flag ON 後も hosted form の再送信による重複が残る。今回の「重複ゼロ」は通常の LINE/LIFF 復路を対象とし、raw `?f=` まで対象に広げるには別の信頼できる本人確認が必要である。

reentry gate（form toggle + 既存 env + 新 flag）が全て ON で raw `lu` に valid proof が無ければ、friend lookup より前に 403/503 で止める。proof 検証後に friend token secret 不在・friend 署名失敗が起きた場合も 503 を返す。初回回答の `fr_id` 帰属も失われる構成なので、hosted form へ通して将来の未帰属 row を作らない。latest row 有りまで到達した後の edit token secret 不在・署名失敗も、hosted prefill へ戻さず 503 を返す。ここで fallback すると「新規 row を作らない」という gate ON 時の契約を静かに破るためである。gate を OFF に戻せば、運用者が明示的に旧経路へ rollback できる。

### 4.5 本人性と PII の正直な境界

現行 `/fo` は `?lu=` / `?f=` を DB に存在する friend へ解決するが、LINE ID token の暗号学的検証ではない。後段の `signFriendToken` は row attribution を守り、現在アクセスしている人が本人であることまでは証明しない。

案Aは編集権限を増やすため、次の縮小策を必須とする。

1. reentry token は LINE ID token の server verify 後に解決した friend id を署名した form-bound proof が有効な場合だけ発行する。raw `?lu=` / `?f=` 共有 URL では発行しない。
2. token は 1 row、1 form、epoch、1 時間、`reentry` audience に束縛する。
3. 別 friend、ghost friend、別 form、改ざん、期限切れ、unknown audience はすべて拒否する。
4. token は bearer capability なので、共有された有効 URL は期限内に使える残余リスクを owner へ明示する。
5. `/fe` は choice/file 等の値も read-only 表示するため、現行 scalar prefill より見える PII が増え得る。pilot は限定 form から始める。

LINE ID token verify は「その LINE identity を今の caller が持つ」ことを確認するが、proof と edit token は期限内に共有可能な bearer capability である。また、LINE account の共有端末・乗っ取りまでは防げない。この残余リスクをゼロとは呼ばない。

### 4.6 Sheets rollout gate

source を dark-ship した直後は新 flag を OFF のままにする。ON の前に、対象 connection について次のどちらかを満たす。

1. Formaloo Active integrations で二方向 sync が ON と owner/infra が確認する。
2. editor-owned disposable Sheet で `row_count=1 + Record ID 不変 + before→after + DELETE後0行` を 120 秒上限で実測する。

一方向 sync のままでも Formaloo 重複は防げるが、Sheet の値は re-sync まで古い可能性がある。この遅延を許容できない対象では flag を ON にしない。

## 5. 推奨案 A の実装 tasks 雛形

以下は次の generator が Opus/Codex のどちらでも単独実行できる粒度であり、本設計案件では実行しない。本人確認 proof を含む 14 ファイルの変更になるため、元 brief の `task_size: small` ではなく実装時は `Task-Size: large` とする。

### 5.1 精密スコープ

target_files:

- `apps/worker/src/services/formaloo-reentry-proof.test.ts`（new）— purpose/form/friend/期限/HMAC の RED。
- `apps/worker/src/services/formaloo-reentry-proof.ts`（new）— domain-separated 2 分 proof の純関数。
- `apps/worker/src/routes/liff-reentry-proof.test.ts`（new）— LINE verify 済み friend だけへ proof を返す route RED。
- `apps/worker/src/routes/liff.ts:1135-1181,1238-1241,1307-1310` — 既存 `/api/liff/link` response への flag-gated proof 追加。
- `apps/worker/src/lib/liff-return-url.test.ts:11-139` — same-worker `/fo` だけに proof を付ける RED。
- `apps/worker/src/lib/liff-return-url.ts:10-50` — strict return URL helper の additive proof 引数。
- `apps/worker/src/client/main.wire.test.ts:22-38` — ID token を URL に出さず proof response を使う wire RED。
- `apps/worker/src/client/main.ts:214-274` — `returnFormId` 送信、proof 待機、`/fo` 復路への付与。
- `apps/worker/src/services/formaloo-edit-token.test.ts:21-107` — audience、旧 token 互換、reentry TTL の RED。
- `apps/worker/src/services/formaloo-edit-token.ts:21-49,95-150` — signed payload の additive audience。
- `apps/worker/src/routes/formaloo-public-edit.test.ts:225-259` — mail/reentry 別 live gate と kill-switch の RED。
- `apps/worker/src/routes/formaloo-public.test.ts:396-797` — `/fo` の proof、latest-row redirect、fallthrough、PII 負経路の RED。
- `apps/worker/src/routes/formaloo-public.ts:224-344,424-446` — proof verification、targeted pull 後の additive 302、purpose-aware `/fe` gate。
- `apps/worker/src/index.ts:196-212` — `FORM_REENTRY_SAME_ROW_EDIT_ENABLED?: string` の env 契約。

existing_helpers:

- `getFriendLatestSubmission`: `packages/db/src/formaloo.ts:645-661`。再実装しない。
- `signEditToken` / `verifyEditToken`: `apps/worker/src/services/formaloo-edit-token.ts:95-150`。
- LINE verify + friend 解決: `apps/worker/src/routes/liff.ts:1135-1181`。別の本人確認実装を作らない。
- strict same-worker return guard: `apps/worker/src/lib/liff-return-url.ts:10-50`。origin/path 判定を緩めない。
- `isPostEditEnabled`: `apps/worker/src/services/formaloo-row-edit.ts:32-35`。新 flag の真偽にも再利用する。
- `pullFriendReconcileInputs`: 同 `:310-341`。bounded targeted pull を二重実装しない。
- `/fe` flat PATCH + FRESH GET: `apps/worker/src/routes/formaloo-public.ts:609-623`。保存処理を新設しない。

read_only_anchors:

- `packages/db/src/formaloo.ts:645-661` — friend 完全一致 query は変更しない。
- `apps/worker/src/services/formaloo-row-edit.ts:273-341` — fr_id verify fail-closed と bounded pull は変更しない。
- `apps/worker/src/routes/formaloo-public.ts:609-653` — PATCH/persist/mirror の既存順序は変更しない。
- `apps/worker/src/middleware/auth.ts:136-178` — public route auth boundary は変更しない。

out_of_scope:

- `GMOxoMtK`, `puw7lh`, `Z5IEH85R` への設定変更、送信、DELETE。
- 案B/C、row supersede schema、cleanup cron、管理画面 latest filter。
- `/fe` の theme 化、choice/file/rating/signature 編集対応。
- LINE ID token の新しい検証方式・認証 provider・session schema。既存 `/api/liff/link` の検証成功結果だけを再利用する。
- 弾L Phase B メール送付、deploy、既存 row backfill。

### I-0 — 検証済み LIFF 復路 proof（TDD + atomic commit）

RED first:

1. 新規 `formaloo-reentry-proof.test.ts` に round-trip、purpose/form/friend/期限束縛、別鍵、改ざん、`now===exp`、空 secret を先に書く。
2. 新規 `liff-reentry-proof.test.ts` に、valid LINE ID token → friend 完全一致 → `returnFormId` 有り → flag/secret ON の時だけ proof が response に入ることを先に書く。proof 有り response は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須 assert する。invalid ID token、friend 不在、flag OFF、secret 無し、`returnFormId` 無しは proof 0。既存 `userId/alreadyLinked` response は同値を pin する。
3. `liff-return-url.test.ts` に same-worker `/fo/:id` だけが `rp` を受け取り、`/t`、別 origin、form id 不一致、空 proof は受け取らない RED を追加する。
4. `client/main.wire.test.ts` に ID token 文字列を return URL へ渡さない、strict `/fo/:id` からだけ `returnFormId` を link body へ渡す、link response の proof を待って helper へ渡す invariant を追加する。
5. 次を実行し、missing export / response mismatch / query mismatch による RED を観察する。syntax/import error は RED 証拠にしない。

```bash
pnpm --filter worker exec vitest run src/services/formaloo-reentry-proof.test.ts src/routes/liff-reentry-proof.test.ts src/lib/liff-return-url.test.ts src/client/main.wire.test.ts
```

GREEN:

6. proof payload を `{purpose:'form-reentry-proof', formId, friendId, iat, exp}` とし、`formaloo-reentry-proof.v1` domain separator を HMAC message に含める。TTL は 120 秒、unknown purpose と欠落 field は fail-closed。
7. `/api/liff/link` の既存 LINE verify と `getFriendByLineUserId` 成功後だけ proof を作り、already-linked/new-linked の両 response に同じ helper で加える。proof 有り response に no-store/no-referrer header を付ける。flag OFF 時は response property 自体を足さず byte 互換。
8. LIFF client は safe redirect が canonical worker の `/fo/:id` と確定した時だけ form id を送る。proof を得られなければ ID token を代用品として URL に出さない。
9. proof 付き redirect は link request の完了を待つ。bounded timeout で proof 無しになった時は raw `lu` 復路へ進み、flag ON の `/fo` が fail-closed で止める。
10. 同じ test command を Green にする。

機械検証可能 done:

- own valid ID token からは own friend bound proof だけができ、別 friend/form へ書き換えると verify null。
- raw ID token、LINE access token、credential 値は URL・log・response に出ない。
- flag OFF の `/api/liff/link` JSON と従来 `/fo` return URL は既存 fixture と一致。
- proof は same-worker `/fo/:id` 以外へ運ばれず、120 秒で失効する。
- proof 有り `/api/liff/link` response は no-store/no-referrer、flag OFF fixture は従来 response を維持する。

commit:

```text
feat(liff): sign verified form reentry proof

Generator-LLM: codex
Task-Size: large
```

明示 stage:

```bash
git add apps/worker/src/services/formaloo-reentry-proof.test.ts apps/worker/src/services/formaloo-reentry-proof.ts apps/worker/src/routes/liff-reentry-proof.test.ts apps/worker/src/routes/liff.ts apps/worker/src/lib/liff-return-url.test.ts apps/worker/src/lib/liff-return-url.ts apps/worker/src/client/main.wire.test.ts apps/worker/src/client/main.ts
```

### I-1 — token audience と短命 reentry token（TDD + atomic commit）

RED first:

1. `formaloo-edit-token.test.ts` に `mail`/`reentry` round-trip、audience 改ざん拒否、unknown audience 拒否、`a` 欠落旧 token=`mail`、1 時間 expiry 境界を先に追加する。
2. `pnpm --filter worker exec vitest run src/services/formaloo-edit-token.test.ts` を実行し、`audience` 不在の assertion mismatch で RED を観察する。syntax/import error は RED 証拠にしない。

GREEN:

3. payload short key `a` を追加し、verify return に `audience` を含める。旧 payload のみ `mail` fallback、不明値は null。
4. mail の 30 日既定は変えず、reentry 1 時間の定数/expiry helper を追加する。
5. 同じ test command を全 Green にする。

機械検証可能 done:

- mail/reentry は同じ secret でも audience 改ざんで verify null。
- 旧 fixture token は `audience=mail` で通る。
- `now===exp` は reentry も拒否。
- `FORMALOO_EDIT_TOKEN_SECRET` 空は両用途を発行しない。

commit:

```text
feat(formaloo-edit-token): bind tokens to edit audience

Generator-LLM: codex
Task-Size: large
```

明示 stage:

```bash
git add apps/worker/src/services/formaloo-edit-token.test.ts apps/worker/src/services/formaloo-edit-token.ts
```

### I-2 — `/fe` の用途別 live gate（TDD + atomic commit）

RED first:

1. `formaloo-public-edit.test.ts` に次を先に書く。
   - 旧/mail token は `allow_edit_mail=0` で GET/save とも 403。
   - reentry token は `allow_edit_mail=0` でも post-edit + 新 flag ON なら GET/save が通る。
   - reentry token は新 flag、`FORM_POST_EDIT_ENABLED`、`allow_post_edit` のどれか OFF で GET/save とも 403。
   - mail token は新 flag OFF でも従来条件なら通る。
   - audience を変えた token、別 form/row、epoch mismatch は拒否。
2. `pnpm --filter worker exec vitest run src/routes/formaloo-public-edit.test.ts` で既存 AND gate との差を RED 観察する。

GREEN:

3. `resolveEditContext` を audience 別の明示分岐にし、共通の form/row/epoch 検証順序は維持する。
4. reentry だけ `FORM_REENTRY_SAME_ROW_EDIT_ENABLED` と `FORM_POST_EDIT_ENABLED` を live check する。
5. 同じ test command を Green にする。

機械検証可能 done:

- env OFF 後、既発行 reentry token の GET/save は両方 403。
- mail toggle OFF 後、旧 token が reentry flag 経由で復活しない。
- `/fe` の PATCH/FRESH-GET/mirror 順序に diff が無い。

commit:

```text
feat(formaloo-public): gate edit links by signed audience

Generator-LLM: codex
Task-Size: large
```

明示 stage:

```bash
git add apps/worker/src/routes/formaloo-public-edit.test.ts apps/worker/src/routes/formaloo-public.ts
```

### I-3 — `/fo` latest row を `/fe` へ additive redirect（TDD + atomic commit）

RED first:

1. `formaloo-public.test.ts` の既存 post-edit cluster に次を先に追加する。
   - flag ON + valid proof A + A の latest row 有り → 302 `/fe/<token>`、token payload は form A / row A / epoch / reentry / 1h。
   - B friend の row は A に発行されない。
   - reentry gate ON の raw `?lu=U_A` は proof 無し/改ざん/期限切れ/form 不一致なら 403、secret 無しなら 503。friend lookup と hosted redirect は発生しない。
   - valid proof で返す `/fo` の hosted または `/fe` 302 は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を持つ。
   - raw `?f=frA` は flag ON でも `/fe` token を発行せず、既存 hosted prefill のまま。
   - valid proof + row 無しは初回 hosted path。friend 無しは拒否。allow_post_edit OFF、既存 env OFF、新 flag OFF は既存 hosted path。
   - valid proof の feature candidate で friend-token secret 無しは 503。raw `?f=` は既存 302 のまま。
   - eligible row 有りだが edit-token secret 無しは 503、hosted address へは redirect しない。
   - targeted pull が増やした latest row を発行対象にする。
2. `pnpm --filter worker exec vitest run src/routes/formaloo-public.test.ts` を実行し、location が hosted のままという期待差で RED を観察する。

GREEN:

3. `/fo` 冒頭で reentry gate ON + `lu` の時は `rp` を friend lookup より先に検証する。valid proof の friend id を `getFriendById` で再確認し、raw `lu/f` を reentry identity にしない。gate OFF は現在の lookup を変えない。
4. new flag + 既存 gate + valid proof を feature candidate とし、この時だけ friend secret/署名失敗を 503 にする。flag OFF と raw `f` の既存 fail-soft は変えない。
5. 既存 targeted pull の直後、既存 prefill を組み立てる前に latest row を 1 回取得する。
6. latest row があれば token を発行し、canonical worker origin の `/fe/:token` へ 302。eligible 後の mint failure は 503。proof を受けた `/fo` response は hosted/`/fe` のどちらも no-store/no-referrer を付ける。
7. 条件外は既存 `buildFriendPrefillParams` と hosted redirect へ fallthrough する。
8. `index.ts:196-212` 近傍へ env 型と default-OFF/rollback コメントを追加する。
9. 同じ test command を Green にする。

機械検証可能 done:

- new flag OFF fixture の status/location/query は変更前 snapshot と一致。
- 初回回答は hosted form、2 回目は `/fe` で、2 回目に Formaloo row POST は発生しない。
- `/fe` token は別 friend/別 form の rowRef を含まない。
- raw `?f=` と ghost `lu` は edit capability を受け取らない。
- forged/expired/wrong-form proof は friend lookup 前に拒否され、hosted form を開かない。
- valid proof を受けた `/fo` 302 は行の有無に関係なく no-store/no-referrer。
- LINE feature candidate の friend secret 不整合と、eligible row の edit secret 不整合を hosted fallback で隠さない。

commit:

```text
feat(formaloo-public): edit latest row on LINE reentry

Generator-LLM: codex
Task-Size: large
```

明示 stage:

```bash
git add apps/worker/src/routes/formaloo-public.test.ts apps/worker/src/routes/formaloo-public.ts apps/worker/src/index.ts
```

### I-4 — 回帰・build・差分ゲート

実行:

```bash
pnpm --filter worker exec vitest run src/services/formaloo-reentry-proof.test.ts src/routes/liff-reentry-proof.test.ts src/lib/liff-return-url.test.ts src/client/main.wire.test.ts src/services/formaloo-edit-token.test.ts src/routes/formaloo-public-edit.test.ts src/routes/formaloo-public.test.ts src/routes/formaloo-public.fr-id-characterization.test.ts
pnpm --filter worker test
pnpm --filter worker typecheck
git diff --check
```

機械検証可能 done:

- 対象 test と worker full suite が全 PASS、typecheck exit 0。
- `formaloo-public.fr-id-characterization.test.ts:85-135` が全 Green。
- DB migration、`formaloo-row-edit.ts`、middleware、web UI に diff 0。
- `git diff -- apps/worker/src/routes/formaloo-public.ts` で変更が proof verification、targeted pull 後 branch、purpose gate に限定される。
- secret scan で token/credential 値 0 件。

### I-5 — dark rollout と rollback 証跡（closer/infra 工程）

1. source deploy 時は `FORM_REENTRY_SAME_ROW_EDIT_ENABLED` 未設定/OFF。
2. OFF 状態で既存 `/fo` hosted prefill の location を確認する。
3. Sheets rollout gate を満たした pilot form だけで env を ON にする。
4. synthetic/owner-approved friend で初回 hosted → 再入場 `/fe` → save → Formaloo row slug 不変を確認する。
5. Sheet は Record ID 不変、row count 不変、値だけ更新を確認する。one-way の場合は re-sync を実行して確認する。
6. rollback は env OFF。既発行 reentry token GET/save 403 と `/fo` hosted path 復帰を確認する。

機械検証可能 done:

- OFF/ON/OFF の各時点で `/fo` location と reentry token status を記録。
- ON 時の Formaloo `rowSlug_before === rowSlug_after`、rows count 不変。
- Sheet `recordId_before === recordId_after`、row count 不変、value after 一致。
- 本番 3 slug への mutation/送信は owner が pilot を別途明示しない限り 0。

## 6. 自己欠陥検知（6 観点）

1. 前提の穴: live Sheet は未実測。docs fallback と rollout gate を分離し、即時同期を全 mode に誤拡張しない。
2. 依存の漏れ: LIFF ID-token verify、proof carry、`/fo`、`/fe` live gate、token payload、env 型、latest DAO、Sheets mode を列挙した。
3. 影響範囲: mail token revocation、raw `?lu/f`、LIFF loop guard、targeted pull、PATCH persist を回帰対象にした。
4. done の動詞化: 各 I-task は RED/Green command と status/location/row count の assert を持つ。
5. 矛盾: 「既存 prefill を壊さない」と「flag ON eligible で duplicate を作らない」を fallthrough/503 の境界で分離した。
6. スコープ逸脱: 新 auth provider/session schema、choice edit、Phase B、案B/C、deploy は実装対象外に固定した。

独立調査で見つかった `allow_edit_mail` gate 衝突、raw `lu/f` の本人性不足、既存 ID-token verify の安全な再利用、token audience、短 TTL、kill-switch の GET/save 適用、`/fe` の field 制限をすべて本設計へ fold-in した。

## 7. owner 向け日常語まとめ

おすすめは案Aです。

- 最初の回答だけ、今までどおり見た目のきれいな Formaloo フォームを使います。
- その前に、LINE が確認した本人だけを編集画面へ通す短い「通行証」を追加します。今の URL に入る `lu` だけでは書き換えを許しません。
- 2 回目からは、同じ回答を直す専用画面を開くので、Formaloo に 2 件目を作りません。
- Google Sheets は公式仕様上、二方向同期なら同じ行の中身だけが変わります。ただし今回は実 Sheet を接続できていないため、ON 前に使い捨て Sheet で行数が増えないことを確認します。一方向同期では再同期まで古い値が残ります。
- 正直な弱点は、編集画面が今のフォームより素朴で、選択式・ファイル・星評価・署名などはその画面から変更できないことです。
- 緊急時は新しい設定を OFF にすれば、今の動きへ戻せます。

この trade-off なら、「見た目の統一」より owner が困っている「同じ人の回答が何件も増える」を優先して、既存部品を小さく接続できます。
