# route-terminal と fr_id/prefill を両立させるための設計

- 作成日: 2026-07-19
- 案件: `route-terminal-prefill-coexist`
- 種別: 設計のみ（この案件ではコード変更・デプロイ・本番フォーム変更をしない）
- 結論: **案 C（使い捨てフォームで logic 形状を先に実測）を推奨する。ただし PASS する形が見つかるまでは案 A を継続し、共存できるとは宣言しない。**

## 1. 冒頭: 実測で確定した制約

監督ブリーフの制約を、その後の訂正証跡まで含めて要約すると次のとおりである。

> 「Formaloo は form の logic（route-terminal の `generateSubmitWhen` 由来 submit rule 等）が有効なフォームでは、submit intake で hidden field の値を捨てる」

引用元: `/root/.openclaw/line-harness-ks/.plans/2026-07-19-route-terminal-prefill-coexist/tasks.md`。

この文で確定している範囲は、**現在の route-terminal と同じ** `is_answered(host) -> submit` 形である。決定的な因果鎖は次の 4 点。

1. logic の無い使い捨てフォームでは、`type=hidden`・`alias=fr_id` の値が URL から row まで byte 同一で保存され、フォーム自体は終了時に DELETE→GET 404 まで確認済み（`/root/.openclaw/line-harness-ks/.plans/2026-07-18-fr-id-capture-fix/spike-results.md:3-5,17-27`、後続の詳細証跡 `/root/.openclaw/line-harness-ks/.ars-state/fr-id-field-fix-20260718.md:28-35`）。
2. 同じ使い捨てフォームへ本番と同型の route-terminal logic を載せると、hidden の位置を先頭へ動かしても値が NULL になった。ブラウザの POST payload には署名値が載っている一方、submit response の `row.data` からは消えており、クライアントではなく Formaloo の intake 側で落ちたと切り分けられている（`/root/.openclaw/line-harness-ks/.ars-state/fr-id-field-fix-20260718.md:73-80,82-87`、`/root/.openclaw/workspace/.ars-state/overnight-plan-20260717-line-harness.md:137-143`）。
3. owner 承認のもと本番 `GMOxoMtK` の logic を `[]` にした後は、実署名の捕捉、D1 mirror での friend 復元、再入場 URL への回答 prefill 付与がすべて PASS した。使い捨て `cc6lymYZ` は DELETE→GET 404 済み（`/root/.openclaw/line-harness-ks/.ars-state/fr-id-field-fix-20260718.md:89-103`、`/root/.openclaw/workspace/.ars-state/overnight-plan-20260717-line-harness.md:148-152`）。
4. owner 実機でも logic 除去後に rating/署名が保存されるようになった。logic 有効時は submit trigger より後ろの可視回答も欠けていた（`docs/BACKLOG.md:584-586`）。別の route-terminal 使い捨て実測でも、submit rule の形によって後方回答が silent に失われる挙動が確認されている（`/root/.openclaw/line-harness-ks/.plans/2026-07-17-route-terminal-submit/spike-s1-results.md:64-103`）。

したがって、現行形のままでは次の 2 機能は同一フォームで両立しない。

- route-terminal: `packages/shared/src/formaloo-forms.ts:699-771` が生成する、回答途中の `submit` logic。
- fr_id/prefill: `apps/worker/src/routes/formaloo-public.ts:298-336` が URL に付ける署名 `fr_id` を hidden field が保存し、webhook/reconcile が検証して `friend_id` を復元する経路。

現行コードはこの衝突を保守的に検知し、任意の non-empty logic を `logicConflict` として `out_of_sync` にする（`apps/worker/src/services/formaloo-system-fields.ts:87-177`）。管理画面には日本語警告を出す（`apps/worker/src/routes/forms-advanced.ts:798-811`）。これは「共存できた」実装ではなく、危険な組合せを正直に止める安全ブレーキである。

### 証跡の訂正関係

初期の `/root/.openclaw/line-harness-ks/.plans/2026-07-18-fr-id-capture-fix/spike-results.md:30-39` は本番 field の alias が未設定だと推定したが、その後の実 GET で `alias='fr_id'` 済み、`type=short_text + invisible:true` だったと反証された（`/root/.openclaw/line-harness-ks/.ars-state/fr-id-field-fix-20260718.md:8-26`）。本設計は、初期推定ではなく後続の GET と logic 有無の A/B を採用する。

また、上の A/B が直接証明したのは current route-terminal と同型の submit rule である。identifier/actions の別構成や別 rule type まで一律に不可能とは、まだ実測していない。よって案 C の可否は本書では **未確定** とする。

## 2. 設計上の非交渉条件

1. **発行元と改ざん有無を署名で検証する。** `friend_id` を回答へ付ける根拠は、submission 自身に含まれる HMAC 署名値の検証成功に限る。ただし現行 token は `friendId + HMAC` だけで form/tenant/期限/one-time に束縛されず、漏えい・共有された valid token の replay は防がない（`apps/worker/src/services/formaloo-friend-token.ts:8-16`）。これは現行の「識別であって認証ではない」という受容境界であり、「現在操作している人が本人」と暗号学的に証明するものではない。
2. **時間が近いだけでは本人とみなさない。** 候補が 1 件でも、別人・直 URL・離脱後の別回答を排除できないためである。
3. **不明なら紐付けない。** `friend_id=null`、prefill 無しへ倒す。誤って他人の回答を見せるより、本人の prefill が無い方を選ぶ。
4. **hosted の見た目ではなく row を正本にする。** API が 200 を返したことや送信完了画面だけでは PASS にしない。request payload、row `data` / `rendered_data`、D1 mirror を照合する。
5. **回答欠落も同時に検査する。** fr_id だけ保存できても、rating/署名など回答者が入力した値が 1 つでも欠ければ共存案は FAIL。
6. **本番は実測場所にしない。** C の判定は自作使い捨てフォームだけで行い、全 slug と success-page を DELETE→GET 404 で回収する。
7. **未確認構造は allowlist に入れない。** C が PASS した場合、form ごとに変わる field/success-page slug を役割名へ正規化し、self-reference、action 順序、args 型、許される item composition を表す **構造 grammar** として compatible 判定する。実測済み grammar 外の action/when/item は従来どおり警告する。

## 3. 選択肢の比較

工数は 1 人が実装・テスト・レビュー証跡まで行う概算で、Formaloo からの返答待ちと owner の確認待ちは含めない。

| 案 | 実現可否 | 工数目安 | 誤帰属・PII リスク | 回帰リスク | owner 操作の要否 |
|---|---|---:|---|---|---|
| A 現行維持 | **実現済み。ただし同一フォーム内の共存ではない。** prefill を使うフォームは logic 無し、route-terminal は prefill 不要フォームだけに限定する | 0〜0.5 人日（既存警告の運用確認のみ） | 低。署名検証済み submission だけを本人へ紐付ける現行 invariant を維持 | 低。既に land 済み | 必要。フォームごとに「自動途中送信」か「再入場 prefill」かを選ぶ。logic の除去・復元は owner 承認対象 |
| B server-side 事後紐付け | D1 へ候補相関を記録すること自体は実装可能。ただし**現行データだけで本人を確定する自動紐付けは不可** | 調査 2〜3 人日、試作を含め 5〜10 人日 | **高・採用不可。** 時間窓が近い別人の row を `friend_id` に結ぶと、次回 prefill で他人の回答を表示し得る | 高。webhook/reconcile、D1 schema、prefill lookup の中心 invariant に触れる | 実装後の通常操作は不要だが、PII 誤帰属を受容する選択は不可。deterministic key が見つかるまで GO を出せない |
| C logic の形を変える | **未確定。** current `is_answered -> submit` は FAIL 済み。別 identifier/actions 構成・別 rule type は使い捨てフォーム実測前なので可否を断定しない | spike 1〜2 人日。PASS 後の最小実装 2〜4 人日 | spike は合成 token のみで低。採用後は現行 HMAC 識別境界を維持するが、valid token replay の既知リスクは残る | 中〜高。Formaloo の undocumented behavior と logic round-trip に依存するため、正規化した構造 grammar と live 回帰が必要 | spike には不要。PASS 後、本番反映前に owner が pilot 対象と rollback を承認 |
| D0 webhook payload side-channel | **未確定。** row から消えた fr_id/回答が webhook の raw payload には残るなら、時間相関なしで D1 mirror を復元できる可能性がある | spike 0.5〜1 人日。Positive 後の設計・実装 2〜5 人日 | payload 自身の HMAC 検証を必須にすれば現行より悪化させない。ただし token replay は残る。欠落時に時間相関へ fallback すると高 | 中。既存 parser はあるが、webhook と row の SoT 差、後処理の発火順を固定する必要あり | disposable webhook の first-party capture/secret 配線が必要。本番配線は owner 承認対象 |
| D1 Formaloo サポートへ仕様確認 | 返答内容次第。hidden 破棄が仕様/不具合か、保存できる公式 submit rule があるかを確認できる | 質問作成 0.5 人日 + 返答待ち | 低。フォーム slug、row 値、署名 token、氏名を伏せた再現だけを送る | 低。コード変更なし | account owner からの問い合わせ、またはサポート閲覧許可が必要になる可能性あり |
| D2 self-render / proxy submit | 原理上は可能。harness が本人性を保持したまま回答を受け、route-terminal と保存順序を自前制御できる | 20〜40 人日以上。全 field、upload、署名、アクセシビリティ、スパム対策、Formaloo 同期まで再構築 | 中。Formaloo に加えて harness も回答 PII の一次処理者になる | **非常に高い。** hosted form の代替実装になる | 必要。データ処理境界、費用、UX、大工事の優先順位を owner が承認 |

## 4. 各案の設計評価

### A: 安全な現状維持

A は今すぐ安全に運用でき、C の検証中の fallback として残す。`logicConflict` が出たフォームは「再保存すれば直る」のではなく、機能選択が必要だと owner に伝える。

ただし、A は本案件の「同一フォームで両立」という目的を満たさない。恒久推奨ではなく、調査中に個人情報を守る baseline である。

### B: 時間窓相関は prefill の本人確認に使わない

現在の `form_opens` は `id, form_id, friend_id, friend_name, opened_at` だけを持つ（`packages/db/migrations/024_form_opens.sql:1-9`）。回答 mirror は `submission id, form_id, friend_id, answers_json, submitted_at` 等を持つ（`packages/db/migrations/079_formaloo_forms.sql:33-45`）。両者を結ぶ、submission にも残る共通 nonce は無い。

たとえば次の全条件を満たしても、本人性の証明にはならない。

- 同じ form で開封候補が 1 件だけ。
- 開封から 30〜60 秒以内に row が 1 件だけ到着。
- webhook が正規署名済みで、時刻順も自然。
- 同じ時間帯に別の `/fo` 開封が無い。

「A さんが開いた後に離脱し、直 URL から B さんが送った」場合を排除できないからである。したがって B の fail-closed 契約は次のようにする。

1. submission 自身から検証できる署名 nonce が無ければ `unmatched`。
2. 時間・件数・順序は診断候補の表示にだけ使い、`formaloo_submissions.friend_id` を更新しない。
3. Formaloo row へ fr_id を PATCH しない。根拠のない値を外部 SoT に焼き込まない。
4. `getFriendLatestSubmission()` の入力に候補相関を渡さず、prefill を発生させない。
5. 将来、logic 有効時にも保存される deterministic nonce が実測できた時だけ別設計として再評価する。

この契約なら誤帰属は防げるが、自動紐付けが常に拒否されるため共存問題は解かない。よって B は推奨しない。

### C: 使い捨てフォームで native 共存形を探す

C は、最小工数で Formaloo hosted の UX を保ったまま共存できる可能性がある。ただし API の PATCH 200 や GET echo ではなく、次の row-level matrix を全部通す必要がある。

| matrix | logic | 役割 | 判定条件 |
|---|---|---|---|
| C0 | `logic=[]` | positive baseline。候補ではない | linear form × 3 回で hidden と全可視回答が保存されれば `BASELINE_MET`。1 回でも欠ければ検査環境不成立 |
| C1 | 現行 standalone `is_answered(host) -> submit` | expected-negative control。候補ではない | production-like 3 route × 3 回で既知の hidden 欠落を安定再現すれば `NEGATIVE_REPRODUCED`。再現しなければ環境差として BLOCKED |
| C2 | `jump_to_success_page -> submit` 隣接ペア | 既存 generator が SP target 有りで既に生成できる候補 | terminal count=1 の 2 route × 3 回と count=2 の 3 route × 3 回、全 15 run で early landing、hidden、入力済み可視回答が揃えば `PASS` |
| C3+ | Formaloo サポート回答または実 GET で確認できた別 submit rule type / identifier 構成 | 追加候補 | 候補ごとに C2 と同じ count=1/2 の全 15 run が PASS。候補 JSON の provenance が無ければ実行しない |

C1 と C2 の terminal item は、動的 slug を役割 placeholder に置き換えた次の canonical template で区別する。

C1（standalone submit）:

```json
{"type":"field","identifier":"$HOST","actions":[{"action":"submit","args":[],"when":{"operation":"is_answered","args":[{"type":"field","value":"$HOST"}]}}]}
```

C2（success-page pair）:

```json
{"type":"field","identifier":"$HOST","actions":[{"action":"jump_to_success_page","args":[{"type":"field","identifier":"$SUCCESS_PAGE"}],"when":{"operation":"is_answered","args":[{"type":"field","value":"$HOST"}]}},{"action":"submit","args":[],"when":{"operation":"is_answered","args":[{"type":"field","value":"$HOST"}]}}]}
```

候補 C2/C3+ は terminal count=1 と count=2 の両方を実測する。count=2 では route-choice の jump item、A terminal item、B terminal item、terminal を通らず通常送信する C route を同居させる。これにより、複数 terminal と unrelated jump の composition、inactive rule が C route の rating/署名を落とさないことまで検査する。count>2 は今回未実測なので compatible grammar に含めず、警告側へ倒す。

- ルート A: A terminal host まで入力して早期送信。choice、A text、A host、hidden `fr_id` が保存されること。
- ルート B: B terminal host まで入力して早期送信。choice、B text、B host、hidden `fr_id` が保存されること。
- ルート C: A/B terminal を通らず後方へ進み、rating/署名を含む回答後に通常送信。inactive terminal rule の存在で入力が欠けないこと。

C0 は linear baseline 3 回、C1 は count=2 の 9 回、C2 は count=1/2 の 15 回、C3 候補を N 個追加した時は各 15 回なので、総 run 数は **`27 + 15N`**。C3 候補が無ければ N=0 と記録する。URL param の非同期取込を誤判定しないよう hosted 描画後 8 秒以上待つ。client request payload と取得後 row の両方を保存し、同じ submission の webhook payload も D0 の別観測軸として秘匿保存する。

候補 C2/C3+ は、1 回でも次のいずれかが起きたら FAIL。

- hidden `fr_id` が欠落、NULL、truncate、署名検証不能。
- 回答者が入力した visible/rating/signature のいずれかが row から欠落。
- 早期 submit または指定 success-page 着地が不発。
- 同じ操作で結果が揺れる。
- DELETE 後の GET が 404 にならない。

### D0: webhook payload を deterministic side-channel にできるか

既存 webhook parser は payload の `rendered_data` / answers に署名 `fr_id` があれば検証して friend を復元できる（`apps/worker/src/services/formaloo-webhook.ts:101-180`）。受信 route と D1 upsert も既にある（`apps/worker/src/routes/formaloo-public.ts:103-171`、`packages/db/src/formaloo.ts:572-610`）。

ただし、logic 有効時に **row から消えた値が webhook payload にだけ残るかは未実測**である。C-S1 と同じ submission を first-party 一時 capture endpoint で受け、raw body は一時保持だけにし、submission id 一致・fr_id 署名結果・回答 key 集合へ縮約してから削除する。endpoint が用意できなければ D0 だけ BLOCKED とし、third-party request bin へ PII を送らない。

D0 を Positive とする最低条件は次のとおり。ここでいう Positive は**現行の HMAC 識別境界内**での判定であり、valid token replay を防ぐ強い本人認証を意味しない。form/tenant/期限/one-time 束縛まで求める場合は、現行 `fr_id` を流用せず scoped one-time nonce の別設計・移行が必要である。

- webhook payload 自身に有効な署名 `fr_id` と Formaloo submission id がある。時刻から補わない。
- rating/署名を含む、回答者が入力した全 field が payload にある。
- invalid/absent token は `friend_id=null` で、legacy unsigned candidate へ fallback しない。
- D1 で既に別 `friend_id` がある場合は上書きしない。
- webhook 再送で tag/scenario/LINE message が二重発火しない。

fr_id だけが webhook にあり、可視回答が欠ける場合は「prefill identity のみ回復する部分案」で、Formaloo row/Sheets の回答欠落は直らない。その場合は本案件の完全な共存案として採用しない。時間窓相関や Formaloo row への推測 PATCH へは fallback しない。

### D1/D2: vendor 確認と self-render

D1 は C3+ の候補を安全に絞るため並行可能だが、返答だけで PASS にはしない。サポートが「保存される」と回答しても使い捨て row 実測を通す。

D2 は Formaloo の undocumented behavior から脱する根本案だが、本件の小さな設計案件から直ちに着手する規模ではない。C が全滅し、同一フォーム共存が事業上必須だと owner が判断した場合に、新案件として purpose・PII・移行計画から立て直す。

## 5. 推奨案: C（使い捨て実測を先に行う）

**推奨は C。** ただし「C は実現できる」という推奨ではなく、**C の row-level 実測を最初の go/no-go gate にする**という推奨である。実測が終わるまでは A の警告を解除しない。

理由は 4 つ。

1. B のように時刻から identity を推測せず、現行の「HMAC を検証できた識別値だけ採る」invariant を残せる（valid token replay の既知境界は残る）。
2. PASS すれば Formaloo hosted、既存 `/fo`、webhook/reconcile をほぼそのまま使えるため、self-render より変更が小さい。
3. FAIL しても自作使い捨てフォームを消すだけで、本番とコードに影響が無い。
4. 「どの logic でも駄目」と憶測で閉じず、かといって未実測の構造 grammar を本番へ出さない。

判定後の一本道は次のとおり。

- 候補 C2/C3+ の 1 grammar 以上が全条件 PASS: 動的 slug を役割へ正規化した実測済み構造 grammar だけを compatible allowlist にし、TDD で generator（変更が必要な場合だけ）と warning 判定を最小変更する。使い捨てで code-generated grammar を再実測してから owner pilot へ進む。
- 全形 FAIL だが D0 が全条件 Positive: D0 を別 design/review gate に渡す。C source は変更せず、webhook raw payload と D1/row の SoT 差を先に仕様化する。
- 全形 FAIL かつ D0 も Negative/部分 Positive: source code は変更しない。A を継続し、D1 の回答を待つ。B へ自動 fallback しない。
- 判定が揺れる/cleanup 不能: BLOCKED とし、本番へ進まない。

### owner 向け日常語 1 行サマリ

おすすめは、まず捨ててもよいテスト用フォームで「途中送信しても本人情報と回答が全部残る形」を探し、全部残ると確認できた形だけ本番候補にすることです。

### owner 向け選択肢提示文

> 🅒 **おすすめ**: テスト用フォームだけで両立できる形を 1〜2 日調べ、成功した時だけ本番候補にします。調査中は今の安全設定を維持します。
> 🅐 **現状維持**: フォームごとに「途中で自動送信」か「次回の自動入力」のどちらかを選びます。安全ですが、同じフォームでは両方使えません。
> 🅑 **おすすめしません**: 時刻が近い開封と回答を自動で結ぶ案は、別の人の回答を本人のものにする危険があります。
> 🅓 **待つ案**: Formaloo に公式仕様を確認し、回答を待ちます。回答が来てもテスト用フォームで再確認します。
> 🅔 **大工事**: 自前フォームへ置き換えれば制御できますが、数週間規模なので最後の手段です。

## 6. 推奨案 C の実装 tasks 雛形

以下は、次案件で Opus が単独実行できる粒度の雛形である。**本設計案件では実行しない。**

### 6.1 精密スコープ

target_files:

- `.plans/2026-07-19-route-terminal-prefill-coexist/spike/run-c-spike.test.mjs` — mutation allowlist、redaction、cleanup 順序の test-first harness。
- `.plans/2026-07-19-route-terminal-prefill-coexist/spike/run-c-spike.mjs` — C matrix の再現 runner。test Green 後だけ `--execute` を許す。
- `.plans/2026-07-19-route-terminal-prefill-coexist/spike/candidates.json` — C0/C1/C2 の canonical role template と C3+ の provenance。
- `.plans/2026-07-19-route-terminal-prefill-coexist/spike/owned-resources.json` — runner が作った resource slug と cleanup status の allowlist（token/回答値は禁止）。
- `.plans/2026-07-19-route-terminal-prefill-coexist/c-spike-results.md` — live matrix、row、D0 派生観測、cleanup の秘匿済み証跡。

C2/C3+ が PASS した場合だけ変更候補:

- `packages/shared/src/formaloo-route-terminal.test.ts:39-133,210-260` — verified structural grammar の Red/Green pin。
- `packages/shared/src/formaloo-forms.ts:699-771` — `generateSubmitWhen()` / `toFormalooRawLogic()` の最小生成変更。
- `apps/worker/src/services/formaloo-system-fields.test.ts:260-315` — compatible grammar と unknown fail-closed の Red/Green。
- `apps/worker/src/services/formaloo-system-fields.ts:87-177,197-208` — `logicConflict` 判定。実測 PASS grammar だけ除外する。
- `apps/worker/src/services/formaloo-sync.system-fields.test.ts:1-90` — sync surface の回帰。
- `apps/worker/src/services/formaloo-sync.ts:199-248` — logic PATCH 前の旧状態ではなく、保存後の最終状態で conflict を判定する。
- `apps/worker/src/routes/forms-advanced.system-fields.test.ts:186-200` — first-save の最終状態を route surface へ反映する回帰。
- `apps/worker/src/routes/forms-advanced-route-terminal.test.ts:234-333` — warning の route-level 回帰。
- `apps/worker/src/routes/forms-advanced.ts:798-811` — owner 向け warning 文言の最小更新。

read-only / protected anchors:

- `apps/worker/src/routes/formaloo-public.ts:298-336` — 署名 fr_id と answer prefill 合成は変更しない。
- `apps/worker/src/services/formaloo-friend-token.ts:8-16` — 現行 token の「識別≠認証 / replay 受容」境界は本 case で拡張解釈も変更もしない。
- `apps/worker/src/services/formaloo-webhook.ts:146-172` — 署名検証失敗時 `friendId=null` は変更しない。
- `packages/db/src/formaloo.ts:591-610,644-661` — upsert と friend 完全一致 lookup は変更しない。
- `packages/db/migrations/024_form_opens.sql:1-9` — B 用の時間窓相関 schema を追加しない。

out_of_scope:

- `GMOxoMtK` / `puw7lh` / `Z5IEH85R` の PATCH/POST/DELETE と検証送信。
- B の時間窓自動紐付け、D1 schema migration、Formaloo row への identity PATCH。
- `/fo` token 形式、webhook HMAC、prefill lookup、fr_name の既定値変更。
- self-render、デプロイ、既存フォーム backfill、owner 未承認 pilot。

### 6.2 atomic tasks

#### C-S0 — mutation/cleanup harness を TDD で作る（外部操作前）

1. `run-c-spike.test.mjs` を先に書き、次を mock HTTP で assert する。
   - `owned-resources.json` に無い slug、title prefix が違う slug、本番 3 identifier への mutation/DELETE を拒否。
   - create 応答を受けた直後に owned resource を永続し、途中例外でも cleanup を再開可能。
   - success-page → form の順に DELETE し、それぞれ GET 404 まで行う。
   - token、secret、friend id、メール、回答値を artifact へ書かず、boolean・key 名・hash だけ残す。
   - 既定は DRY_RUN。`--execute` と `ROUTE_PREFILL_SPIKE_CONFIRM=<今回の DELETE-ME title>` が完全一致する時だけ mutation。
2. `node --test .plans/2026-07-19-route-terminal-prefill-coexist/spike/run-c-spike.test.mjs` を実行し、runner 未実装による Red を観察する。
3. `run-c-spike.mjs` と C0/C1/C2 role template を持つ `candidates.json` を最小実装し、同じ command を Green にする。
4. `owned-resources.json` は `{ "resources": [] }` から開始する。

機械検証可能 done 条件:

- Red は missing runner/期待 behavior 不在で失敗し、test の構文 error ではない。
- Green で上の安全条件が全 PASS。
- `rg 'GMOxoMtK|puw7lh|Z5IEH85R' run-c-spike.mjs` で hard-deny list が存在する。
- candidate C1/C2 は本書の canonical template と role-normalized JSON 一致。

commit 0（外部操作前の安全 harness）:

```text
test(route-terminal-prefill): add fail-closed disposable spike harness

Generator-LLM: claude
Task-Size: large
```

明示 stage: `git add .plans/2026-07-19-route-terminal-prefill-coexist/spike/run-c-spike.test.mjs .plans/2026-07-19-route-terminal-prefill-coexist/spike/run-c-spike.mjs .plans/2026-07-19-route-terminal-prefill-coexist/spike/candidates.json .plans/2026-07-19-route-terminal-prefill-coexist/spike/owned-resources.json`

#### C-S1 — live matrix を安全に実行する（production source 変更なし）

1. `/root/.secrets/formaloo/api-credentials.env` を Bash source し、値を出力しない。browser 風 UA を固定する。
2. C3+ を足す場合は、API の実 GET echo または Formaloo support 回答を provenance として `candidates.json` に記録し、canonical role template が無い候補は実行しない。
3. `run-c-spike.mjs --execute` だけを入口とし、一意な `DELETE-ME-route-terminal-prefill-<timestamp>` title で自作 form を作る。返された form/field/success-page slug を `owned-resources.json` に即記録する。
4. C0 は linear × 3、C1 は terminal count=2 の route A/B/C × 3、C2 と各 C3 は count=1（terminal A + normal C）× 3 と count=2（terminal A/B + normal C）× 3 を、描画後 8 秒以上待って送信する。合成 friend id と一時署名だけを使い、氏名・実メール・本番 friend id は使わない。
5. request payload、row `data` / `rendered_data`、着地、署名 byte 一致、回答 field 集合を機械比較する。
6. D0 は別軸。owner/infra-ops が用意した **first-party 一時 capture endpoint**（secret 付き、synthetic payload 限定、TTL/削除 API あり）がある時だけ同じ submission を観測する。third-party request bin は使わない。raw payload は一時 endpoint 内で保持し、runner は submission id 一致、署名 valid、key 集合へ縮約してから raw を削除する。endpoint が無ければ `D0_STATUS=BLOCKED_NO_CAPTURE` とし、C の row 判定は続ける。
7. success-page → form の順で DELETE→GET 404 とし、一時 webhook 登録/capture payload も解除・削除する。

機械検証可能 done 条件:

- `C_TOTAL_RUNS=27+15N` と実レコード数が一致する（N=`candidates.json` の C3 候補数）。
- C0 の 3 run は `EXPECTATION=BASELINE_MET`、C1 の 9 run は `EXPECTATION=NEGATIVE_REPRODUCED` または全体 BLOCKED。候補 C2/C3+ だけが `STATUS=PASS|FAIL|BLOCKED` を持つ。
- C1/C2/C3+ の各 run に `terminal_count=1|2`（C1 は2）、`route=A|B|C`、`run=1|2|3`、`request_has_fr_id`、`row_has_fr_id`、`signature_byte_equal`、`expected_answer_keys`、`actual_answer_keys`、`landing` がある。
- D0 観測に `webhook_received`、`webhook_submission_id_matches`、`webhook_signature_valid`、`webhook_answer_keys`、`D0_STATUS=POSITIVE|PARTIAL|NEGATIVE|BLOCKED_NO_CAPTURE` がある。raw token/回答値は commit artifact に 0 件。
- `owned-resources.json` の全 form/success-page が `DELETE=success` かつ `GET_AFTER_DELETE=404`。未 cleanup が 1 件でも全体 BLOCKED。
- 本番 3 identifier が mutation target に 0 件。

commit 1（秘匿済み結果 + cleanup 証跡）:

```text
docs(route-terminal-prefill): record disposable C matrix

Generator-LLM: claude
Task-Size: large
```

明示 stage: `git add .plans/2026-07-19-route-terminal-prefill-coexist/c-spike-results.md .plans/2026-07-19-route-terminal-prefill-coexist/spike/candidates.json .plans/2026-07-19-route-terminal-prefill-coexist/spike/owned-resources.json`

#### C-GATE — source edit の go/no-go

- 前提 gate: C0 が全 3 run `BASELINE_MET`、C1 が全 9 run `NEGATIVE_REPRODUCED`、cleanup 全 404。満たさなければ `DECISION=BLOCKED`。
- 候補 gate: C2 または個別 C3 候補の **全 15 run** が PASS した grammar だけ採用候補。C0/C1 を採用候補に数えない。
- PASS grammar が 0 件なら `DECISION=NO_GO_KEEP_A` として終了し、source/test を「試しに」変更しない。
- PASS grammar を現在の `toFormalooRawLogic()` 出力と role-normalized 比較し、同じなら `generator_change_required=false` として C-T1 を skip、C-T2 へ進む。異なる時だけ `generator_change_required=true` として C-T1 へ進む。

#### C-T1 — verified grammar を TDD で生成（PASS かつ generator change 必須時のみ）

1. `packages/shared/src/formaloo-route-terminal.test.ts` に、dynamic slug を role へ正規化した live PASS grammar を期待する最小 test を先に追加する。
2. `pnpm --filter @line-crm/shared exec vitest run src/formaloo-route-terminal.test.ts` を実行し、旧生成形との差で Red になることを確認・記録する。
3. `packages/shared/src/formaloo-forms.ts` を最小変更し、同じ command を Green にする。
4. show/hide/jump、複数 terminal、round-trip、unknown raw preserve の既存 test も同時に Green であることを確認する。

`generator_change_required=false`（例: C2 が PASS し現 generator が同じ grammar を既に生成）の場合、Red を捏造しない。`C-T1=SKIPPED_NOT_REQUIRED` と記録し、classifier の Red→Green である C-T2 へ直接進む。

機械検証可能 done 条件:

- `generator_change_required=true` の時だけ Red log が assertion mismatch で失敗し、typo/import error ではない。false の時は `C-T1=SKIPPED_NOT_REQUIRED`。
- Green で `formaloo-route-terminal.test.ts` が全 PASS。
- generator output は dynamic slug を role へ正規化後、live PASS grammar と canonical JSON 比較で一致。
- C 未使用の show/hide/jump fixture は変更前後 canonical JSON が一致。

commit 2（test + generator を同じ論理単位）:

```text
fix(route-terminal): emit row-verified compatible submit grammar

Generator-LLM: claude
Task-Size: large
```

明示 stage: `git add packages/shared/src/formaloo-route-terminal.test.ts packages/shared/src/formaloo-forms.ts`

#### C-T2 — logicConflict を構造 grammar allowlist 化し、最終状態で判定（PASS 時のみ）

1. `apps/worker/src/services/formaloo-system-fields.test.ts` に次を先に追加する。
   - randomized slug、route-choice jump item、A/B の複数 terminal item を持つ live PASS grammar は `logicConflict=false`。
   - current FAIL grammar、self-reference/action order/args type の 1 条件改変、未知 action/when、未実測 show/hide 混在は `logicConflict=true`。
   - live 済み terminal count=1/2 と matching jump item は許可し、未実測 count>2 は conflict にする。
   - hidden field 自体の missing/not_hidden/duplicate は従来どおり out_of_sync。
2. `formaloo-sync.system-fields.test.ts` と route test に、次の保存 1 回目の最終状態を先に追加する。
   - remote `logic=[]` → desired non-compatible grammar: 同じ保存 response で即 `out_of_sync`。
   - remote non-compatible grammar → desired `logic=[]`: 同じ保存 response で conflict 解消。
   - final re-GET 失敗: silent `idle` 成功にしない。
3. worker test を Red で観察する。
4. source に小さな pure predicate を 1 個だけ追加し、field/SP slug を role に正規化した structural grammar 以外は fail-closed にする。logic PATCH 後に final remote state を re-GET して health を再評価し、PATCH 前の state を最終判定に使わない。
5. sync と route warning test を Green にし、警告文を「実測済み compatible grammar 以外」に合わせる。

実行 command:

```bash
pnpm --filter worker exec vitest run \
  src/services/formaloo-system-fields.test.ts \
  src/services/formaloo-sync.system-fields.test.ts \
  src/routes/forms-advanced.system-fields.test.ts \
  src/routes/forms-advanced-route-terminal.test.ts
```

機械検証可能 done 条件:

- dynamic slug が違っても、live 済み terminal count=1/2 と PASS grammar 内なら conflict 無し。count>2 は conflict あり。
- self-reference/action order/args type/未知 action/未実測 composition のどれかが外れたら conflict あり。
- logic 追加/clear のどちらも、初回保存 response が final remote state と一致。
- final re-GET 不能は silent `idle` にならない。
- current A 運用の日本語警告 test が残る。
- `formaloo-public.ts`、`formaloo-webhook.ts`、DB migration に diff 0。

commit 3（classifier + warning + tests）:

```text
fix(formaloo): allow only row-verified prefill-compatible logic

Generator-LLM: claude
Task-Size: large
```

明示 stage: `git add apps/worker/src/services/formaloo-system-fields.test.ts apps/worker/src/services/formaloo-system-fields.ts apps/worker/src/services/formaloo-sync.system-fields.test.ts apps/worker/src/services/formaloo-sync.ts apps/worker/src/routes/forms-advanced.system-fields.test.ts apps/worker/src/routes/forms-advanced-route-terminal.test.ts apps/worker/src/routes/forms-advanced.ts`

#### C-V1 — code-generated grammar の再 live 検証（PASS 時のみ）

1. `toFormalooRawLogic()` の出力を `run-c-spike.mjs` へそのまま渡し、新しい自作使い捨てフォームへ push する。手書き JSON へ戻さない。
2. C-S1 と同じ terminal count=1/2（計 15 run）、request/row/landing/署名/回答集合を再検証する。
3. 全 resource を DELETE→GET 404 にする。
4. relevant suite と typecheck を実行する。

```bash
pnpm --filter @line-crm/shared exec vitest run src/formaloo-route-terminal.test.ts
pnpm --filter worker exec vitest run src/services/formaloo-system-fields.test.ts src/services/formaloo-sync.system-fields.test.ts src/routes/forms-advanced.system-fields.test.ts src/routes/forms-advanced-route-terminal.test.ts
pnpm --filter @line-crm/shared run typecheck
pnpm --filter worker run typecheck
```

機械検証可能 done 条件:

- code-generated grammar の全 15 live run が C-S1 の PASS 候補と同じ結果。
- cleanup 全件 GET 404。
- 上記 test/typecheck が exit 0。
- reviewer PASS と owner pilot 承認が出るまで production mutation 0。

commit 4（code-generated live recheck 証跡）:

```text
docs(route-terminal-prefill): verify generated grammar on disposable form

Generator-LLM: claude
Task-Size: large
```

明示 stage: `git add .plans/2026-07-19-route-terminal-prefill-coexist/c-spike-results.md .plans/2026-07-19-route-terminal-prefill-coexist/spike/owned-resources.json`

#### O-C1 — owner pilot gate（generator の実行範囲外）

owner へ次を 1 回だけ提示する。

- PASS した grammar と、保存できた field 一覧。
- 失敗時は logic を `[]` に戻す 1 手 rollback。
- pilot 対象は本番 3 identifier 以外の owner 指定フォーム。
- pilot 成功後も production 3 form の変更は個別承認。

## 7. C 案を今回実測しなかった理由

本案件の正本は「設計案件（実装なし・成果物 = design.md）」であり、この lane で許可された成果物は owner の判断材料と次案件の実行雛形である。C は認証付き外部 API への create/PATCH/hosted submit/DELETE を伴い、再現スクリプト、mutation allowlist、cleanup trap、row-level matrix を 1 つの実行単位として先に用意しないと、安全で再実行可能な証跡にならない。

そのため今回は ad-hoc な外部変更を行わず、既に実測済みの current grammar を **FAIL**、別 grammar を **未実測・未確定** とした。これは「C は不可」という断定ではない。次案件の最初を C-S0/C-S1 に固定し、**自作使い捨てフォームのみ**、終了時に全 resource の **DELETE→GET 404** をログで証明する。

本案件中の外部操作は 0 件であり、本番 `GMOxoMtK` / `puw7lh` / `Z5IEH85R` への GET/PATCH/POST/DELETE も行っていない。
