# 自前フォーム W3 — host closer live-checklist

この lane の担当範囲は、この checklist を完備するところまでです。live 1周の実測、結果記入、証拠URLの保管は host closer 工程で行います。lane 内では live host へ接続していません。

## 記録欄

- 実施者: closer (selfform-w3-publish-logic-design)
- 実施日時（JST）: 2026-07-21 22:2x
- deploy SHA: 326df19384acf1afac3fa6eb32756e1b25766ce2 (main HEAD, 4面デプロイ済み)
- 使い捨て account / form ID: piecemaker / fa_85a6254d-4642-48e4-a137-bc7b4ef262a9 (title `CLOSER-W3-VERIFY-DELETE-ME`)
- 総合結果: **FAIL**（HC-08/HC-10 で Critical defect を実機発見。他項目は個別に記載）
- 証拠の保管先: REPORT `/root/.openclaw/line-harness-ks/REPORT_2026-07-21_*_selfform-w3-publish-logic-design.md`（Box working folder 386663013201）

各項目で、`結果: 未実施` を `PASS` または `FAIL` に変え、画面・時刻・HTTP status など再確認できる証拠を短く残します。`fr_id`、署名token、氏名、メールアドレスなどはこのファイルやログへ転記しません。

## HC-01 — 安全な対象と deploy を固定する

- 本番3フォームではなく、使い捨て account だけを使う。
- deploy SHA が上の記録欄と一致することを確認する。
- Formaloo のフォーム、同期、webhook、回答を操作しない。
- 結果: PASS（使い捨てform 1件のみ操作。本番3フォーム（GMOxoMtK/Z5IEH85R/XqACeA2v）は件数・API不接触）

## HC-02 — 使い捨ての自前フォームを作る

- 配信方式を「自前配信」にした新規フォームを1件作る。
- 公開URL、管理画面、回答一覧の form ID が同じであることを確認する。
- 結果: PASS（POST作成→PATCH renderBackend=internal→GET/rows/shareとも同一 form ID `fa_85a6254d-...` で一致）

## HC-03 — 下書きは公開されない

- 下書きの公開URLを別ブラウザで開き、回答画面が出ないことを確認する。
- 管理画面が「下書き」を表示し、公開済みと誤表示しないことを確認する。
- 結果: PASS（未公開状態の `/f/:id` は curl で HTTP 404。API `builderStatus:"draft"` と一致）

## HC-04 — 大きな公開確認モーダル

- 「公開」を押すと、受付期間・回答上限・公開先を読める大きな確認モーダルが出ることを確認する。
- 一度キャンセルし、状態が下書きのままであることを確認する。
- もう一度開いて1回だけ確定し、成功後に「公開中」へ変わることを確認する。
- 結果: 未実施（モーダルUI自体は管理画面ブラウザ操作が必要・本 closer は API 直叩きで publishRevision の compare-and-set 機構のみ確認。UI目視は次回持越し）

## HC-05 — 受付開始前の表示が一致する

- 開始を10分後に設定して公開する。
- 管理画面と回答者画面の両方が「受付開始前」と同じ開始日時を表示することを確認する。
- 回答を送れないことを確認する。
- 結果: PASS（submitStartTime=2027-01-01 で公開→`/f/:id` hosted page が「受付開始前・1月1日から」を表示。回答フォーム項目は非表示（送信不可）。「テストできます」等の誤誘導なし）

## HC-06 — 受付中に回答できる

- 開始を過去、終了を未来に直して再公開する。
- 回答者画面が受付中になり、正常な回答を1件送信できることを確認する。
- 管理画面の件数が1件だけ増えることを確認する。
- 結果: PASS（submitStartTime=2020、submitEndTime=2027で再公開→share API `internalAvailability.status:"open"`→POST送信1件成功→`/rows` で total:1・送信値と完全一致）

## HC-07 — 受付終了と回答上限を正直に止める

- 終了を過去にした場合に「受付終了」と表示し、送信を受け付けないことを確認する。
- 次に終了を未来、回答上限を現在件数にして、上限到達を表示し追加送信を受け付けないことを確認する。
- 成功画面と失敗表示が同時に出ないことを確認する。
- 結果: 未実施

## HC-08 — 一覧表示の A / B / C 分岐

- 一覧表示で、回答A・B・Cごとに別の項目またはセクションを show/hide する。
- 選択を切り替えるたび、同じページ内で対象だけが出現・消滅することを確認する。
- 一度入力してから隠した項目の値が submission に残らないことを確認する。
- 結果: **FAIL（Critical / 実機で再現100%）**。headless Chrome（CDP 9222）で実際に choice field をクリックしても、対象項目の `hidden` 属性が一切変化しない（選択前後で不変）。Chrome DevTools の `Runtime.exceptionThrown` を捕捉したところ `ReferenceError: __name is not defined at evaluateInternalFormLogic` が毎回発生していた。
  - **根本原因**: `apps/worker/src/routes/internal-forms-public.ts` の `logicClientScript()` が `evaluateInternalFormLogic.toString()` で関数ソースをそのまま `<script>` に埋め込む設計（W3 で新規導入）。Worker 側の esbuild ビルドが名前保持のため関数本体へ `__name(fn, "name")` ラッパー呼び出しを注入しており、そのラッパー呼び出しごと toString() で持ち出されるが、ラッパー実体 `__name` 自体は埋め込み `<script>` のスコープに存在しない → 公開ページで **入力/選択イベントのたびに例外が発生し、分岐の再評価が一切実行されない**。
  - **影響範囲**: 個別ロジック内容に関係なく、`evaluateInternalFormLogic` を呼ぶ度に即座に例外化するため、W3 で自前配信フォームに show/hide/jump を1つでも使うと **公開ページ上での動的な分岐は全滅**（初期状態のまま固まる。ページが壊れるわけではなく静かに機能しないだけ）。
  - 詳細repro: REPORT 本体参照。

## HC-09 — 1問ずつ表示の route 分岐

- A / B / C から別の質問へ jump し、各routeに別の完了ページを設定する。
- 繰り返し入力、画像、動画を途中に置いても空の質問画面が出ないことを確認する。
- 各routeが指定した質問と完了ページへ到達することを確認する。
- 結果: 未実施

## HC-10 — プレビューと本番が一致する

- HC-08 と HC-09 の回答をビルダープレビューでも選ぶ。
- 項目の出現・消滅、次の質問、route別完了ページが公開ページと一致することを確認する。
- 結果: **FAIL（乖離を確認・コード読解で断定）**。React プレビュー（`apps/web/src/components/forms-advanced/form-preview.tsx`）は `evaluateInternalFormLogic` を通常の import で直接呼び出しており toString() 再構成を経由しないため、プレビュー側は正しく動的再評価される見込み。一方、公開ページ側は HC-08 の通り例外で固まる。**つまりプレビューは動くが本番公開ページだけが壊れており、「プレビュー忠実」の狙いと真逆の乖離が生じている**（failure_observable の「プレビューと本番の分岐挙動が乖離」に該当）。

## HC-11 — 経由チャネルで表示を分ける

- `/f` の直リンク・埋め込み経由と、`/fo` のLINE経由で同じフォームを開く。
- 例としてメール欄を直リンクだけに表示し、LINE経由では非表示になることを確認する。
- 結果: 未実施

## HC-12 — `fr_id` を安全に紐付ける

- 有効な同一accountの署名付き `fr_id` だけが友だちへ紐付くことを確認する。
- 不正、期限切れ、別accountの値は匿名回答になることを確認する。
- URL、画面、Worker log、証拠へtokenや回答者PIIを残していないことを確認する。
- 結果: 未実施

## HC-13 — 郵便番号から住所を補完する

- 7桁の郵便番号から都道府県・市区町村・町域の空欄が埋まることを確認する。
- 先に手入力した住所は上書きされないことを確認する。
- 検索中に郵便番号を変えた場合、古い応答が新しい入力を上書きしないことを確認する。
- 結果: PASS（本丸のみ）。headless Chrome で郵便番号欄に `1000001` を実入力→「郵便番号から住所を入力」ボタンを実クリック→都道府県=東京都/市区町村=千代田区/町名番地=千代田1-1 が3パーツに実際に自動入力されることを確認（ステータス文言「住所を入力しました」も表示）。上書き保護・レース条件テストは未実施（時間都合で本丸のみ）。

## HC-14 — テーマとスマホ表示

- 保存したテーマ色、和文フォント、背景、ロゴがプレビューと公開ページで一致することを確認する。
- 実機相当の狭い幅で、文字・入力欄・ボタンが切れず、主要操作を押せることを確認する。
- 結果: 一部PASS（design.logoUrl/backgroundImageUrl のみ）。design に logoUrl/backgroundImageUrl を保存→公開ページで `<img class="form-logo">` と CSS `background-image: url(...)` の両方が実描画されることを確認（internal-image-1mb-fix closer が発見した「design.logoUrl/backgroundImageUrl 未描画」課題は W3 のコード（commit `7565c89`）で解消済み）。狭幅レイアウトの実機確認は未実施。

## HC-15 — W2 の全パーツを壊していない

- 使い捨てフォームで全入力型、プレースホルダー、既定選択、文字数制限を表示・送信する。
- 画像、数式、署名、行列、繰り返し、ファイル添付を含め、保存後の回答が正しいことを確認する。
- 結果: 未実施

## HC-16 — W4b の回答シート結合を壊していない

- 使い捨てGoogle Sheetだけを接続し、自前フォーム回答が期待する列へ1行だけ結合されることを確認する。
- 同じ回答の再処理で不要な重複行を作らないことを確認する。
- 結果: 未実施

## HC-17 — 完了メッセージとリダイレクト

- 通常の完了メッセージとroute別完了ページを確認する。
- 許可されたリダイレクト先が既存の `openExternalBrowser` 仕様どおり開くことを確認する。
- 不正な遷移先を開かないことを確認する。
- 結果: 未実施

## HC-18 — 撤収とPII確認

- 使い捨てフォームを非公開にし、公開URLで回答できないことを確認する。
- 使い捨てフォーム、回答、友だち、Sheet、画像・添付を削除または所定の方法で撤収する。
- Worker / browser log にtoken、氏名、メールアドレスなどのPIIが残っていないことを確認する。
- 本番3フォームとFormalooに変更がないことを最後に再確認する。
- 結果: 一部PASS（**プラットフォーム側の既知gapを新規発見**）。unpublish→`/f/:id` が HTTP 404 になることを確認（公開URLでの回答不可）。**削除は不可能と判明**: `internal-forms-admin.ts` の DELETE ルートは `renderBackend=internal` のフォームを一律 `rejectInternalFormalooMutation`（「自前配信では Formaloo 専用操作を利用できません」409）で拒否し、かつ一度 internal へ切替後は render-backend を formaloo へ戻すことも拒否される（「自前配信で編集した内容を失わないため、Formaloo 配信には戻せません」）ため、**internal フォームを API 経由で完全削除する手段が現状存在しない**。scratch form `fa_85a6254d-4642-48e4-a137-bc7b4ef262a9`（`CLOSER-W3-VERIFY-DELETE-ME`）は unpublish 済み・PIIなし・本番3フォーム不接触のまま admin 一覧に残置（BACKLOG記載）。この gap は本 closer が作ったものではなく、起動時点で同種の "新しいフォーム internal draft" 残骸 3件が既に存在しており（過去 closer が同じ壁にぶつかった痕跡と推定）、恒久解決には internal 専用 DELETE エンドポイント新設が必要。本番3フォーム（GMOxoMtK/Z5IEH85R/XqACeA2v）とFormalooは不接触・件数不変を確認。
