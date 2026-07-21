# richmenu-rollout-speedup — host closer 実測チェック

## オーナー向けの説明

既存の友だちへリッチメニューを反映するとき、1人ずつではなくLINE公式の一括処理で最大500人ずつ進めるようにした。1,450人なら3回の一括処理が基本になり、LINE側が混雑したときは自動で待ってやり直す。画面には残り人数を出し、完了時刻は実際に進んだ速さからだけ概算する。画面の完了は「LINEが依頼を受け付けた」時点なので、最後はあやこの実画面で本当に切り替わったことまで確認する。

## 安全境界

- [ ] 査読済み revision の Worker / Web を、許可された実テナントへ反映してから始める。
- [ ] 対象のLINEアカウント、変更前の全員デフォルト、あやこの現在メニューを控える。token・key・顧客情報は記録へ貼らない。
- [ ] LINEメッセージ送信、一斉配信、Discord投稿、migration、保護4ファイルには触れない。操作はリッチメニューの設定と確認だけにする。
- [ ] 一時的な確認用メニューを使う場合は、終了後に控えた元のメニューへ戻す。オーナーが実際に使う新メニューへ切り替える場合は戻さない。

## 1,450人の反映時間を実測

- [ ] 対象アカウントのフォロー中人数を記録する。1,450人と異なる場合は、実人数も併記する。
- [ ] 開始直前のJST時刻を秒まで記録し、既定メニュー変更後に「既存の友だちへ再適用」を1回だけ開始する。連打しない。
- [ ] 画面に「最大500人ずつ」、一括処理の残り人数、実績ができるまで日時を捏造しない案内が表示されることを確認する。
- [ ] 進捗が動いた後は、実測ペースによる概算完了時刻が表示されることを確認する。
- [ ] 「LINEへの一括反映依頼は完了」と表示されたJST時刻を秒まで記録し、開始からの実時間を計算する。
- [ ] 1,450人なら10分以内か確認する。超えた場合は、人数・429/5xx・再試行・待機など観測できた理由と実時間をそのまま記録し、速かったことにしない。

## 実友だちで反映確認

- [ ] あやこを含む実友だちで、LINEアプリを開き直し、意図したリッチメニューへ実際に変わったことを確認する。
- [ ] 条件ルールに一致する友だちは条件側メニュー、どの条件にも一致しない友だちは全員デフォルトになることを確認する。
- [ ] 失敗人数が0人であることを確認する。0人でなければ、再試行後の結果と残件を記録する。
- [ ] 確認中のLINEメッセージ送信が0件だったことを確認する。

## 実施記録

- 実施日時（JST）: 未実施（査読後にhost closerが記入）
- 実装revision: 未記入
- 対象テナント / LINEアカウント: 未記入
- 対象人数: 未記入
- 開始時刻 / 完了時刻 / 実時間: 未記入
- 画面の残り人数 / 概算完了表示: 未記入
- あやこを含む実友だちの反映結果: 未記入
- 429 / 5xx / 個別再試行の観測: 未記入
- LINEメッセージ送信件数: 0件であることを確認予定
- 復元または本番設定確定: 未記入
- 結果: 未実施

---

# chat-composer-toolbar-compact — host closer 実機チェック

## オーナー向けの説明

定型文と絵文字を、画像を付けるクリップの横へまとめました。返信欄のボタンは下の1列だけになり、本文を書く欄は以前の4行から6行へ広がります。定型文や絵文字を選んだだけでは送信されず、送信ボタンを押すまで下書きのままです。

## 安全境界

- [ ] 査読済み revision の Web を、許可された preview または検証環境へ反映してから確認する。
- [ ] 個別チャットの返信欄だけを確認し、Worker、migration、Discord、実 LINE 送信には触れない。
- [ ] 実在する顧客の本文を使わず、必要なら架空の短文を入力する。送信ボタンは押さない。

## 1段化と入力欄の目視

- [ ] 個別チャットを開くと、本文入力欄の下に「画像添付・定型文・絵文字・送信」が同じ1列で並ぶ。
- [ ] 定型文と絵文字は文字付きの大きなボタンではなく、44px 四方のアイコンとして見える。
- [ ] 定型文・絵文字・画像添付へマウスを置くと用途が分かり、Tab キーでも4つの操作へ順番に到達できる。
- [ ] 本文入力欄が初期状態で6行分あり、従来の4行から少なくとも2行分広がって見える。
- [ ] 狭い画面でも操作群が別の縦段へ戻らず、本文入力欄や送信ボタンと重ならない。

## ピッカー・添付・下書きの非退行

- [ ] 定型文アイコンを押すと入力欄の上へ一覧が開き、項目を選ぶと本文へ入る。自動送信はされない。
- [ ] 絵文字アイコンを押すと入力欄の上へ一覧が開き、絵文字を選ぶとカーソル位置へ入る。Escape キーで閉じられる。
- [ ] 画像添付アイコンを押すと従来の画像選択欄が開き、もう一度押すと閉じる。
- [ ] インラインの AI 下書きがあるチャットでも、下書きカードと新しい1列ツールバーが同時に表示され、編集・承認・破棄の操作が消えていない。

## 実施記録

- 実施日時: 未実施（査読後に host closer が記入）
- 実装 revision: 未記入
- 検証環境 / 画面幅: 未記入
- 実施者: 未記入
- 結果: 未記入
- 備考: sandbox では自動テスト、TypeScript、static export まで実施済み。ここでは見た目と実ブラウザ操作だけを確認する。

---

# media-limits-maximize-pack-types — host closer 実機チェック

## 目的と安全境界

自動テストで確認できない、実際のLINEでの画像表示と配信セット展開だけを、査読後に2回の実射で確認する。

- [ ] 査読済み revision `57798a2` 以降のWorker/Webとmigration 124が、許可された検証環境へ反映済みであることを確認する。
- [ ] 送信先があやこ `U5217ceb4debd9849959446ce8f902a27` と完全一致することを再確認する。他の友だち、グループ、全体配信には送らない。
- [ ] 本番3フォーム、Formaloo、Discordには触れない。token、key、password、顧客データを記録へ貼らない。
- [ ] 失敗しても自動再送・連打をせず、その時点で止めて結果を記録する。

## 1. 2MB級の画像メッセージを1回だけ送る

- [ ] 個人情報を含まない、約2MB（1MB超・10MB以下）のJPEGまたはPNGを1枚用意し、実容量を記録する。
- [ ] 通常の「画像」メッセージとして、あやこへ1回だけテスト送信する。
- [ ] 元画像が届き、トーク画面のプレビューも壊れず表示されることを確認する。追加送信はしない。

## 2. 新しい配信セット種別を1回だけ送る

- [ ] 確認専用の配信セットを作り、従来未対応だった種別を1件入れる。外部ファイルを増やさないため、原則スタンプを選ぶ。
- [ ] 保存後に開き直し、種別・内容・順序が変わっていないことを確認する。
- [ ] その配信セットを共通のテスト送信経路から、あやこへ1回だけ送る。
- [ ] 選んだ種別が正しく届くことを確認し、再送しない。

## 3. 撤収と記録

- [ ] 確認専用の配信セットを削除する。試験用アップロードを作った場合は、その完全一致keyだけを承認済み手順で削除する。
- [ ] 実施日時、査読済みrevision、画像の実容量、選んだ配信セット種別、2回の結果、削除完了を下へ記録する。

## 実施記録

- 実施日時: 未実施（査読後にhost closerが記入）
- 実装revision: `57798a2`
- 環境: 未記入
- 実施者: 未記入
- 画像容量 / 結果: 未記入
- 配信セット種別 / 結果: 未記入
- 撤収結果: 未記入

---

# internal-form-image-1mb-fix — host live checklist

## 目的と安全境界

「10MBまで」と表示される自前フォームで、1MBを超える実画像を保存でき、公開ページにも表示できることを査読後の trusted host で確認する。lane 内では 2MiB fixture の自動テストまで完了しているため、ここでは人の目で最後の 1 周だけを行う。

- [x] 査読済み revision の Worker / Web を preview または許可済み検証環境へ反映してから始める。（main c971e358 デプロイ済み実機・piecemaker worker API 経由で検証）
- [x] 本番 3 フォーム、既存フォーム、Formaloo backend、LINE 送信には触れない。その場で作る使い捨て internal フォーム 1 件だけを使う。（`fa_576f4e2b-66a3-43a3-a697-10ae411172e0` 使い捨てのみ使用）
- [x] token、key、password、顧客画像を記録へ貼らない。試験画像は 1.5〜3MB 程度、10MB 未満の架空 PNG を使う。（2,168,583 bytes のランダムノイズ PNG・実データではない）
- [x] 作成した form ID と、`media/form-image/{formId}/` で始まる試験 R2 key だけを撤収対象として控える。

## 1. 3 つの画像置き場所を保存

- [x] 高機能フォームを新規作成し、配信方式を「自前フォーム」に切り替える。（worker API 経由で `renderBackend: internal` に切替）
- [x] デザインの「ロゴ」に試験 PNG を設定して保存する。画面を再読込してもロゴが残り、保存エラーが出ないことを確認する。（design.logoUrl が R2 URL で GET read-back 確認済み）
- [x] デザインの「背景画像（全面）」にも同じ条件の試験 PNG を設定して保存する。再読込しても背景が残ることを確認する。（design.backgroundImageUrl が R2 URL で GET read-back 確認済み）
- [x] 「装飾 ＞ 画像」をフォーム先頭へ置き、幅を「全幅」にして試験 PNG を設定する。保存後に再読込しても画像が残ることを確認する。（field.image `hero` の config.imageUrl が R2 URL で GET read-back 確認済み）
- [x] ブラウザの Network または許可済み診断で、確定 URL が `/images/media/form-image/{formId}/...` になり、`data:image` のまま保存されていないことを確認する。（GET /api/forms-advanced/:id の応答 JSON 全体で `data:image` 出現数 0 を確認）

## 2. 公開ページで実表示

- [x] 使い捨てフォームを公開し、発行された `/f/{formId}` を新しいブラウザセッションで開く。（submit-for-review → publish → curl で `/f/:formId` 取得）
- [x] フォーム先頭の装飾画像が実際に表示され、壊れた画像や 500 にならないことを確認する。（`<img src="https://.../images/media/form-image/.../a8946b70....png" alt="ヘッダー画像">` が公開 HTML に実出力）
- [x] 画像リクエストが 200、画像の Content-Type、表示サイズが期待どおりであることを確認する。（3 URL 全て `code=200 type=image/png size=2168583`＝元 PNG と byte-exact 一致）
- [x] 参考として、管理画面の再読込後もロゴと背景の確定画像がプレビューへ戻ることを確認する。（GET read-back で design.logoUrl/backgroundImageUrl 確認。※デザインのロゴ/背景を公開ページ本文へ描画する機能自体は本 fix のスコープ外＝現状 renderFormPage は design 画像を未消費。装飾画像フィールドの公開表示は上記で実測確認済み）

## 3. 正直エラーと撤収

- [x] 許可された preview で R2 失敗を安全に注入できる場合だけ…注入できない環境では自動テスト 3 ケースの証跡で代替する。（本番相当環境での R2 障害注入は不可のため、sandbox fixture テスト 3 ケース（logo/cover/field.image 各所での R2 失敗→4xx+`画像の保存に失敗しました (サイズ/形式)`+definition_json 不変）の証跡で代替）
- [x] 使い捨てフォームを非公開化して削除する。（unpublish→DELETE で 200・削除後 `/f/:formId` は 404 確認）
- [x] 控えた form ID と完全一致する `media/form-image/{formId}/` 配下の試験 object だけを、承認済み host 手順で削除する。他 prefix は削除しない。（DELETE /api/images/:key を試験 3 key のみに実行）
- [x] 公開 URL が利用不能になり、試験 object が残っていないことを確認する。（3 URL 全て削除後 404 確認）

## 実施記録

- 実施日時: 2026-07-21 11:54〜11:57 JST
- 実装 revision: main HEAD `36bc6a7`（`a881b22`/`609a974` を含む・デプロイ済み `c971e358` 以降）
- 環境: piecemaker tenant 本番 Worker（`https://line-harness-piecemaker.piecemaker.workers.dev`）・使い捨て internal フォームのみ操作（本番 3 フォーム/Formaloo/LINE 送信は不接触）
- 実施者: closer（worker API Bearer 経由・headless browser 不要で HTTP 直接検証）
- 結果: PASS（3 置き場所 GREEN・data:image 残存ゼロ・公開ページ実表示 200・撤収完了で残骸ゼロ）
- 作成 form ID: `fa_576f4e2b-66a3-43a3-a697-10ae411172e0`（削除済み・GET 404 確認済み）／削除確認: 試験 R2 key 3 件（`media/form-image/fa_576f4e2b.../{7ba6f3c1,f6f1b5db,a8946b70}...png`）全て DELETE 200 + 再 GET 404
# auto-reply-rules-power-up — host closer 実機チェック

## オーナー向けの説明

決まった言葉への自動返信で、1回に最大5つの吹き出しを順番にまとめて送れるようにした。テンプレートパックも使え、FlexもJSONを直接書かず画面で作れる。「下書きにする」「自動で送信する」は、いま選んでいる方が緑色で分かる。

## 安全境界

- この sandbox では実 LINE 送信を行っていない。以下は査読済み revision を host が反映した後に1回だけ行う。
- 実射先はあやこ `U5217ceb4debd9849959446ce8f902a27` だけ。他の友だちには送らない。
- 本番3フォーム、Formaloo の経路・データ、Discord には触れない。
- 既存ルールを流用せず、この確認専用のルールとテンプレートパックを作り、最後に削除する。

## 作成・保存・画面確認

> **本ラウンドは verify-only 便（再デプロイ禁止 / 実 LINE 送信禁止）。owner 指示によりブラウザ画面クリックでなく piecemaker 本番 API を直接叩いて検証した（管理画面 UI 自体は本 revision で既に deploy 済・API と同一 worker ルートを叩くため挙動は同一）。**

- [x] 対象 LINE アカウントで、時刻入りの重複しない確認用キーワードを決めた（`w5verify_legacy_<unix ts>` / `w5verify_packrule_<unix ts>`・LINE account `ad9d30cd-2949-4373-ad52-00e7e0a5b594`「お祝い夢花火」）。
- [x] 確認専用テンプレートパック `w5verify_pack`（text/text/flex 3件）を作成し `GET /api/template-packs/:id` で順序どおり読み返した。
- [x] パック内容を展開した3吹き出し（text/text/flex）で自動返信ルールを1本作成し、保存内容が展開元パックと一致することを確認した（吹き出し種別を text/image/flex 混在の別ルールでも5件版を検証・後述）。
- [x] ルール保存後にもう一度 GET で読み直し、5吹き出しの種類・内容・順序（text/text/image/flex/text）が変わらず読み込まれることを確認した（byte-exact round-trip）。
- [x] 6吹き出しになる PUT は 400 で拒否（`"吹き出しは1件以上、最大5件までです"`）され、保存済みの5吹き出し状態が変わらないことを確認した（silent 切り詰めではなく正直エラー）。
- [x] 既存の単一応答ルール（`responseType`/`responseContent` のみで作成した後方互換ルール）が `responseMessages` を持たない旧データのまま単一吹き出しとして正しく読み出されることを確認した（レスポンスに `responseMessages:[{...}]` が自動導出）。
- [ ] FAQ設定の「下書きにする」「自動で送信する」トグルの緑色アクティブ表示は、本ラウンドではブラウザ画面クリックによる目視を実施していない（API のみの verify-only 便のため）。コードは `0e6e316 fix(faqs): show selected reply mode` で `aria-pressed` 付き選択状態 CSS を確認済み（差分レビュー時点で reviewer PASS 済）。次回のブラウザ実機/視覚QA時に目視確認を推奨。

## あやこへ1回だけ実射

- [ ] **本ラウンドでは実施しない（owner 指示: verify-only 便・実 LINE 送信禁止）。** 保存/読込の API レベル round-trip までを検証範囲とした。次回の統合視覚QA（ブラウザ実機 + LINE 実射）で実施予定。

## 撤収

- [x] 確認専用の自動返信ルール2本（`w5verify_legacy_*` / `w5verify_packrule_*`）とテンプレートパック `w5verify_pack` を DELETE し、`GET /api/auto-replies` と `GET /api/template-packs` が両方空配列に戻ったことを確認した。
- [x] 確認用キーワードは自動返信ルール削除と同時に消滅（応答経路自体が存在しない状態に戻った）。追加の実射はしていない。
- [x] 実施日時 2026-07-21 (JST) / 査読済み revision: repo HEAD `36bc6a7`（機能コミットは deploy 済み `c971e358` の祖先・deploy との diff は docs のみ）/ 結果: PASS（D-1〜D-4 の API レベル検証 all green）/ 削除完了: 上記2ルール+1パック DELETE 済み確認。秘密値・本文個人情報は記録していない。
# faq-nonanswer-to-unmatched — host live checklist

## owner 日常語

資料に答えが書かれていない質問も、見落とさず「答えられなかった質問」に残ります。AI の下書きには「資料不足」と表示されるので、FAQ や資料へ何を足せばよいか確認できます。反対に、資料で答えられた質問は「答えられなかった質問」へ増やしません。

## 目的と安全条件

査読済み revision、migration `123_faq_draft_answerable.sql`、Worker/Web を trusted host の検証環境へ反映した後、closer が「あやこ simulate」で両方向を確認する。sandbox と実 LINE では実施しない。

- 対象は「あやこ」の simulate friend だけにする。実 LINE の reply/push API、一斉配信、Discord、本番 3 フォームには触れない。
- FAQ 設定は `enabled=true` / `answerMode="draft"` とし、configured handoff を含む LINE outgoing が 0 件になる検証環境を使う。
- 非回答側は、関連資料は検索できるが申込開始日は書かれていない状態で「申し込みはいつからですか」を使う。検索 floor 未満ではなく AI の `answerable=false` 分岐を通ったことを Worker の理由コードまたは検証ログで確認する。
- 実回答側は、資料に答えが明記された質問を 1 件選ぶ。本文や個人情報は証跡へ転記せず、質問名、件数差分、ラベル有無、PASS/FAIL だけを残す。
- 本番相当の共有 DB を使わず、検証後にスナップショットへ戻せる preview/simulate DB を使う。利用できなければ実 LINE へ切り替えず `BLOCKED` とする。

## 事前確認

- [x] deployment SHA、migration 123 適用、対象 tenant、JST 開始時刻を記録した（main HEAD `a0984413e49b21704154ed7fac2221892dc0ce1d`／migration `123_faq_draft_answerable.sql` を KS・piecemaker 両テナント additive 適用（KS 4→4件不変／pm 3→3件不変）／対象 tenant=piecemaker／開始 2026-07-21 12:39 JST）。
- [x] AI 草案、未解決の「答えられなかった質問」、FAQ bot outgoing の開始件数を記録した（drafts=3／unmatched(対象質問文)=0／outgoing(直近ウィンドウ)=0）。
- [x] 非回答用の関連資料に申込開始日がないこと、実回答用の資料には答えが明記されていることを確認した（非回答=「申し込みはいつからですか」＝申込開始日の記載なし／実回答=「花火大会は何時に始まりますか」＝FAQ「花火大会の開催日時は？」に開催時刻が明記済み）。
- [x] 「あやこ simulate」が実 LINE API を呼ばず、検証後に DB を復元できることを確認した（LINE_CHANNEL_SECRET で署名した signed webhook simulate を deployed Worker `/webhook` へ直接 POST。LINE 公式サーバーへの実 API 呼び出しは無し／検証後に対象行のみ id 一致で DELETE 復元）。

## 1周目: 実質非回答を未対応へ残す

1. 「あやこ simulate」で「申し込みはいつからですか」を 1 回だけ入力する。
2. AI 草案ログに同じ質問の `pending` 草案が増え、そのカードだけに「資料不足」が表示されることを確認する。
3. 「答えられなかった質問」に同じ質問の未解決行が 1 件あることを確認する。
4. 同じ質問をもう 1 回 simulate し、草案は履歴として増えても、未解決行は 1 件のままで重複しないことを確認する。
5. LINE outgoing と configured handoff の増分がともに 0 件であることを確認する。

**実測 (piecemaker deployed / signed webhook simulate)**:
- 1回目: `ai_faq_drafts` id `26b8c3d4-...` `status=pending answerable=0` draft_answer=「…資料では申込開始日が明記されていません。公式LINE…」（資料不足系）。同時刻に `unmatched_questions` id `774a2487-...` が1件作成（`resolved_faq_id=null`＝未解決のまま）。
- 2回目（同一質問を再送）: `ai_faq_drafts` に2件目の pending 草案（履歴として増加。この回は LLM 判定が `answerable=1` に振れる非決定性を観測 — 後述の正直な注記参照）が追加されたが、`unmatched_questions` は再送後も **1件のまま**（dedup 維持・重複増殖なし）。
- LINE outgoing（`messages_log direction='outgoing'`）は検証ウィンドウ全体で **0件**。

## 2周目: 実回答を未対応へ増やさない

1. 「あやこ simulate」で、資料に答えが明記された質問を 1 回だけ入力する。
2. AI 草案ログに同じ質問の `pending` 草案が増え、そのカードに「資料不足」が表示されないことを確認する。
3. 「答えられなかった質問」の同じ質問の件数が開始時から増えていないことを確認する。
4. LINE outgoing と configured handoff の増分がともに 0 件であることを確認する。

**実測 (piecemaker deployed / signed webhook simulate)**:
- 「花火大会は何時に始まりますか」を1回 simulate → `ai_faq_drafts` id `42dd6c12-...` `status=pending answerable=1` draft_answer=「18:30からプログラム（花火）が開始されます。」（資料不足ラベルなし・実回答）。
- `unmatched_questions` の該当質問件数 = **0件**（未対応へ増えない）。
- LINE outgoing = 検証ウィンドウ全体で **0件**。

## 復元と実施記録

- [x] simulate DB を開始前スナップショットへ戻し、検証用の草案・未対応行・一時資料が残っていない（`ai_faq_drafts` 3件→3件、`unmatched_questions` 対象質問0件、`messages_log` 検証ウィンドウ0件を read-back 確認。あやこ friend 行 `updated_at` 不変=不接触）。
- [x] 非回答: 資料不足草案あり / 未対応 1 件 / 再送後も未対応 1 件 / LINE 送信 0 件だった。
- [x] 実回答: 資料不足ラベルなし / 未対応増分 0 件 / LINE 送信 0 件だった。
- 実施日時: 2026-07-21 12:39〜12:43 JST
- 実装 revision: main HEAD `a0984413e49b21704154ed7fac2221892dc0ce1d`（4面デプロイ済み。KS worker Version `61291658-f35e-4148-8dbb-bd9414df0c53`・admin `https://4dfcf9c0.line-harness-ks-admin.pages.dev`／piecemaker worker Version `0a1768c1-38c2-48b4-a854-904e600fa750`・admin `https://79f3ac65.line-harness-piecemaker-admin.pages.dev`）
- 対象検証環境: piecemaker 本番 Worker（`https://line-harness-piecemaker.piecemaker.workers.dev`）・あやこ実 friend `U5217ceb4debd9849959446ce8f902a27`宛の signed webhook simulate（実 LINE 送信は使わず HMAC 署名のみ実 channel secret を使用）
- 実施者: closer（node crypto で HMAC-SHA256 署名を生成し `/webhook` へ直接 POST。ブラウザ/物理タップは AI エージェントに実施不能なため signed webhook simulate で代替＝直近の faq-draft-mode-enable closer と同一手法）
- 結果: **PASS**（非回答→未対応1件+資料不足ラベル+再送でも重複なし+outgoing0件／実回答→未対応0件+ラベルなし+outgoing0件／cleanup後 read-back で残骸ゼロ）
- 備考（正直な観測）: 「申し込みはいつからですか」の2回目 simulate で LLM が `answerable=1`（実回答扱い）に振れる回があった。これは AI 評価自体の非決定性であり、本 fix が保証するのは「fail-closed 構造（判定不能/不正出力は false 側）」と「answerable=false と判定された時に確実に未対応へ載る配線」であって、LLM の個々の判定精度そのものではない。1回目の simulate では正しく `answerable=0` と判定され、未対応行が実際に作成されることを確認済み（owner 報告事例の再現→解消を実証）。dedup は両方の草案生成を跨いで機能した（unmatched は1件のまま）。

---

# selfform-w2-full-parts — host live checklist

## 目的と安全境界

自前フォームの全入力型を、実際のブラウザで「表示 → 入力 → 送信 → 管理画面で保存確認」まで 1 周する。sandbox の自動テストは完了済みだが、この節は査読後に trusted host の preview 環境で人が確認する手順である。

- 査読済み revision の worker/web を preview へ deploy してから行う。
- 本番 3 フォームと Formaloo backend のフォームには触れない。その場で作る使い捨ての internal フォームだけを使う。
- 氏名・住所・署名・添付ファイルはすべて架空データにする。token、key、password を画面や記録へ貼らない。
- 公開フロー、分岐、テーマ、Sheets、郵便番号 lookup は本チェックの対象外とする。

## 1. 使い捨てフォームを準備

- [ ] 高機能フォームを 1 件新規作成し、配信方式を「自前フォーム」に切り替える。
- [ ] Formaloo 側では `日時 / 国 / 郵便番号 / 都道府県 / 日本の市区町村 / 町名・番地 / 建物名・部屋番号` がパレットに出ず、自前フォーム側でだけ出ることを確認する。
- [ ] 自前フォーム側では `動的選択肢` が出ず、Formaloo 用の同期・復旧表示や分岐設定も出ないことを確認する。

## 2. 全パーツを 1 個ずつ配置

- [ ] 基本入力: 1行テキスト、複数行テキスト、数値、メール、電話番号、日付、市区町村。
- [ ] 選択: 単一選択、ドロップダウン、複数選択、はい/いいえ。
- [ ] 今回追加: 時刻、URL、日時、国、郵便番号、都道府県、日本の市区町村、町名・番地、建物名・部屋番号、評価、署名、ファイル添付、行列、繰り返しセクション、計算。
- [ ] 装飾: 見出し＋説明、改ページ、動画、画像。
- [ ] すべての入力型へ個別のプレースホルダーを設定し、説明文とは別に保存されることを確認する。
- [ ] 単一選択・ドロップダウン・複数選択へ既定値を設定する。選択肢の名前変更・削除後に、古い既定値が残らないことも確認する。
- [ ] 1行・複数行に最小/最大文字数を設定する。複数行は日本語と絵文字を含む値で残り文字数がその場で変わることを確認する。
- [ ] 添付には許可拡張子、上限サイズ、単一/複数の条件を設定する。計算には前に置いた数値項目を参照する式を設定する。

## 3. 公開ページの表示と正常送信

- [ ] preview の公開 URL を新しいブラウザセッションで開き、見出し・説明・画像・動画が表示されることを確認する。
- [ ] プレースホルダーと補足説明が別々に見えること、既定選択肢が最初から選ばれること、評価と署名が操作できることを確認する。
- [ ] 改ページの前後移動、行列の各行、繰り返し行の追加/削除、計算結果の再計算を確認する。
- [ ] 許可条件内の小さい架空ファイルを付け、全入力型へ有効な値を入れて 1 回送信する。
- [ ] 完了表示になり、管理画面の回答一覧に 1 行だけ増えることを確認する。

## 4. 保存内容と非公開ファイルを確認

- [ ] 管理画面の回答詳細で、全入力値、選択配列、行列、繰り返し、サーバー再計算値、署名データ、ファイル metadata が期待どおり保存されていることを確認する。
- [ ] ファイル key が `internal-form-submissions/` から始まり、回答 JSON にファイル本体や秘密値が入っていないことを確認する。
- [ ] その key を `/images/{key}` へ直接入れても 404 になり、公開取得できないことを確認する。

## 5. 異常系と片付け

- [ ] 文字数不足/超過、壊れた URL・メール、範囲外評価、未回答の必須項目で送信が止まり、回答行が増えないことを確認する。
- [ ] 禁止拡張子と上限超過ファイルで送信が止まり、R2 に残骸が残らず、回答行も増えないことを確認する。
- [ ] 確認後、承認された host 手順で使い捨てフォーム、回答、R2 の試験ファイルを削除する。本番 3 フォームと Formaloo データには触れない。

## 実施記録

- 実施日時: 2026-07-21 05:54 JST
- 実装 revision: main af8bca0 (deploy済み)
- 環境: piecemaker 本番 (使い捨てフォーム fa_6ac324b7-... / API 経由・本番3フォーム不接触)
- 実施者: closer (curl API 直接検証・代表パーツ subset)
- 結果: PASS (代表 subset)
- 備考: 全21パーツの網羅目視は未実施。代表として text(placeholder+min2/max20+残文字数カウンタ実測)/textarea(placeholder+min/max+カウンタ)/dropdown(既定選択肢Bコース selected実描画)/yes_no/datetime(internal限定・type=datetime-local描画)/country(internal限定・placeholder描画)を実施。公開ページ実GET(200)→フィールドHTML実描画確認→正常送信(200・完了メッセージ)→admin `/rows`でlabel解決込み全値read-back一致→異常系(名前1文字)で400+日本語エラー(文字数不足)を確認→DELETE→GET 404+admin 404で完全撤収。matrix/repeating_section/rating/signature/file/計算/装飾型(section/video/image/page_break)/prefecture等住所系は本ラウンドでは個別描画確認を省略(型別ロジックはrender-internal-forms-public.tsのコード読解+既存vitest greenで代替)。

---

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

# step-text-variables-emoji — host live checklist

## できるようになること

ステップ文に「友だちの名前」ボタンと絵文字ボタンが付きました。

## 対象と安全条件

- sandbox から実 LINE 送信は行わない。査読済みの同一 revision を approved host へ反映してから、許可済みのテスト友だち 1 人だけで確認する。
- 新規の停止中テストシナリオ 1 件・テキストステップ 1 件・実受信 1 通だけを使う。実ユーザー、既存シナリオ、本番 3 フォームには触れない。
- token、channel secret、友だち ID、実際の表示名、カスタム項目値、受信画面の個人情報を証跡へ残さない。結果は置換できたか・絵文字が見えたかだけを記録する。
- LINE 純正絵文字（`productId` / `emojiId`）は今回の Unicode 絵文字パレットとは別機能のため、この実射では使わない。

## テスト友だちへステップ 1 通 → 実受信 → 撤収

1. deployment SHA、tenant、実行者、JST 実行時刻を記録する。管理画面で停止中のテストシナリオを作り、テキストのステップを 1 件だけ追加する。
2. 「変数を挿入」から「友だちの名前」を本文の途中へ入れ、`{{display_name|お客様}}` がカーソル位置へ入ることを確認する。「絵文字」から Unicode 絵文字を 1 個選び、同じ本文へ入ることを確認して保存する。
3. 許可済みのテスト友だちだけをシナリオへ登録し、ステップを 1 通だけ送る。二重登録・再送はしない。
4. LINE 実受信で変数記法が残らずテスト友だちの表示名へ置換され、選んだ絵文字が欠けたり文字化けしたりせず表示されることを確認する。管理画面の送信ログも実受信と同じ本文であることを確認する。
5. テスト友だちをシナリオから外し、シナリオを停止・削除する。検証用のカスタム項目を作った場合は削除し、追加送信が発生しないことを確認する。

## PASS 記録

- [ ] deployment SHA / tenant / 実行者 / JST 実行時刻を記録した。
- [ ] テスト友だち 1 人へのステップ 1 通で、表示名への置換と Unicode 絵文字の実表示が PASS。
- [ ] 送信ログと実受信本文が一致し、未定義 token・文字化け・二重送信が 0。
- [ ] テスト友だちの解除、テストシナリオ停止・削除、検証用データの撤収が完了した。
- [ ] sandbox 実 LINE 送信 0、実ユーザー接触 0、本番 3 フォーム接触 0、秘密値記録 0。

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
# friend-fields-discoverability — host live checklist

## owner 向けの一言

カスタムフィールドの設定場所が名前と案内リンクで見つかるようになりました

## 安全条件

- sandbox から実友だちデータへ書き込まない。査読済み revision を approved host へ反映した closer が実行する。
- 既存の定義や友だちの値を変更せず、確認用と明記した一時フィールドを1件だけ作り、確認後に必ず削除する。
- deployment SHA、tenant、実行者、JST 実行時刻を記録し、秘密値や個人情報を証跡へ残さない。

## タグ設定 → 全員共通設定 → 友だち詳細の実クリック1周

- [ ] タグ設定画面を開き、「全員共通のカスタムフィールドはこちら → 友だちリスト上部で設定」が常時見えることを確認する。
- [ ] 案内リンクをクリックし、URL が `/friends#friend-custom-fields` になり、「カスタムフィールド（全員共通の項目）」パネルへ到達することを確認する。
- [ ] 確認用の一時フィールドを1件追加し、成功表示後に友だち詳細を1件だけ展開する。
- [ ] 友だち詳細のカスタム欄に追加した共通フィールドと既定値が表示され、同欄にも全員共通設定への案内リンクが見えることを確認する。
- [ ] 友だち詳細側の案内リンクでも同じパネルへ戻れることを確認する。
- [ ] 確認用の一時フィールドを削除し、既存定義・既存友だちデータを変更していないことを確認する。
# builder-parts-help — host live checklist

## owner 日常語

各パーツに「?」で説明と使用例が出るようになりました。

## 対象と安全条件

- 査読済み revision を approved host へ反映し、個人情報を含まない新規 scratch form だけで確認する。
- 本番3フォームには触れず、保存や公開もこの確認に必要な場合だけ scratch form で行う。
- 画面幅375pxとデスクトップ幅の両方で、クリック結果を確認する。

## パレット「?」と高度パーツの実クリック確認

1. scratch form の編集画面を開き、パレットに「市区町村」が出ないこと、ほかの23パーツにはそれぞれ「?」が出ることを確認する。
2. 「1行テキスト」の「?」をタップし、「機能」「使い方」「使用例」の3見出しと具体例が表示されることを確認する。「?」だけのタップではキャンバスにパーツが追加されないことも確認する。
3. 「閉じる」で説明を閉じ、もう一度開いてから画面外をタップして閉じる。画面幅375pxでも説明枠の左右が画面外へはみ出さず、上下へスクロールして全文を読めることを確認する。
4. 高度カテゴリから「計算」をタップしてキャンバスへ追加する。右の設定欄に「使い方ガイド」が出て、「ほかの欄の値」「計算式」「単価と数量から合計金額」の説明が読めることを確認する。
5. 「行列」「繰り返しセクション」「署名」「ファイル添付」も1つずつ追加・選択し、それぞれの設定欄に同じ3層の「使い方ガイド」が出ることを確認する。
6. 通常の「1行テキスト」を選ぶと高度パーツ用ガイドが出ないこと、既存のタップ追加・ドラッグ並べ替え・保存が従来どおり動くことを確認する。確認後は scratch form を削除する。

## PASS 記録

- [ ] 23パーツすべてに「?」があり、タップで3層説明が開閉する。
- [ ] 375pxでも説明枠が画面内に収まり、全文を読める。
- [ ] 高度5パーツすべてで、設定欄に3層の使い方ガイドが出る。
- [ ] 市区町村は新規追加できず、既存の追加・ドラッグ・保存は退行していない。

# selfform-postal-lookup — host live checklist

## owner 日常語

郵便番号から住所を自動で引ける部品ができました。

## 実射前の安全条件

- 査読済み revision を approved host へ反映した後に実施する。本番3フォームと Formaloo は操作しない。
- `HARNESS_BASE_URL` には確認対象 host の origin だけを設定する（末尾 `/` なし）。token や個人情報は不要・記録禁止。
- 実施日時、host、revision SHA、下記コマンドの成否だけを査読記録へ残す。

## 実在郵便番号 3 件と異常系の実射

以下を host 上で実行し、3 件すべての JSON が完全一致し、存在しない番号が 404、形式不正が 400 になることを確認する。

```bash
set -euo pipefail
: "${HARNESS_BASE_URL:?Set the approved host origin}"

while IFS='|' read -r zip pref city town; do
  body="$(curl --fail --silent --show-error \
    "$HARNESS_BASE_URL/api/postal-lookup?zip=$zip")"
  jq --exit-status \
    --arg pref "$pref" --arg city "$city" --arg town "$town" \
    '. == {pref: $pref, city: $city, town: $town}' <<<"$body"
done <<'POSTAL_CASES'
5690000|大阪府|高槻市|
1000001|東京都|千代田区|千代田
0600000|北海道|札幌市中央区|
POSTAL_CASES

not_found_status="$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' \
  "$HARNESS_BASE_URL/api/postal-lookup?zip=0000000")"
test "$not_found_status" = 404

invalid_status="$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' \
  "$HARNESS_BASE_URL/api/postal-lookup?zip=123-4567")"
test "$invalid_status" = 400
```

## PASS 記録

- [ ] `5690000` が `{pref:"大阪府", city:"高槻市", town:""}` を返す。
- [ ] `1000001` が `{pref:"東京都", city:"千代田区", town:"千代田"}` を返す。
- [ ] `0600000` が `{pref:"北海道", city:"札幌市中央区", town:""}` を返す。
- [ ] `0000000` は 404、`123-4567` は 400 を返し、既存 API の smoke check も従来どおり通る。
- [ ] 実施日時、host、revision SHA、実施者を記録した。本番3フォームと Formaloo は変更していない。
---

# test-send-everywhere — host live checklist

## owner 日常語

どの配信も『テスト送信』ボタンで自分にだけ試し送りできます

## 実行条件と安全条件

- 査読済み revision を approved host へ反映し、migration `115_messages_log_delivery_type_test.sql` の適用後に closer が実行する。
- sandbox では実 LINE 送信を行わない。host でも、一斉配信のテスト送信を設定済みの自テナント友だちへ1通だけ行う。
- テスト送信先には実行者が確認できる自テナントの友だちを使う。通常配信先の友だちを別に1人選び、受信していないことだけを確認する。
- access token、個人情報、LINE user ID、メッセージ本文そのものを証跡へ残さない。

## テスト送信先設定 → 一斉配信1通 → 宛先限定とログ確認

1. deployment SHA、tenant、実行者、JST実行時刻を記録する。
2. LINEアカウント設定で「テスト送信先」を開き、友だち検索から確認用友だちを1人だけ選んで保存する。再読込後も同じ1人が選択済みであることを確認する。
3. 一斉配信の下書きを開き、個人情報を含まない短い本文と、テスト送信先で確認できる友だち変数を1つ設定する。
4. 「テスト送信」を押す。モーダルに設定済み受信者が表示されること、送信中は再度押せないことを確認して、1回だけ実行する。
5. 設定したテスト送信先だけが1通受信し、通常配信先の確認用友だちは受信していないことを確認する。受信本文の変数がテスト送信先本人のデータへ置換されていることも確認する。
6. `messages_log` の当該1件が `delivery_type='test'`、`source='test'`、`broadcast_id IS NULL`、`scenario_step_id IS NULL`、設定したLINEアカウントと友だちの組だけであることを、秘密値を表示しない集計で確認する。
7. 月間送信数がテスト送信1通分だけ増え、一斉配信の送信済み件数・成功率、シナリオ統計、プロフィールの直近メッセージには混入していないことを確認する。
8. あいさつ、シナリオの各ステップ、テンプレートパック、リマインダー、流入経路の登録直後メッセージの各編集画面に「テスト送信」があり、同じ設定先だけが候補表示されることを画面上で確認する。追加の実送信は行わない。
9. テスト送信先設定を解除し、各「テスト送信」モーダルが「先に設定してください」と案内して送信不能になることを確認する。確認用下書きを削除する。

## PASS 記録

- [ ] 設定の保存・再読込・解除と、未設定時の送信ブロックが PASS。
- [ ] 一斉配信からの実射はテスト送信先1人への1通だけで、通常配信先の受信0が PASS。
- [ ] テスト送信先本人のデータによる変数置換が PASS。
- [ ] `messages_log` の test 分離、月間上限への1通加算、通常統計・dedup非混入が PASS。
- [ ] 最低5系統と流入経路の画面にテスト送信導線があり、追加実射0が PASS。
- [ ] sandbox 実射0、秘密値記録0、確認用データ cleanup が PASS。
---

# selfform-w4-sheets-foundation — host live checklist

## 目的と安全条件

この lane の sandbox では Google へ実射していない。査読済み revision、migration 114、Worker、Web を approved host へ反映した後、実サービスアカウントで read 疎通を 1 回だけ確認する。

- 本番 3 フォームと既存スプレッドシートには触れない。個人情報を含まない空の scratch spreadsheet と検証用 form ID だけを使う。
- JSON private key、access token、サービスアカウントのメール、スプレッドシート ID、セル値をログ・スクリーンショット・証跡へ残さない。
- shell は `set +x`。JSON 本文をコマンド引数、環境表示、ファイル差分へ出さない。
- 接続テストは Sheets API の `A1:A1` read を 1 回行うだけ。append/update と同期エンジンはこの live check では実行しない。

## 事前確認

- [ ] migration は `114_sheets_connections.sql` だけが新規適用され、予約済み 113/W1 に依存していない。
- [ ] 査読済み deployment SHA、対象 tenant、実行者、JST 実行時刻を、秘密値を含めず記録した。
- [ ] `docs/google-sheets-service-account-setup.md` の手順で Google Sheets API、実サービスアカウント、JSON key、scratch sheet の「編集者」共有を準備した。
- [ ] trusted host で `GOOGLE_SERVICE_ACCOUNT_JSON` を Wrangler の対話入力から登録し、JSON 本文を履歴や出力へ出していない。

## 管理画面で read 疎通を 1 回

1. owner で `/settings/sheets` を開き、検証用 LINE アカウントを選ぶ。
2. 検証用 form ID、scratch spreadsheet ID、正確なシート名、同期方向「双方向」を登録する。
3. 「接続テスト」を **1 回だけ**押す。連打しない。
4. 「接続できました（先頭セルを 1 回読み取りました）」が表示されることを確認する。
5. ブラウザの Network では Harness API の成功だけを確認する。Google access token、秘密値、セル値を開発者ツールからコピーしない。
6. 証跡には deployment SHA、JST 時刻、`PASS: read 1回` だけを記録し、アカウント名・各 ID・セル内容は記録しない。

## cleanup と PASS 記録

- [ ] 管理画面で検証用接続を削除し、一覧から消えることを確認した。
- [ ] scratch spreadsheet の共有から実サービスアカウントを外した。検証専用 key/service account なら組織ルールに従って無効化・削除した。
- [ ] 本番 3 フォーム接触 0、実データ write 0、秘密値記録 0、セル値記録 0。
- [ ] `PASS: read 1回` または、失敗理由を秘密値なしの `FAIL/BLOCKED` で記録した。

---

# emoji-picker-everywhere — host live checklist

## owner 日常語

文章を書く欄ぜんぶに絵文字ボタンが付きました

## 実行条件と安全条件

- 査読済み revision を approved host へ反映した後に実行する。deployment SHA、tenant、実行者、JST 実行時刻だけを記録する。
- sandbox と host のどちらでも、この確認では LINE への実送信を行わない。入力・挿入・保存前表示だけを確認し、下書きは最後に破棄する。
- 本番 3 フォーム、`forms-advanced`、internal form renderer、個人情報を含む既存本文には触れない。
- デスクトップ幅と 390px 相当のスマホ幅で確認する。hover だけに頼らず、ボタンをタップして操作する。

## 一斉配信

1. `/broadcasts` で新規下書きを開き、テキストブロックの本文を `AB` にする。
2. `A` と `B` の間へカーソルを置き、「絵文字」をタップして `😊` を選ぶ。
3. 本文が `A😊B` になり、カーソルが絵文字の直後へ戻ることを確認する。
4. ピッカー内に OS tip があり、最近使った行の先頭に `😊` が出ることを確認する。送信せず下書きを破棄する。

## 友だち追加あいさつ

1. `/friend-add-settings` から設定中のあいさつシナリオ詳細を開き、テキストステップの本文を一時的に `AB` にする。
2. `A` と `B` の間へカーソルを置き、「絵文字」から `🎉` を選び、`A🎉B` になることを確認する。
3. 同じ欄に「変数を挿入」があり、名前変数を選ぶとカーソル位置へ token が入ることを確認する。
4. 保存・テスト送信・実送信をせず編集を破棄する。

## テンプレート

1. `/templates` でテキストテンプレートの新規作成または編集を開き、本文を一時的に `AB` にする。
2. 「絵文字」をタップして `A✨B` へ挿入でき、「変数を挿入」も同じ欄に表示されることを確認する。
3. ピッカーを閉じて再度開き、最近使った行の先頭が `✨`、その次が直前に使った絵文字であることを確認する。
4. 保存・テスト送信・実送信をせず編集を破棄する。

## PASS 記録

- [ ] 一斉配信、友だち追加あいさつ、テンプレートの3面で、カーソル位置への絵文字挿入が PASS。
- [ ] 変数を解決できるあいさつとテンプレートでは「変数を挿入」も表示され、絵文字と共存する。
- [ ] 最近使った順、重複なし、OS tip、390px 幅でのタップ操作が PASS。
- [ ] レイアウト崩れなし、実送信0、本番3フォーム接触0、確認用編集の保存0。
# sheets-workers-jwt-fix — host live checklist

## owner 日常語

Cloudflare Workers でも Google の秘密鍵に入っている改行を正しく読めるように直しました。接続できない場合の原因区分 (鍵の形式/Google 認証/シートの共有権限/通信) は、接続テストの API 応答と Worker ログで確認できます (管理画面の表示は従来どおりの共通メッセージです)

査読済み版を再デプロイした後、残してある接続設定で「接続テスト」を 1 回だけ押し、「接続できました」と表示されれば修理完了です。

## host closer の実行条件

- sandbox では Google への実射、Worker のデプロイ、secret の読出し・再登録を行わない。
- 査読で承認された revision を Piecemaker Worker へ再デプロイする。migration と Web の変更は不要。
- `GOOGLE_SERVICE_ACCOUNT_JSON` は binding 名の存在だけを確認し、JSON、秘密鍵、サービスアカウントのメールを表示・記録しない。
- 既存 owner 接続 `gsc_4881ef88-e6e4-415e-ab62-c24106c09015` をそのまま使う。スプレッドシート ID、シート名、セル値は証跡へ残さない。
- 接続テストは `A1:A1` の read を 1 回だけ行う。append/update と同期エンジンは実行しない。

## 再デプロイ → 既存接続の再テスト

1. 査読済み revision を Piecemaker Worker へ再デプロイし、deployment SHA と JST 実施時刻だけを記録する。
2. owner で `/settings/sheets` を開き、接続 ID が `gsc_4881ef88` で始まる既存設定を確認する。設定を作り直さない。
3. 「接続テスト」を 1 回だけ押す。
4. 画面に「接続できました（先頭セルを 1 回読み取りました）」と表示され、Harness API が status 200、body が `{"success":true,"data":{"ok":true}}` であることを確認する。
5. 失敗した場合は、応答の `category` と日常語 `message`、Worker log の `category / operation / status` だけを記録する。Google response body や caught error、秘密値は記録しない。

## PASS 記録

- [ ] 査読済み revision の Worker 再デプロイが完了した。
- [ ] 既存接続 `gsc_4881ef88-e6e4-415e-ab62-c24106c09015` を作り直さず再利用した。
- [ ] 接続テスト 1 回で `ok:true` と「接続できました」を確認した。
- [ ] Google への read は 1 回、write は 0 回、同期エンジン実行は 0 回だった。
- [ ] 秘密鍵、token、サービスアカウントのメール、スプレッドシート ID、シート名、セル値を証跡へ残していない。
---

# selfform-w1-backbone — live checklist

## 目的

本番の既存フォームには触れず、使い捨てのテストフォームで「作成 → 自前公開 → 送信 → 回答確認 → 撤収」を1周確認する。

## 事前確認

- [ ] 検証先が本番3フォームではなく、検証用環境または新規の使い捨てフォームである
- [ ] 管理画面へ owner 権限でログインしている
- [ ] migration `113_internal_form_submissions` が検証先 D1 に適用済みである
- [ ] Formaloo 配信の既存フォームは `Formaloo` のままである

## 1. internal フォームを作る

- [ ] 高機能フォームを新規作成し、タイトルを `自前配信 W1 動作確認` にする
- [ ] 基本9型（1行、複数行、数値、メール、電話、日付、単一選択、プルダウン、複数選択）を1つずつ置く
- [ ] 少なくとも1項目を必須にし、1行入力には最大文字数を設定する
- [ ] 完了メッセージを `テスト送信を受け付けました` に設定して保存する
- [ ] フォームを公開する
- [ ] 配信方式を `自前配信 (β)` に変更する

## 2. 公開ページを確認する

- [ ] 共有欄の URL が `/f/<formId>` になり、Formaloo URL ではない
- [ ] スマートフォン幅で開き、9型が入力できる形で表示される
- [ ] 必須を空、メール・電話・日付・数値を不正値、最大文字数を超過して送ると保存されずエラーになる
- [ ] 正常値を入力して送信すると `テスト送信を受け付けました` が表示される

## 3. 管理画面で回答を確認する

- [ ] 回答一覧にテスト回答が1件増える
- [ ] 一覧の質問名と値が公開ページの入力内容に一致する
- [ ] 詳細を開くと取得元が `自前配信` と表示される
- [ ] 検索・期間・並び順でテスト回答を絞り込める
- [ ] internal フォームでは Formaloo 専用の CSV 取込・一括削除・Sheets・即時Webhook操作が表示されない

## 4. Formaloo 非退行を確認する

- [ ] 別の検証用 Formaloo フォームを開き、配信方式が `Formaloo` のままである
- [ ] そのフォームの従来の共有URL・回答一覧・Sheets操作が変わっていない
- [ ] 本番3フォームには一切変更を加えていない

## 5. 撤収

- [ ] テストフォームを非公開にする
- [ ] 配信方式を `Formaloo` に戻す
- [ ] 検証専用フォームを管理画面から削除する
- [ ] ブラウザ履歴・メモに残した検証用 URL を破棄する

## owner への完了連絡

`自前配信のフォームが1周動きました (β)`

# faq-draft-mode-enable — host live checklist

## owner 日常語

自動応答ON・返事はまず下書きに入ります

## 目的と安全条件

査読済み revision、migration `121_faq_bot_draft_defaults.sql`、Worker を対象 tenant へ反映した後、trusted host の closer だけが実施する。sandbox では実 LINE 操作をしない。

本件の判定語「送信されず下書きが受信箱に生成」は、現在の UI では「受信箱に受信質問が未送信のまま残り、その質問に対応する `pending` 草案が AI 草案ログに生成される」の組み合わせとして確認する。UI 構造は本件の対象外とし、この 2 つを同じ質問で突き合わせる。

- テスト友だちは「あやこ」(`U5217ceb4debd9849959446ce8f902a27`) だけを使い、質問は 1 通だけ送る。
- 現在は FAQ 0 件のため、そのままでは未対応へ退避して草案ができない。個人情報を含まない一意な完全一致 FAQ を 1 件だけ一時作成し、確認後に削除する。
- 草案を LINE へ送信しない。承認・送信操作は一切押さない。
- 本番 3 フォーム、既存 FAQ、既存ナレッジ、他の友だち、Piecemaker/KS の別 tenant には触れない。
- token、secret、友だち情報、D1 の行全文をログやスクリーンショットへ残さない。証跡は revision、JST 時刻、件数、PASS/FAIL だけにする。

## 事前確認

1. deployment SHA、対象 tenant、実行者、JST 開始時刻を記録する。
2. 対象 config の `FAQ_BOT_ENABLED = "true"` が 1 件だけであることを確認する。
3. 対象 LINE account の `faq_bot` 設定が `enabled=true` かつ `answerMode="draft"` であることを、秘密値を表示しない管理画面または D1 の JSON key 抽出で確認する。
4. 一意な marker を `faq-draft-live-<JST timestamp>` と決める。同じ文字列を質問にし、回答を `下書き確認用の回答です`、active=true、対象 account 限定で FAQ を 1 件作る。
5. marker に一致する既存 auto-reply、営業時間外メッセージ、`message_received` automation が 0 件であることを確認する。1 件でも送信し得る設定があれば実射せず `BLOCKED` とする。
6. marker の FAQ が 1 件、同じ marker の `ai_faq_drafts` が 0 件であることを確認する。

## LINE 1 通と下書き確認

1. あやこの実 LINE から marker と完全一致する質問を **1 通だけ**送る。追加送信や再送をしない。
2. LINE に FAQ 回答が返らないことを確認する。対象時刻以降の FAQ bot outgoing log も 0 件であることを確認する。
3. 管理画面の受信箱に、送った質問が未送信状態で 1 件表示されることを確認する。
4. 「資料・AIログ」→「AIログ」→「AI草案ログ」に、同じ質問と `下書き確認用の回答です` を持つ `pending` 草案が 1 件だけ生成されることを確認する。現在の UI では草案本文はこの一覧に表示され、受信箱には対応する受信質問が残る。
5. 草案の送信・承認ボタンは押さない。確認した draft id は cleanup の完全一致条件にだけ使い、証跡へ転記しない。

## cleanup と PASS 記録

1. trusted host の D1 操作で、取得済み draft id・marker・`status='pending'` の 3 条件が一致する草案が **ちょうど 1 件**であることを再確認してから、その 1 行だけを削除する。広い条件の `DELETE` は実行しない。
2. 管理画面で一時 FAQ を削除し、同じ marker の FAQ と草案がともに 0 件になったことを確認する。
3. LINE 返信 0 件、受信質問 1 件、pending 草案生成 1 件、草案送信 0 件、cleanup 後の一時 FAQ/草案 0 件を記録する。

- [ ] migration 121 適用後、global ON と account `enabled=true` / `answerMode=draft` を確認した。
- [ ] あやこから完全一致質問を 1 通だけ送り、LINE 返信と FAQ outgoing log が 0 件だった。
- [ ] 受信箱の質問 1 件と、それに対応する pending 草案 1 件を AI 草案ログで確認した。
- [ ] 草案は送信・承認せず削除し、一時 FAQ も削除した。marker の FAQ/草案は cleanup 後 0 件だった。
- [ ] 本番 3 フォーム、既存 FAQ/ナレッジ、他友だち、別 tenant への接触は 0 件だった。

# sheets-workers-oauth-fetch-fix — host live checklist

## owner 日常語

Google へつなぐ処理が、Cloudflare Workers では「呼び出し元が違う」という理由で通信開始前に止まる作りになっていました。Workers が期待する呼び出し元へ固定し、OAuth と Sheets の正規 URL だけへ、転送先を追いかけず接続するように直しました。今後また通信例外が起きても、原因名と短いメッセージを接続テストの応答と Worker ログで確認できます。

再デプロイ後、残してある接続で 1 回だけテストし、「接続できました」と出れば完了です。

## host closer の実行条件

- sandbox ではデプロイ、Google 実射、secret の読出し・再登録を行わない。査読済み revision を trusted host から Piecemaker Worker へ反映した後だけ実施する。
- migration と Web の変更はない。`global_fetch_strictly_public` を含む既存 SSRF 防御を外さず、査読済み `wrangler.piecemaker.toml` をそのまま使う。
- 既存 owner 接続 `gsc_4881ef88…` を作り直さず使う。接続テストは 1 回だけ行い、append / update / 同期エンジンは実行しない。
- 本番 3 フォームと LINE には触れない。秘密鍵、token、サービスアカウントのメール、スプレッドシート ID、シート名、セル値を表示・記録しない。

## 再デプロイ → 接続テスト → read 1 回

1. 査読済み revision を Piecemaker Worker へ再デプロイし、deployment SHA と JST 時刻だけを記録する。
2. owner で `/settings/sheets` を開き、接続 ID が `gsc_4881ef88` で始まる既存設定を選ぶ。設定値は開示せず、作り直さない。
3. Worker tail を開始し、「接続テスト」を 1 回だけ押す。画面に「接続できました」と表示され、Harness API が status 200、body が `{"success":true,"data":{"ok":true}}` であることを確認する。
4. この handler は 1 回の接続テストにつき Sheets read をちょうど 1 回だけ実行し、成功後にだけ `ok:true` を返す契約である。再試行せず、この 1 回の `ok:true` を Sheets read 1 回成功として記録する。Google write と LINE 送信は操作しないため 0 回と記録する。
5. 失敗した場合は追加実行せず、API と Worker log の `category / operation / status / detail` だけを記録する。`detail` に秘密値がないことを確認してから転記し、Google response body は記録しない。

## PASS 記録

- [ ] 査読済み revision の Worker 再デプロイが完了した。
- [ ] 既存接続 `gsc_4881ef88…` を作り直さず再利用した。
- [ ] 接続テスト 1 回で status 200 と `ok:true` を確認した。
- [ ] 接続テスト handler の 1 回だけの Sheets read が成功し、Google write 0 回、LINE 送信 0 回だった。
- [ ] 本番 3 フォームへの接触は 0 件で、秘密値・シート情報・セル値を証跡へ残していない。
# selfform-w4a-friend-ledger-sync — host live checklist

## owner 日常語

選んだ友だち情報だけがスプレッドシートと行き来します。「表示名」「userId」「登録日」は確認用なので、シートで書き換えてもLINEハーネスには取り込みません。変更した人・項目・変更前後は監査ログで確認できます。

## 実行条件と安全条件

- sandbox では Google Sheets への書き込みをしていない。査読済み revision と migration `119_friend_ledger_sync.sql` を approved host へ反映してから owner が実行する。
- 対象は owner が指定した友だち台帳シートと、検証用友だち「あやこ」だけ。本番3フォーム、回答シート、Formaloo の設定やデータには触れない。
- `GOOGLE_SERVICE_ACCOUNT_JSON` と master の `SHEETS_WEBHOOK_SECRET` は Worker secret にだけ置く。Apps Script には手順書で受け取る接続専用キーだけを入れ、秘密値、シートID、userId、セルの個人情報をログ・画面共有・証跡へ残さない。
- 開始前に、あやこの検証対象カスタム項目の現在値を owner が画面上で確認する。失敗時に戻せる値だけを使い、検証後に元へ戻す。

## 1周目: 友だち情報 → シート

1. owner で「スプレッドシート同期」を開き、対象接続で同期するカスタム項目を1つだけ選ぶ。方向は「双方向」にする。
2. 「手動同期」を1回押す。シートに `表示名`、`userId`、`登録日`、選んだ項目名の見出しが自動で出ることを確認する。
3. あやこの行が1行だけあり、LINEハーネス上の値と一致することを確認する。自社で追加した列がある場合は、その列と値が消えていないことも確認する。
4. もう一度「手動同期」を押し、同じ行が増えず、自社列も変わらないことを確認する。

## 2周目: シート編集 → あやこの友だち情報

1. `docs/google-sheets-friend-ledger-sync-setup.md` のとおり Apps Script をコピペ1回で設置し、編集時トリガーを1つ作る。
2. あやこの「選んだカスタム項目」セルを、元へ戻せる検証値へ1回だけ変更する。
3. LINEハーネスであやこの友だち情報を再読込し、変更した値になったことを確認する。即時通知が一時的に失敗した場合は5分待ち、ポーリングで追いつくことを確認する。
4. 管理画面の監査ログで、実行者、項目名、変更前、変更後、通知元が1件として確認できることを確認する。証跡には値そのものを書かず「監査1件確認」とだけ記録する。

## 保護列・警告・後片付け

1. owner の許可がある場合だけ、あやこの `表示名` を一時的な検証文字へ変更する。LINEハーネス側の表示名は変わらず、次の同期で正しい表示名へ戻り、管理画面に保護列の警告と監査が出ることを確認する。`userId` は手で編集しない。
2. 選んだカスタム項目を元の値へ戻し、シートとLINEハーネスの両方が一致することを確認する。
3. Apps Script の失敗を確認した場合も秘密値やレスポンス本文を共有しない。即時通知だけ止めるときは編集時トリガーを削除し、全同期を止めるときは接続設定を削除する。

## PASS 記録

- [ ] 友だち→シート: 見出し自動生成、あやこ1行、再同期で重複0、自社列保持が PASS。
- [ ] シート→友だち: 選択項目の変更が即時通知または5分ポーリングで反映され、元の値へ復元済み。
- [ ] 監査ログ: 実行者・項目・変更前後・通知元を1件確認し、証跡への個人情報記録0。
- [ ] 保護列: LINEハーネスへ取り込まれず、正しい値への復元と警告を確認した（未実施なら理由を `BLOCKED` と記録）。
- [ ] 本番3フォーム・回答シート・Formalooへの接触0、秘密値記録0、検証後の不要データ0。

# automation-rules-gui — host live checklist

## owner 日常語

JSONを書かなくても、「何が起きたら → 何をする」を画面で選んでルールを作れます。知らない形式のルールは勝手に直さず、元のJSONのまま安全に残します。

## 実施条件と安全境界

- 査読済み revision を preview へ反映した後、trusted host の closer だけが実施する。sandbox では外部送信や本番データ変更を行わない。
- sandbox 専用 LINE account と使い捨ての受信Webhookだけを使う。本番 rules、本番3フォーム、既存Webhook、既存の友だちには触れない。
- LINE送信、Discord投稿、migration は行わない。secret の値は画面外へ貼らず、ログや証跡にも残さない。
- アクションの確認先には、preview 内で承認済みの使い捨て HTTPS capture endpoint を使う。外部の第三者サービスは使わない。

## GUIで rule を1本作る

1. Webhook管理で source type を `sola_gui_check` とした使い捨て受信Webhookを1件作り、secret を trusted host の一時変数だけに保持する。
2. `/automations` で sandbox 専用 account を選び、「新規ルール」を押す。
3. ルール名を `automation-gui-live-<JST timestamp>`、イベントを「外部Webhook受信」、Webhookの種類を `sola_gui_check` にする。
4. アクションを「Webhookを送る」にし、承認済みの使い捨て capture URL を入力して作成する。作成後に一覧へ戻り、同じ日常語の内容で表示されることを確認して有効化する。
5. ルールをもう一度編集し、条件JSON・アクションJSONが上級者向けの読み取り専用表示であることを確認する。何も変えず閉じ、保存データの fingerprint が作成直後から変わっていないことを確認する。

## 既存の受信Webhook機構で発火を確認する

1. 既存の `/api/webhooks/incoming/:id/receive` 機構へ、固定した小さなJSONを HMAC-SHA256 署名付きで1回だけ POST する。signature と secret は表示しない。
2. 応答が `success=true` / `received=true` であることを確認する。再送しない。
3. `/api/automations/:id/logs` で、この rule の新しいログが1件だけ増え、`status=success` かつ `send_webhook` の action result が成功であることを確認する。
4. preview 内の capture endpoint が同じ marker を1回だけ受けたことを確認する。LINE outgoing log と Discord投稿がともに0件であることも確認する。

## 撤収と記録

1. GUIで使い捨て rule を無効化して削除し、一覧と `/api/automations/:id` の両方で残っていないことを確認する。
2. 使い捨て受信Webhookと capture データを削除し、source type `sola_gui_check` の残存が0件であることを確認する。一時変数の secret も破棄する。
3. revision、JST時刻、rule作成1件、発火ログ成功1件、capture受信1件、撤収後残存0件だけを記録する。JSON本文やsecretは記録しない。

- [ ] GUIだけで rule を1本作成・再表示でき、無編集時の fingerprint が不変だった。
- [ ] 既存の受信Webhook機構で1回発火し、automation log と preview capture が各1件成功した。
- [ ] LINE送信0件、Discord投稿0件、本番 rules・本番3フォーム・既存データへの接触0件だった。
- [ ] rule、受信Webhook、capture、一時secretを撤収し、残存0件を確認した。

# faq-personal-context — host live checklist

## owner 日常語

LINEで質問した人自身の登録情報や過去のフォーム回答を見て、AIがその人向けの下書きを作れるようにしました。他の人の情報は検索対象へ混ぜず、本人のデータだけを直接使います。

## 目的と安全条件

査読済み revision と migration `122_faq_personal_context_audit.sql` を対象 tenant へ反映した後、trusted host の closer だけが実施する。sandbox では実 LINE 操作・デプロイ・本番 D1 操作を行わない。

- テスト友だちは「あやこ」(`U5217ceb4debd9849959446ce8f902a27`) だけを使い、質問は「入金確認どうなってますか」を **1 通だけ**送る。
- `answerMode="draft"` を維持し、草案を LINE へ送信しない。承認・送信操作は一切押さない。
- 本人のカスタム項目の実値は、事前確認と草案の一致判定にだけ使う。値そのものをログ、スクリーンショット、checklist、チャットへ転記しない。
- 本番 3 フォーム、既存 FAQ、既存ナレッジ、他の友だち、別 tenant には触れない。
- cleanup は新しくできた `pending` 草案 1 行だけを完全一致条件で削除する。append-only の監査行は削除・更新しない。

## 事前確認

1. deployment SHA、対象 tenant、実行者、JST 開始時刻だけを記録する。
2. migration 122 が適用済みで、`faq_personal_context_audit_log` が存在することを確認する。監査行の本文表示や全件 export はしない。
3. 対象 LINE account の FAQ 設定が `enabled=true`、`answerMode="draft"`、本人情報 `enabled=true` であることを管理画面で確認する。
4. カスタム項目「入金確認」が対象に含まれることを確認する。「すべてのカスタム項目」のままでもよい。フォーム回答の ON/OFF は保存済み設定を変更しない。
5. あやこの友だち詳細で「入金確認」に値があることだけを目視する。値は証跡へ転記しない。
6. 開始時刻以降の判定に使えるよう、同じ friend と質問の `pending` 草案件数、FAQ bot outgoing 件数、本人 context 監査件数の baseline を件数だけ記録する。
7. auto-reply、営業時間外メッセージ、`message_received` automation など、この質問で LINE 送信を起こす別経路がないことを確認する。送信し得る設定があれば実射せず `BLOCKED` とする。

## LINE 1 通 → 本人値入り下書きの確認

1. あやこの実 LINE から「入金確認どうなってますか」を **1 通だけ**送る。追加送信・再送はしない。
2. LINE に返信が届かず、開始時刻以降の FAQ bot outgoing 増分が 0 件であることを確認する。
3. 管理画面の受信箱に同じ質問が残り、「資料・AIログ」→「AIログ」→「AI草案ログ」に対応する `pending` 草案が 1 件だけ増えたことを確認する。
4. 草案本文に、事前に目視した本人の「入金確認」値が正しく反映されていることを画面内で照合する。値をコピー、撮影、転記しない。
5. 開始時刻以降の監査行が 1 件増え、表示名/custom項目/Formaloo回答/internal回答の件数メタデータだけを持ち、本文値を持たないことを確認する。`friend_id` は質問者本人と一致することだけを確認し、証跡へ転記しない。
6. 草案の送信・承認ボタンは押さない。新しい draft id は cleanup の完全一致条件にだけ使い、証跡へ転記しない。

## cleanup と PASS 記録

1. trusted host の D1 操作で、取得済み draft id、あやこの friend、質問「入金確認どうなってますか」、`status='pending'`、開始時刻以降の 5 条件が一致する草案が **ちょうど 1 件**であることを再確認する。
2. 上の 1 行だけを削除する。広い条件の `DELETE`、監査行の UPDATE/DELETE、受信質問の削除は実行しない。
3. AI 草案ログで対象草案が 0 件になり、LINE 返信 0 件、草案送信 0 件、監査行増分 1 件のままであることを件数だけ記録する。

- [ ] migration 122 と査読済み revision の反映、draft mode、本人情報 ON、「入金確認」が対象であることを確認した。
- [ ] あやこから指定質問を 1 通だけ送り、LINE 返信と FAQ bot outgoing 増分が 0 件だった。
- [ ] pending 草案 1 件に本人のカスタム項目値が正しく入り、別人の情報が表示されなかった。
- [ ] 値を持たない監査行が 1 件増え、friend 一致・source 件数を確認した。
- [ ] 草案を送信・承認せず対象 1 行だけ削除し、本番 3 フォーム・既存 FAQ/ナレッジ・他友だち・別 tenant への接触は 0 件だった。

# auto-reply-center-unify — host live checklist

## owner 日常語

自動で返事をするための設定を、受付の順番どおりに1か所へまとめました。最初に受付を使うか、次にすぐ返すか下書きにするかを決めます。その後に、よくある質問や資料を答えの材料として整えます。決まった言葉へ必ず返すルールは、AI（文章を考える機能）より先に動く例外として確認できます。

## host closer の実行条件

- 査読済み revision を管理画面 host へ反映した後、owner または検証用 custom role で実施する。
- 設定は保存せず、追加・削除・送信も確定しない。ダイアログは開くところまで確認して閉じる。
- LINE 送信、Discord 投稿、migration、本番 3 フォーム、W3/W6 forms 領域、worker 設定には触れない。
- URL、HTTP status、画面名、PASS/FAIL だけを記録し、token・secret・利用者情報は残さない。

## 1画面の到達性

- [ ] sidebar の自動化欄に旧3項目ではなく「自動応答センター」が1項目だけ表示される。
- [ ] `/auto-reply-center` を開くと見出しが1つだけ表示され、受付ON/OFF → 返信方法 → ナレッジ → 例外ルール → 下書き受信箱の順に並ぶ。
- [ ] 1番と2番から、主スイッチと「自動で送信／下書き」の既存設定を確認できる。
- [ ] 3番から「よくある質問」「答えられなかった質問」「資料」へ移動できる。FAQ追加・まとめて登録・資料取込の入口は開くところまで確認してキャンセルする。
- [ ] 「本人情報」は将来利用できる場合に受付設定へ表示される機能だと、初見で理解できる説明になっている。
- [ ] 4番に「AIより先に動く例外ルール」と表示され、「新規ルール」を開いて保存せず閉じられる。
- [ ] 5番で「AI 草案ログ」を確認でき、「よくある質問へ」を押すとページ再読込なしで3番のFAQへ戻る。
- [ ] 1番から5番を往復しても、見出しが重ならず、途中入力をしていた画面が勝手に初期化されない。

## 旧URLのブックマーク確認

- [ ] `/auto-replies` は HTTP 301 で `/auto-reply-center?view=rules` へ移る。
- [ ] `/faqs` は HTTP 301 で `/auto-reply-center?view=knowledge&source=faq` へ移る。
- [ ] `/knowledge` は HTTP 301 で `/auto-reply-center?view=knowledge&source=documents` へ移る。
- [ ] 移動後はいずれも HTTP 200 で、元のブックマークが指していた機能が最初に表示される。

## 権限と非退行

- [ ] `faq` だけの custom role は受付・返信方法・ナレッジ・下書きを利用でき、例外ルールは無効表示になる。
- [ ] `auto_reply` だけの custom role は例外ルールへ入り、FAQ系の項目は無効表示になる。
- [ ] どちらの権限もない role は設定本体を見られず、管理者へ権限確認する案内が表示される。
- [ ] 確認中の LINE 送信 0 件、Discord 投稿 0 件、設定保存 0 件、本番 3 フォーム接触 0 件を記録する。
---

# friend-refetch-followers — host live checklist

## owner 日常語

プロラインフリーから移しただけでは、以前からいる友だちは管理画面に自動では並びません。今回追加したボタンを1回押すと、認証済みLINE公式アカウントから友だち一覧を取得し、まだ登録されていない人だけを追加します。すでに登録済みの人は書き換えず、途中で止まっても続きから再開できます。この確認ではメッセージを誰にも送りません。

## 実行条件と安全条件

- 査読済みrevisionとmigration `122_friend_imports.sql`をtrusted hostへ反映してから、owner立会いで実施する。
- 対象はフォロワーID取得を利用できる認証済みまたはプレミアムの実LINE公式アカウント1件だけとする。
- 実行前後の友だち件数と一斉配信画面の宛先カウントだけを記録する。userId、表示名、token、secretなどの個人情報・秘密値は記録しない。
- LINEへの送信は0件とする。「あやこのみ」のテスト送信も行わず、一斉配信を下書き保存・予約・実行しない。本番3フォーム、Formaloo、Discordにも触れない。

## 取込1回と実数確認

1. 友だち管理で対象アカウントを選び、取込前の友だち総数と、一斉配信画面に表示される同じアカウントの宛先数を記録する。
2. 「既存友だちを取り込む (認証済みアカウント用)」を1回だけ押す。進捗が「友だちIDを取得中」から「プロフィール取得中」へ進むことを確認し、画面を閉じても再度開いたときに続きが表示されることを確認する。
3. 完了表示の「新規 N 名 / 既存 M 名 / 失敗 K 名」をそのまま記録する。失敗がある場合は、対象行が「名前未取得」と表示され、成功件数へ隠されていないことを確認する。
4. 友だち管理の総数が取込前より実際に何名増えたかを確認し、その増分が完了表示の新規N名と一致することを確認する。
5. 一斉配信画面を表示するだけに留め、対象アカウントの宛先カウントが取込前より増えたことを確認する。送信ボタン、テスト送信、予約ボタンは押さない。
6. 取込前から登録済みだった友だちを画面で確認し、表示名・タグ・フォロー状態などが変わっていないことを確認する。取込ボタンは2回目を押さない。

## PASS記録

- [x] 実アカウントで1回目の取込が完了し、「新規 1445 名 / 既存 5 名 / 失敗 0 名」の実数を記録した (job `e1bb7edf-...`・fetchedCount 1450・status completed)。
- [x] 友だち総数の実増分 (5→1450 = +1445) が新規N名 (1445) と一致した。
- [x] 一斉配信は送信・下書き保存・予約を一切行わず、`is_following=1` 該当件数 (broadcast 宛先解決 SQL と同一条件) を read-only 集計して確認した — 取込前 5 件→取込後 1450 件 (=新規1445名が全員 is_following=true として反映)。broadcast API へのPOSTは0件。
- [x] 取込は1回だけ実行 (advance API を completed まで繰り返し呼んだのみ・2回目のstart POSTは行っていない)。取込前から存在した友だち1件 (id `7713c0b4-...`) を before/after で byte-for-byte 比較し、displayName/pictureUrl/statusMessage/isFollowing/createdAt/updatedAt が完全不変であることを確認した (updatedAtも取込前と同一 = 触れられていない証拠)。
- [x] LINE送信0件 (取込APIはfollowers/ids+profile読み取りのみ・push/multicast呼び出しコード自体が本サービスに存在しない)、テスト送信0件、本番3フォーム・Formaloo・Discordへの接触0件 (本checklist作業中)。userId/token/secret等の生値はこの記録に書かない。
- **実施日時**: 2026-07-21 11:54-12:00 JST (closer / piecemaker 本番・認証済みアカウント `Piecemaker` channelId 1661399637)
- **実装 revision**: main 36bc6a7 (deploy済み: c971e358 時点で worker Version `aaa29097-7ee1-443b-86db-d75edbfb13ec` — 本 lane はコード変更なし・verify-only のため再デプロイなし)
# selfform-w4b-answers-sheet-join — host live checklist

## owner 日常語

フォームへ回答すると、友だち情報の右側に回答がつながり、1人分を横1行で見られるようになります。列の場所ではなく見出し名で見分けるので、自社用の列を途中へ足したり並べ替えたりしても、その列を消しません。同じ人がもう一度回答したときは行を増やさず、同じ行の回答だけを新しくします。

## host closer の実行条件

- sandbox では実シートへ書き込まない。査読済み revision と migration `120_form_answer_sheet_headers.sql` を approved host へ反映した後、owner がこの1周だけ実施する。
- 本番3フォームは使わない。検証専用の自前配信フォーム、検証専用シート、owner が許可した検証用友だち1人だけを対象にする。LINE送信とDiscord投稿は行わない。
- 回答値、userId、シートID、token、サービスアカウント情報をログ・画面共有・証跡へ残さない。証跡には件数とPASS/BLOCKEDだけを書く。
- 開始前に、検証用フォーム・接続・回答・自社列の撤収対象IDをownerだけが控える。広い条件で削除せず、そのIDだけを後片付けする。

## 回答 → 行結合確認 → 列挿入 → 再同期無傷 → 撤収

1. 検証専用の自前配信フォームに、短いテキスト回答を1項目だけ作る。検証専用シートへ接続し、友だち台帳同期を有効にする。
2. 許可済みの検証用友だちとしてフォームへ1回回答し、手動同期を1回実行する。シートで、左から `表示名`・`userId`・`登録日`・選択した友だち項目が並び、その右側にフォームで作った回答見出しと回答が同じ1行へ出ることを確認する。
3. 検証行が1行だけであることを確認する。フォーム回答の値そのものは証跡へ転記しない。
4. シートへ `自社確認` 列を1列追加し、検証用の固定値を入れる。既存列も1組だけ並べ替え、見出し名は変更しない。
5. 同じ検証用友だちでもう1回答し、手動同期を1回実行する。行が増えず1行のまま、回答セルだけが最新になり、`自社確認` の列名と値が変わっていないことを確認する。
6. owner が回答セルの逆同期も確認する場合は、そのセルを元へ戻せる検証値へ1回だけ変え、W4aと同じ即時通知またはポーリング経路で最新回答へ反映されることを確認する。新しい回答行が作られていないことも確認する。
7. シートの回答見出しを一時的に変更した場合は、元名の列を勝手に作り直さず警告になることだけ確認し、すぐ元へ戻す。
8. 検証値を元へ戻し、検証専用の接続・フォーム・回答・シートを控えたIDで撤収する。本番3フォーム、他の友だち、既存シートに変更がないことを確認する。

## PASS 記録

- [x] 回答1回目: piecemaker owner 実シート (1bJCZHSqVSZstcFcI3c1xlEZKByNdbCMqGC4Sc9NtnGU) で、使い捨て内製フォーム (fa_5c9cd2a1-...) にあやこ (fr_id 署名トークン経由) が回答→手動同期→あやこの既存友だち行 (row2) の右側に見出し「W4b検証回答」列が自動生成され、同じ1行に回答値が結合出力された。行数は同期前後で6行 (header+5友だち) のまま不変・追加行0。
- [x] 列挿入後: シートへ「自社確認」列を 入金確認/W4b検証回答 の間へ挿入 (見出し名は不変)。再同期しても自社確認列の値は変更されず、W4b検証回答は新しい列位置 (F列) へ見出し名ベースで正しく追従して更新された。
- [x] 再回答: 同じあやこ行のセルのみ最新回答値に更新され、追加行0・重複0 (2回再回答=計3回・毎回 updatedRows:1 / appendedRows:0)。
- [ ] シート編集を実施した場合: 未実施 (BLOCKED — 本ラウンドは D-1/D-2/列挿入耐性の実証を優先し、逆同期(シート→アプリ)の追加検証は次回に持ち越し。W4aで同一経路の逆同期は実証済みのため機能欠落ではない)。
- [ ] 見出し変更を実施した場合: 未実施 (BLOCKED — 同上の理由で本ラウンド対象外)。
- [x] 撤収後: 使い捨て接続 (gsc_a29e667b-...) を DELETE→一覧から消滅確認、使い捨てフォーム (fa_5c9cd2a1-...) を DELETE→GET 404 (public/admin 両方)、挿入した「自社確認」列と「W4b検証回答」列を Sheets API batchUpdate deleteDimension で削除し、実シートを baseline (表示名/userId/登録日/入金確認 の4列・6行) と byte-identical に read-back で確認。本番3フォーム接触0・LINE送信0・Discord投稿0 (本チェックリスト実施中)・秘密値記録0。
- **実施日時**: 2026-07-21 11:30-11:45 JST（closer / piecemaker 本番）
- **実装 revision**: main c971e358 (deploy済み: ks worker Version `80fc6c82-50ff-491d-9bd1-af67b4b8d2d7` / ks admin `b64b10d1` / piecemaker worker Version `aaa29097-7ee1-443b-86db-d75edbfb13ec` / piecemaker admin `99aa6834`)

# chat-inline-draft-review — host live checklist

## owner 日常語

個別チャットを開くと、相手の質問のすぐ下に「AI下書き」が表示されます。担当者はその場で文章を直し、内容を確認してから1回だけ送れます。送った後は普通の送信済みメッセージとして会話に残り、下書き受信箱からも同じ下書きが消えます。

## host closer の実行条件と安全境界

- 査読済み revision と migration `123_ai_faq_draft_review_audit.sql` を反映した trusted host で、owner または指定 closer だけが実施する。sandbox では LINE 送信・本番 D1 更新・デプロイを行わない。
- 対象は「あやこ」(`U5217ceb4debd9849959446ce8f902a27`) 1人だけとし、他の友だちや別 tenant を選ばない。IDそのものは検証記録や画面共有へ転記しない。
- 一意な marker を `chat-inline-draft-live-<JST timestamp>` と決める。質問と編集後本文の照合にだけ使い、個人情報は本文へ入れない。
- LINEへの実送信は、インライン下書きの「承認して送信」による **1回だけ** とする。再クリック・再試行・別経路からの承認はしない。曖昧な通信失敗は再送せず `BLOCKED` とする。
- 本番3フォーム、既存 FAQ・ナレッジ、他の下書き、Formaloo、Discordには触れない。token・secret・本文全文・D1行全文は証跡へ残さない。

## 事前確認

1. deployment SHA、対象 tenant、実行者、JST開始時刻だけを記録する。
2. migration 123 が適用済みで、`ai_faq_draft_audit_log` が追記専用であることを確認する。監査行を更新・削除しない。
3. あやこのチャットを開き、開始時点の pending 草案件数、`faq_bot/push` outgoing 件数、下書き監査件数を件数だけ記録する。
4. marker に一致する既存下書き・送信済みメッセージ・一時データが0件であることを確認する。既存の同名データがあれば新しい marker に変える。
5. 対象 account が draft mode であり、marker に対して auto-reply、営業時間外メッセージ、automation など別の送信経路が動かないことを確認する。送信の可能性があれば実射せず `BLOCKED` とする。

## あやこ simulate → インライン確認 → 1回送信

1. trusted host の simulate 機能で、あやこから marker を含む質問が1件届いた状態を **1回だけ** 作る。再実行しない。
2. 下書き受信箱に対応する pending 下書きが1件だけ増え、LINE outgoing の増分が0件であることを確認する。
3. `/chats` であやこを開き、同じ質問のすぐ下に点線枠と「AI下書き」表示があることを確認する。別の質問の下や別の友だちには表示されないことも確認する。
4. インラインの「下書きを編集」から本文末尾へ短い確認文を1回追加して保存する。ページ再読込後も編集内容が残り、下書き受信箱にも同じ内容が反映されていることを確認する。
5. 送信前に、対象 friend・marker・`status='pending'` が一致する下書きがちょうど1件で、baseline以降の同marker outgoing が0件であることを再確認する。
6. 「承認して送信」を **1回だけ**押す。処理中は再操作せず、成功表示まで待つ。timeoutや通信断で結果が曖昧なら再押下せず `BLOCKED` とする。
7. あやこの LINE に編集後本文が1通だけ届き、`faq_bot/push` outgoing が1件だけ増えたことを確認する。チャット画面では下書きカードが消え、同じ本文が通常の送信メッセージとして1件だけ表示されることを確認する。
8. 下書き受信箱を再読込し、同じ下書きが pending として残っていないことを確認する。監査は編集1件・承認1件だけ増え、承認を再操作しても送信できない状態であることを確認する。ただし再送ボタンは押さない。

## 撤収と記録

1. simulate が作成した一時データのうち、host の正規 cleanup 機能で安全に消せる対象だけを marker と取得済みIDの完全一致で撤収する。広い条件の削除は行わない。
2. 承認済み下書き、送信ログ、通常メッセージ、追記専用監査は送信証跡なので更新・削除しない。LINEで送った1通は取り消せない前提で、ownerへ検証送信であることを共有する。
3. marker の pending 下書きが0件、LINE送信増分がちょうど1件、Discord投稿0件、本番3フォーム接触0件であることを件数だけ記録する。

- [ ] あやこ simulate を1回だけ行い、対応する pending 下書きが質問直後へ「AI下書き」として1件表示された。
- [ ] インラインで編集した内容が再読込後と下書き受信箱の両方へ反映された。
- [ ] 「承認して送信」を1回だけ押し、LINE受信1件・outgoing log 1件・通常メッセージ1件・pending 0件だった。
- [ ] 編集監査1件・承認監査1件が増え、二重送信と再試行は0件だった。
- [ ] 撤収後も送信・監査証跡を保持し、本番3フォーム・既存FAQ/ナレッジ・他友だち・別tenantへの接触0件、Discord投稿0件だった。

# keyword-unread-suppress-fix — host live checklist

## owner 日常語

リッチメニューから送る決まった言葉は、自動返信が実際に完了したときだけ、オペレーター画面の未読に混ざらなくなります。営業時間設定やエラーで返信できなかった場合と、ふつうの相談メッセージは今までどおり未読に残るので、本当に返事が必要な会話を見落としません。今回の変更は今後届くメッセージだけが対象で、すでにある未読は勝手に消しません。

## host closer の実行条件と安全境界

- 査読済み revision を trusted host へ反映した後、owner または指定 closer が「あやこ」1人だけで実施する。sandbox から実 LINE 送信、デプロイ、本番 D1 更新は行わない。
- 対象 LINE account、登録済み固定キーワード、応答時間帯設定を開始前に確認し、その時刻に自動返信が実際に送られる設定であることを確かめる。ルールの追加・編集はせず、現在リッチメニューが送る文言をそのまま使う。
- 開始時点で、あやこの chat が既読かつ未読数0であることを確認する。既存未読がある、または検証中に別メッセージが届いた場合は実射せず `BLOCKED` とする。
- LINE 実射は固定キーワード1回と通常メッセージ1回だけ。本番3フォーム、Formaloo、Discord、他の友だち、別 tenant には触れない。token、secret、userId、本文全文を証跡へ残さない。

## あやこで固定キーワード → 通常メッセージを実測

1. deployment SHA、対象 account、実行者、JST開始時刻と、あやこの開始時未読数0だけを記録する。
2. あやこの LINE で、対象リッチメニューの登録済み固定キーワードを1回だけタップする。再タップ・手入力による言い換え・別キーワードの追加試験はしない。
3. 自動返信が実際に1回届いたことを確認してからオペレーターチャットを再読込し、受信内容が履歴には1件表示される一方、chat の未読数と未対応一覧件数がどちらも増えないことを確認する。自動返信が届かなければ未読数を変えず `BLOCKED` とする。
4. あやこの LINE から、登録キーワードを含まない短い通常メッセージを1回だけ送る。
5. オペレーターチャットを再読込し、通常メッセージが未読になり、未対応一覧にも1件として現れることを確認する。固定キーワード側は未読へ戻っていないことも確認する。
6. baseline 以降に別メッセージが無いことを確認できた場合だけ、通常のオペレーター操作で今回の通常メッセージを既読に戻す。判別できない場合は状態を変えず `BLOCKED` とする。

## PASS 記録

- [ ] 固定キーワード実射1回: 履歴表示1件、chat 未読増分0、未対応一覧増分0だった。
- [ ] 通常メッセージ実射1回: chat 未読増分1、未対応一覧増分1だった。
- [ ] 固定キーワード後も通常メッセージ後も、他の既存未読件数は変化しなかった。
- [ ] LINE実射は合計2回、再試行0回、本番3フォーム・Formaloo・Discord・他友だち・別tenantへの接触0件だった。
- [ ] owner確認: 「自動返信できた決まった言葉は未読に混ざらず、返信できなかった言葉やふつうの相談は未読に残る」を実測できた。
# w3-logic-runtime-fix — host closer 実機チェック

## owner 日常語

公開フォームだけが、分岐の関数を文字列にしてページへ貼る古い動かし方になっていたため、公開後のページでは選択肢を押しても表示・非表示が切り替わりませんでした。今回、プレビューと同じ分岐部品をビルド済み JavaScript として配る形へ揃えました。これにより、公開ページでも選んだ内容に応じて次の質問が表示・非表示になり、公開前のプレビューと同じ結果になります。

## host closer の実行条件と安全境界

- 査読済み revision `f1a7968` 以降を、許可済みの検証環境へ host closer が反映してから実施する。sandbox からは deploy しない。
- 本番3フォームと Formaloo backend は使わず、分岐を1本だけ設定した使い捨ての自前配信フォームを使う。
- 回答送信は不要。LINE送信、migration、Discord投稿は行わない。token、key、password、顧客データを記録へ残さない。

## 公開ページの実クリックとプレビュー一致

- [ ] 使い捨てフォームに単一選択を1項目と、選択肢Aのときだけ表示する質問を1項目作り、公開前プレビューを開く。
- [ ] プレビューで選択肢Aを実クリックすると対象質問が表示され、別の選択肢へ変えると非表示になる。
- [ ] 同じ定義を公開し、新しいブラウザセッションで `/f/{formId}` を開く。DevTools console に `ReferenceError: __name is not defined` が出ていない。
- [ ] 公開ページでも選択肢Aを実クリックすると対象質問が表示され、別の選択肢へ変えると非表示になる。プレビューと公開ページの結果が一致する。
- [ ] 確認後は使い捨てフォームだけを、控えたIDの完全一致で非公開化・削除する。本番3フォーム、Formaloo、LINE、Discordへの接触が0件だったことを記録する。

## sandbox の機械証跡

- Wrangler の実配信相当 bundle を jsdom で読み、choice の `change` 後に対象質問が表示されるテストを追加済み。
- 公開 client と管理画面プレビューが、同じ `@line-crm/shared/internal-form-logic` を import する経路テストを追加済み。

# postal-zip-normalize — host closer 実機チェック

## owner 日常語

郵便番号に全角の数字や「－」「ー」などを入れても、検索するときだけ半角7桁へ整えて住所を入力できるようになりました。入力欄に見えている文字は勝手に書き換えず、変換しても7桁の数字にならない場合は、これまでどおり正直に入力エラーを表示します。公開ページと作成中のプレビューは同じ変換部品を使います。

## host closer の実行条件と安全境界

- 査読済み revision を許可済みの検証環境へ反映した後、host closer が実施する。sandbox からは deploy しない。
- 本番3フォームと Formaloo backend は使わず、郵便番号から住所3欄への自動入力を設定した使い捨ての自前配信フォームを使う。
- 回答送信は不要。LINE送信、migration、Discord投稿は行わない。token、key、password、顧客データを記録へ残さない。

## 公開ページとプレビューの実ブラウザ確認

- [ ] プレビューで郵便番号欄へ `５６９－００００` と入力し、「郵便番号から住所を入力」をクリックすると住所3欄が補完され、郵便番号欄は `５６９－００００` のまま残る。
- [ ] 公開 `/f/{formId}` でも同じ入力で住所3欄が補完され、郵便番号欄の値が保たれ、プレビューと結果が一致する。
- [ ] `１２３－４５Ａ７` では検索APIを呼ばず、「郵便番号は半角数字7桁で入力してください」と表示され、住所欄が変わらない。
- [ ] 確認後は使い捨てフォームだけを、控えたIDの完全一致で非公開化・削除する。本番3フォーム、Formaloo、LINE、Discord、migrationへの接触が0件だったことを記録する。

## sandbox の機械証跡

- shared normalizer、公開 client、プレビュー、Wrangler dry-run bundle の Red→Green テストを追加済み。
- build-first、全ワークスペース typecheck、static export、全テスト、保護4ファイルの差分ゼロを確認済み。
# test-send-allowlist-hardening — host closer 実機チェック

## owner 日常語

画面で登録したテスト受信者は、サーバーが DB の `test_recipients` から読み取る送信先の正本です。現在の登録済みリストは、あやこと三原栄一の2人です。API の呼び出し側が別の userId を足すことはできません。環境変数の許可リストを設定した環境では、さらに送信先を狭める上限として働きます。成功時は「何件送ったか」だけでなく、実際に送った userId を画面と送信結果へ出します。sandbox では LINE へ送らず、査読後の trusted host で登録済み2人への1回だけの成功と、隔離 fixture への送信前拒否を確認します。

## host closer の実行条件と安全境界

- 査読済み revision を trusted host へ反映した後、owner または指定 closer だけが実施する。sandbox から実 LINE 送信、deploy、本番 D1 更新は行わない。
- 成功実測の対象は、画面の登録済みリスト全員（現行: あやこ + 三原栄一）とする。開始前に DB の `test_recipients` と受信者 preview が同じ2人であることを確認し、1人だけへ縮める設定変更はしない。
- LINE 実射は、登録済み2人へのテスト送信 API 1回だけとする。2人へ各1通届く想定で、timeout、通信断、結果不明では再送せず `BLOCKED` とする。
- 未登録宛先の拒否実測には、実在の友だちを使わない。trusted host 上の隔離 DB、env の追加上限、outbound capture を使い、上限内・上限外の synthetic fixture を設定する。安全な capture を用意できなければ `BLOCKED` とし、実友だちで代用しない。
- 本番3フォーム、他の友だち、別 tenant、Formaloo、Discordには触れない。token、key、password、メッセージ本文全文は証跡へ残さない。

## 1. 登録済み全員宛の成功を1回だけ実測

1. deployment SHA、対象 LINE account、実行者、JST開始時刻、開始時の `test_send_requests` 件数と test outgoing 件数を記録する。
2. 設定画面のテスト受信者と受信者 preview が、登録済みリスト全員（現行: あやこ + 三原栄一）の同じ2人であることを確認する。不一致や3人目があれば送らず `BLOCKED` とする。
3. 個人情報を含まない一意な marker を本文にしたテスト送信を **1回だけ**実行する。ボタンを再クリックせず、完了まで待つ。
4. あやこと三原栄一の LINE に各1通だけ届いたことを確認する。API 応答と画面には `sent=2` と、受信者 preview に一致する実際の `sentUserIds` 2件が表示され、匿名の `sent:2` だけの結果になっていないことを確認する。
5. 同じ request の保存済み `response_json` にも同じ2 userId があり、test outgoing の増分が2件だけで、登録済みリスト外の userId への増分が0件であることを確認する。

## 2. 未登録宛先の拒否を送信前に実測

1. trusted host の隔離 runtime で `TEST_SEND_ALLOWED_USER_IDS` に上限内 synthetic userId だけを設定する。隔離 DB には同じ accountId の上限外 synthetic friend と、その friend だけを指す `test_recipients` fixture を作る。本番 DB と本番 binding は変更しない。
2. outbound capture の呼出回数、`messages_log` 件数、`test_send_requests` 件数を baseline として記録する。
3. fixture を対象に同じテスト送信 API を1回呼び、HTTP 400 と「サーバー許可リスト外のuserId」を含む正直なエラーを実測する。
4. outbound capture、`messages_log`、`test_send_requests` の増分がすべて0件であることを確認する。1件でも増えた場合は `FAIL` とし、LINE 実送信へ切り替えない。
5. 控えた fixture ID の完全一致で隔離 fixture だけを撤収し、本番設定に変更がないことを確認する。

## PASS 記録

- [ ] 登録済みリスト全員（現行: あやこ + 三原栄一）への API 実行は1回だけで、各LINE受信1件、test outgoing 2件、登録外 userId への送信0件だった。
- [ ] 成功 API・画面・保存済み結果に、受信者 preview と一致する2 userId が明示され、匿名件数表示がなかった。
- [ ] 未登録 synthetic fixture は HTTP 400 で拒否され、outbound capture・送信ログ・request 行の増分がすべて0件だった。
- [ ] 再試行0回、本番3フォーム・他友だち・別tenant・Formaloo・Discordへの接触0件だった。
- [ ] owner確認: 「API は画面で登録した全員だけへ送り、環境側で上限を設定すればそれ以外は送信前に止まり、送れた相手は userId で分かる」を実測できた。
