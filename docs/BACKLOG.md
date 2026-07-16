# BACKLOG — line-harness-ks

案件横断の段階化・owner ゲート・持ち越し項目の単一正典。case の `.plans/` は詳細設計、本ファイルは「次に何を・誰の合図で着手するか」の索引。

---

## scenario-visual-builder — 線で繋ぐストーリーメッセージ（フロー図ビルダー）

計画正本: `.plans/2026-07-12-scenario-visual-builder/{spec,plan,tasks}.md`

owner 要望（2026-07-12）:「線で繋ぐストーリーメッセージの構築もどうなってるか教えて」= ステップ配信シナリオをノードを線で繋いだ図で俯瞰・設計したい。

### Phase1 — 読み取り可視化（backend 無改変・migration なし） ✅ 実装完了（要 review/deploy）
- [x] `scenarioToGraph` 純関数（steps → nodes/edges 正規化・分岐/待機/複数対応）
- [x] 待機ラベル整形を detail-client から共有 util へ切出し（再発明しない）
- [x] 自作 SVG+div 縦型フロー図（trigger/step/goal・順次=緑実線/分岐=琥珀破線・native scroll）
- [x] ノードバッジ（種別/内容要約/待機/到達タグ付与/条件）
- [x] `next_step_on_false` の「条件不成立時」分岐エッジ + ランタイム乖離注記
- [x] `/scenarios/flow?id=`（Suspense-wrap）+ list/detail の入口リンク
- [x] jsdom component/unit test（chrome wedge 代替）
- [x] reviewer 通過 → closer（worktree cherry-pick → main + build + `wrangler pages deploy`）— 2026-07-12 close (scenario-visual-p1)。admin https://line-harness-ks-admin.pages.dev/scenarios/flow?id=<UUID> で稼働中
- **owner ゲート: 不要**（低リスク・read-only・早く見せられる）— Phase1 完了。Phase2 着手は owner の 1 問決定待ち（キャンバス手段）

### Phase2 — 編集ビルダー（web + api.ts 拡張・worker は既存受理で無改変想定）
- [x] **owner 決定（1 問）: 編集キャンバス手段 — 案A確定**「縦フローのまま inline 編集（自作継続・依存ゼロ）」に決定。React Flow 不採用。
- [ ] **[REQUIRED-BACKLOG] slice-2**: node inline 編集 ↔ step CRUD 配線（scenario-flow-view editable 拡張・図上分岐先選択）— 設計正本 `.plans/2026-07-12-scenario-visual-p2-branch/{spec,plan,tasks}.md` T-B1/T-B2。slice-1(2026-07-12 close) で保存経路・runtime・フォーム欄は開通済 → slice-2 は「図上で組める」体験の後継実装
- [x] `apps/web/src/lib/api.ts` の `addStep/updateStep` に condition3列（conditionType/conditionValue/nextStepOnFalse）を追加 — slice-1 T-A4 で完了(additive optional・旧 caller byte 同等)
- [ ] 編集 UX（後方互換 100%・step_order 再採番せず既存 `reorderSteps` を使う）— slice-2 GUI 翻訳層(scenario-branch-compile)で対応
- **owner ゲート**: slice-2 着手可否 1 問（closer REPORT 参照）。編集 UX 方針は slice-2 内で確定

### Phase3 — 分岐拡張（worker + db + web・配信挙動変更＝高リスク） ✅ slice-1 で「起こす」工事 完了（2026-07-12 close / scenario-branch-slice1）
- [x] **分岐ランタイム乖離の修正（RED 先行）** — `apps/worker/src/services/step-delivery.ts:195`。E2E(実SQLite)で RED(A誤配信)→GREEN(B配信正常)実証済。skip/normal 経路は byte 同等・後方互換回帰 green。フォームから分岐欄で組めて実配信で効く状態まで到達
- [ ] 多分岐が要るなら additive migration（branch edge の一般化・複数出力エッジ）— slice-1 は既存 schema(005) の 2 分岐で対応可のため見送り。owner 2 ユースケースに migration 不要と確定済
- [ ] 複数出力エッジ UI — slice-2 (図上編集) の後継範囲
- **owner ゲート**: 済（本番は現状 branch_step_count=0 = 挙動変化対象ゼロで deploy 実施。実運用で分岐を使い始める判断は owner）

### 図ビルダー ⇄ チャット構築（staff-docs-chat Phase2）の役割分担
- 図 = 全体俯瞰・精緻な微修正・検証面。チャット = 自然言語から素早い骨子生成。両者は同一 `scenario_steps` を単一正本として共有（競合しない）。`scenario-graph.ts` の正規化はチャット出力の検証にも再利用可。

### chrome wedge 復帰時の visual-qa 温存項目（R-2 / Phase1 実機検証は封印中）
1. ノード間隔・整列（縦積みの均等さ・座標定数の見た目）
2. 分岐曲線の交差（複数分岐時の琥珀破線が重ならないか・レーン幅）
3. レスポンシブ（狭幅 375px で横スクロール発生時の可読性・折返し）
4. anti-generic 審美（既定フロー chrome 不在・LINE 緑調和・テンプレ感のなさ）
5. native scroll 挙動（Lenis 慣性なし・縦スクロールの素直さ）
6. 長文/多ステップ時の可読性（内容要約の truncate・ノード高さ固定の破綻有無）
- [OPTIONAL-POLISH] 上記 + slice-1(scenario-branch-slice1) の分岐フォーム UI(condition_type/value/飛び先欄)の anti-generic 目視確認を同時に実施
- [OPTIONAL-POLISH] Codex cross-vendor 独立 review（slice-1 は他セッション codex 多重稼働のため DEFER・clean な単独稼働窓が取れた時に任意実施。Claude 独立検証で代替済のため必須ではない）

---

## line-staff-docs-chat — スタッフ用 常駐 RAG チャット + 使い方資料

> Phase 1 (動く常駐チャット plumbing + 高価値 5 章 MVP) の完了時点で、silent drop せずに残作業をここへ退避する。
> 正本の計画 = `.plans/2026-07-12-line-staff-docs-chat/`（spec.md / plan.md / tasks.md）。

### プログラム進捗チェックリスト (P-2)

| # | 項目 | 状態 |
|---|---|---|
| Batch 0 | spike gate (S-1): 既存 Vectorize に sentinel 等値 filter を live 実投げして staff のみ返る実証 | ☐ **infra-ops (次の必須)** — closer live 実証を試行中（本 REPORT で結果確定） |
| Batch 1 | RAG 配線 (T-A1..T-A8): staff corpus 隔離 + 送信ゼロ + fail-closed + route + permission + seed + 予約値拒否 | ☑ 実装 + test green |
| Batch 2 | 常駐チャットパネル UI (T-B1..T-B4): 全ページ mount / grandma UX 床 / 引用 / fail-closed / static export | ☑ 実装 + test green |
| Batch 3 | 資料 高価値 5 章 (T-C1/T-C2): 友だち管理 / 一斉配信 / 組み合わせ配信 / テンプレパック / ステップ配信 + 通し smoke | ☑ 執筆 + lint 0 + local e2e smoke green |
| — | 残章 follow-on (下記「これから書く章」) | ☐ 未着手 |
| — | Phase 2 実装 (チャット→構築) — 設計は spec §6 / plan §8 に作り置き済 | ☐ 設計のみ (実装は次期) |
| — | 物理分離 hardening (別 Vectorize index + 別 D1 table) — owner-optional | ☐ owner 判断待ち |
| — | flag 点灯 (STAFF_DOCS_ENABLED 両面 ON) | ☐ **dark-ship 継続 — owner 合図待ち** |

### 次の必須 = Batch 0 spike (S-1) の live 実証 → flag 点灯の owner 合図
- 実行者 = infra-ops (owner / closer)。KS preview/dev で既存 `ks-knowledge-chunks` に一意 prefix (`__spike__`) の
  試験 vector を upsert → `filter:{line_account_id:'__staff_docs__'}` で staff のみ返る (顧客/global が混ざらない) を実測 →
  finally で `deleteByIds` して共有 index の汚染を 0 に戻す。additive 不能 (物理分離要) と判明したら hardening へ。
  結果は closer REPORT (REPORT_2026-07-12_*_line-staff-docs-chat.md) を参照。
  S-1/O-1 が揃った後は owner が「点灯していいよ」と言うタイミングで `STAFF_DOCS_ENABLED` を両面 ON にして再デプロイ。

### O-1 (positive-path 実証) 完了 (2026-07-12 CLOSED / staff-docs-o1-positive-path)
根因 = Vectorize 未整備時に seed が「成功」に見えて実は 0 件検索可能 (embedStaffDoc の swallow-catch で embedded_at が NULL のまま created=N を返す) → chat は正しく fail-closed で no_evidence。
修正 = seedStaffDocs / seed script に embed 被覆 (embedded / embedPending) を可視化する純 additive 変更。fail-closed・injection 防御・顧客経路ファイル (faq-ai.ts / faq-reply.ts / knowledge.ts / vectorize.ts) は無改変。21/21 test green・tsc 0。
- [ ] **[REQUIRED-BACKLOG] 点灯 gate の正本 = 本番 live positive-path chat 実測**（reviewer 必須申し送り）。`embedPending===0` は点灯前の precheck に過ぎず、queryability の証明ではない (D1 の embedded_at IS NOT NULL ≠ Vectorize 側で実際に検索できる保証)。owner 立会で実際に「根拠あり質問 → status:ok + citation」を本番で確認してから STAFF_DOCS_ENABLED を ON にする。手順は closer REPORT (`REPORT_2026-07-12_*_staff-docs-o1-positive-path.md`) の点灯手順節を参照。
- [ ] **[OPTIONAL-POLISH]** `countStaffEmbedCoverage` (staff-docs.ts) に「embedded_at は D1 側のマークであり Vectorize 側の queryable 保証ではない」旨のコード注記を追加（挙動変更なしの純ドキュメンテーション）。

## これから書く章 (T-C3 / 残章 follow-on batch)

高価値 5 章は Phase 1 で執筆済。以下は follow-on batch として書き足す (silent drop しない)。

- [ ] **タグの絞り込み活用** — タグでしぼって配信/分析する実務パターン (`/tags` + 一斉配信のタグ絞込)。
- [ ] **高機能フォーム** — フォーム作成・回答の見かた (`/forms-advanced` / `/form-submissions`)。
- [ ] **よくある質問 (自動応答) の設定** — FAQ bot の設定・下書き/自動送信の切替 (`/faqs` / account-settings/faq-bot)。
- [ ] **資料・AI ログ (シート連携含む)** — 資料の取込と使用量の見かた (`/knowledge`)。
- [ ] **リッチメニュー** — メニュー画像の作成・切替 (`/rich-menus`)。
- [ ] **リマインダ / 予約** — リマインダと予約まわり (`/reminders` / `/booking/*`)。
- [ ] **キャンペーン (成果まとめ)** — 配信の成果の見かた (`/campaigns`)。
- [ ] 長尾: 個別チャット (`/chats`) / 自動返信ルール (`/auto-replies`) / スコアリング / CV 計測 ほか。

> 執筆基準 (T-C1 と同じ): 非エンジニア向けやさしい日本語・実ページの実確認 (nav 位置 + ボタン label) ベース・
> 禁止語 0 (`node scripts/lint-staff-guide.mjs` で検査)・カタカナ補足。書いたら `node scripts/seed-staff-docs.mjs` で取込む。

## Phase 2 (チャット→構築) 実装メモ (設計は作り置き済)
- 正本 = spec §6 + plan §8 (Intent→Preview(mutation-free)→Execute の 3 層・確認トークン署名/単回/claims/TOCTOU 再確認・
  冪等キー・監査ログ)。配信の作成は **draft 固定** (scheduledAt/scheduled 拒否・cron 自動送信に乗せない)。実装は次期。

## 物理分離 hardening (owner-optional)
- sentinel 方式 (既存 index 共有 + 予約 `__staff_docs__`) は顧客間アカウント隔離と同一信頼モデル。より強い分離が要れば
  別 Vectorize index (`ks-staff-knowledge-chunks`) + 別 D1 table を provisioning (owner_role: infra-ops + 追加コード)。

---

## form-builder-ux — 高機能フォーム / フォームビルダー（DnD・装飾・プレビュー）

🎯 目的: owner（非エンジニア・スマホ多用）が高機能フォームのフォームビルダーで、部品を確実にドラッグで並べ、見出し/説明文で見栄えを整え、作りながらプレビューで見え方を確認して、迷わず公開できる。

計画正本: `.plans/2026-07-16-form-builder-ux/{spec,plan,tasks,BACKLOG-DRAFT}.md`

owner 発注（2026-07-16 08:0x 原文）:「フォームビルダー　ドラッグアンドドロップが出来ない動かない／フォームの装飾がない／プレビューが欲しい」の3症状は forms-advanced/builder.tsx に帰着。

### 進捗チェックリスト

- [x] ① DnD 信頼性（Batch A / T-A1..T-A5）: activationConstraint（マウス distance:8 / タッチ delay:200+tolerance:8）+ 純 resolveDragEnd + DragOverlay（指/カーソル追従）+ ドロップ先ハイライト+挿入プレースホルダ + canvas 外リリースフィードバック / tap-to-add・既存並べ替え・keyboard a11y 非退行。**reviewer PASS (code) + owner スマホ実機スモーク 7項目 OK (2026-07-16「OKでした」) — status: completed**。closer 統合: main commit `6e943b6`（origin+piecemaker 両 push・SHA一致確認済み）・ks/piecemaker 両 admin 再デプロイ済み・両 /login+/forms-advanced 200 実証済み。
- [x] ② 装飾ブロック（Batch B / T-B1..T-B12）: 見出し+説明文（Formaloo meta/section 正規 mapping）+ 改ページ（page_break）+ フォームタイトル/説明のビルダー内編集（Formaloo PATCH）。**reviewer PASS round1 (closer_allowed:true) — status: completed**。closer 統合: main commits `87b4312`/`4bca632`/`f26b1fa` + trailer `6b8ff0f`（origin+piecemaker 両 push・SHA一致確認済み）。post-integration 全4pkg test緑(shared120/db352/worker1713/web795)+tsc rc0+static export rc0。D1 pre-deploy 安全確認(julianday比較)= friend_scenarios due 1件は既知 test fixture(aec2421f)のみ・他0件で deploy 続行。ks/piecemaker 両 worker+両 admin 再デプロイ済み・health 6点 200 実証済み。read-only smoke(fields_list)で title/description 正常反映確認。
- [x] ③ プレビューペイン（Batch C / T-C1..T-C7）: 編集中 HarnessField 列 → 回答フォーム忠実 self-render（10入力型+装飾）・スマホ幅既定（layoutMode/mobile タブ切替）・正直な忠実度注記3点・新規 dep ゼロ。**reviewer PASS round1 + owner スマホ実機スモーク OK (2026-07-16「OKでした」) — status: completed**。closer 統合: main commit `58d2a02` + trailer `75baf23`（origin+piecemaker 両 push・SHA一致確認済み）。post-integration web 806/806 test緑+tsc rc0+static export rc0。worker/shared/db 1バイトも不触（diff機械確認）。ks/piecemaker 両 admin 再デプロイ済み（ks: 058a1c74 / piecemaker: 4a520b9c）・両 /login+/forms-advanced 200 実証済み。D-6 Formaloo疎通 read-only smoke（`/api/formaloo-workspaces/test` dry-run）ok:true 確認。
- [x] 横断（D-1..D-7）: 後方互換100%・全test非退行（806/806）・static export遵守（rc0）・preserve-raw非破壊（Batch B時確認済/本batch非該当）・A→B→C累積統合順（実施順どおり）
- [x] 両テナント適用（dual-push: ks + piecemaker 両 admin 再デプロイ）— Batch A/B/C 全 land 分完了。

**form-builder-ux 案件 全3 batch (A/B/C) owner 確認済み completed 確定（2026-07-16）。**

### 🎯 次の必須（required backlog）
- [x] owner スマホ実機スモーク（R-3 / Batch A）: 375px タッチで「部品を長押し→ドラッグで追加／並べ替え／掴んだ部品が指に追従／置き場所が光る+挿入位置表示／枠外リリースでメッセージ／タップ追加が従来どおり／縦スクロールが死んでいない」7項目を owner が実機確認 → 2026-07-16「OKでした」で Batch A completed に昇格。
- [x] [REQUIRED-BACKLOG] Batch B（装飾+タイトル/説明編集）着工 — Batch A land 後の main から。2026-07-16 closer 統合・deploy・completed。
- [x] [REQUIRED-BACKLOG] Batch C（プレビュー）着工 — Batch B 完了後（装飾型に依存）。2026-07-16 closer 統合・両テナントデプロイ完了・completed。
- [x] owner スマホ実機スモーク（Batch C）: ①フォームビルダーを開く ②部品組立（DnD/タップ追加） ③装飾追加（見出し+説明/改ページ） ④タイトル編集 ⑤プレビュー確認（スマホはタブ切替・見出し/説明文/必須マークが実物イメージで見える）。2026-07-16「OKでした」で completed に昇格。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] sort drag 中に DropPlaceholder が二重表示（cosmetic・機能退行なし・R-3 owner スモークで併せて確認）
- [ ] [OPTIONAL-POLISH] page_break の label が Formaloo round-trip で '' 化（title 未送出・分割線に content なし=視覚影響なし・reviewer round1 申し送り）
- [ ] [OPTIONAL-POLISH] 毎 save の metadata PATCH が title/description 未変更でも発行（T-B7 契約通り・+1 API call/save・ops 上許容・reviewer round1 申し送り）
- [ ] [OPTIONAL-POLISH] `form-preview.tsx` choice/multiple_select の sr-only 「プレビュー 」prefix a11y 冗長性（視覚影響ゼロ・非ブロッカー・reviewer round1 申し送り）

---

## form-design-theme — フォーム全体デザイン（Batch D / テーマ色・カバー・ロゴ）

🎯 目的: owner（非エンジニア）が高機能フォームのフォームビルダー内で、テーマ色・カバー画像・ロゴでフォーム全体の装いを整え、公開ページを自社ブランドの見た目にできる（Formaloo 管理画面を触らずビルダーだけで完結）。form-builder-ux（Batch A/B/C・completed）の後継。

計画正本: `.plans/2026-07-16-form-design-theme/{spec,plan,tasks,BACKLOG-DRAFT}.md` / sidecar: workspace `.ars-state/form-design-theme-sidecar.md`

owner 発注（2026-07-16「第四弾もSolaレーンで進めて」→ 経路A決定 16:5x「従来チェーンで LANE+OFF-LANE 全部」）。

### 進捗チェックリスト

- [x] **D-LANE**（`packages/shared/src/form-design.ts`）: FormalooColorValue 多相型 + `formalooColorToHex`/`hexToFormalooRgba`（RGBA object/JSON文字列RGBA/hex 3形式吸収）+ `FormDesign` 契約(7色役割+テーマ名+ロゴ/カバーURL) + `FormDesignImageUpload` intent 契約(keep/replace/remove) + anti-generic プリセット(`LINE_PRESET_PALETTES`) + `normalizeFormDesign`(whitelist+URL検証) + `MAX_IMAGE_UPLOAD_BYTES`(10MB cap)。shared 137/137 test green。
- [x] **D-OFF-1 デザインパネル UI**: `design-panel.tsx`(新規・プリセット+個別カラー+ロゴ/カバー画像) + `builder.tsx`「デザイン」タブ統合(save/reimport 配線含む) + `form-preview.tsx` 反映 + `formaloo-advanced-api.ts` design 型配線 + `form-builder-client.tsx` design state carry。
- [x] **D-OFF-2 worker 反映/復元**（dual-push 済）: `forms-advanced.ts` PUT save で design 色 JSON PATCH + 画像 multipart PATCH(`applyDesignImages`) + `imageSyncError` out_of_sync surface、`formaloo-design.ts`(push helpers 新設)、`formaloo-pull.ts` extractDesign（pull-key 優先順位: `logo`>`logo_url` / `background_image`>`background_image_url`）、`formaloo-client.ts` multipart requestForm 新設、`formaloo-drift.ts` 6h auto-apply の design carry(gap-check #2 対応・回帰test済)。update 意味論: 未変更=PATCH非送出・不正値=remote非クリア。
- [x] D-OFF-0 色 push 形式 probe: 使い捨てフォーム実測(公開ページ HTML に `theme_color`/`button_color` hex 直埋め込み) → push 形式は hex 文字列で確定。画像は logo/background_image の2枚(multipart replace / JSON null remove / no-op keep)。cover_image は書けない(no-op 実測)ため MVP から除外。
- [x] 後方互換100%(design無しフォームは definition_json に design キー無し=従来byte一致)・preserve-raw非破壊・static export遵守(rc0)・全test非退行(shared137/worker1765+1事前既存flake(password.test.ts・form-design非関与・単体再走で green)/web828・tsc rc0×3)。
- [x] 両テナント適用(dual-push: ks + piecemaker 両 worker + 両 admin 再デプロイ)。

**reviewer PASS Round 2**（Round1 FAIL F1-F4 High → 3 commit 修正 → 全解消・新規Critical 0）。**form-design-theme 案件 owner 確認済み completed 確定（2026-07-16）** — owner がスマホで実機スモークを実施し「OKでした」（form-builder-ux Batch A/C と同型）。

### 🎯 次の必須（required backlog）
- [x] owner スマホ実機スモーク: フォームビルダー →「デザイン」タブ → プリセット選択 or 個別色 → ロゴ/カバー画像設定 → 保存 → 公開ページ URL で色・画像の反映確認。2026-07-16「OKでした」で completed に昇格。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] F5: fieldColor/borderColor がビルダー内プレビュー未反映（公開ページには反映済み=機能欠陥でない・reviewer round2 申し送り）
- [ ] [OPTIONAL-POLISH] F6: 未設定カラーピッカーが #FFFFFF 表示（実効既定は #06C755・cosmetic・reviewer round2 申し送り）
- [ ] [OPTIONAL-POLISH] doc-drift: tasks.md T-A6 文言(textColor:null vs key drop の表現差異)
- [ ] [OPTIONAL-POLISH] `form-preview.tsx` の coverUrl encodeURI hardening（現状で実害なし・防御的強化のみ）

---

## field-help-charlimit — 入力項目の補足説明 + 一行文字数制限（Formaloo 実測の上で正直に縮退）

🎯 目的: owner が各入力項目に補足説明（例:「日中つながる番号をご記入ください」）を添えられ、一行テキストの文字数上限を設定して公開フォームで実効させる。複数行制限・ライブ残り文字数カウンターは Formaloo hosted の制約により静的ヒント + 正直な注記へ縮退する。

計画正本: `.plans/2026-07-16-field-help-charlimit/{spec,plan,tasks,BACKLOG-DRAFT}.md`

owner 差し込み発注（2026-07-16 18:2x 原文）:「フォームビルダーの項目の設定で各項目のラベル名が変更出来るのですがその下にラベルの補足説明が入れれるようにしてほしいのと、文字系の一行テキストと複数行テキストにて文字数制限が可能に出来ることと、入力欄の下に　残り何文字とカウントが出るようにしてほしいのです」

### 進捗チェックリスト
- [x] T-A1 shared: 入力項目 description（補足説明）の型+検証+push+pull
- [x] T-A2 shared: fingerprint 射影に description（非空ガード・後方互換）
- [x] T-A3 web: SettingsPanel「補足説明」欄（全入力型）
- [x] T-A4 web: 最大文字数を一行のみ / 最小文字数欄撤去（OD-2/OD-3 既定）
- [x] T-A5 web: プレビューに description + 最大N文字ヒント + 正直注記
- [x] S-1/S-2/S-3 非退行ゲート（shared 148/148・web 839/839・worker 1766/1766・db 352/352 全green・tsc rc0×2・static export rc0・secret grep clean）
- [ ] R-1 visual-qa-council（プレビュー目視）— chrome-devtools MCP 封印中のため未実施。owner 375px 実機スモークで代替確認待ち。
- [ ] O-1 hosted 実効 confirm（補足説明ラベル下表示 + 一行超過エラー・owner 実機スモーク待ち）
- [x] O-2 dual-push 両テナント + 両 admin/worker 再デプロイ（closer 2026-07-16 実施・health 4点 200）

**reviewer PASS Round 1（差し戻し0）。status: pending_owner_confirmation** — R-1/O-1 は owner 実機スモーク待ち（closer が status: completed に断定しない）。

### 🎯 次の必須（required backlog）
- [ ] owner 実機スモーク: ①項目設定の「補足説明」欄に記入→保存→公開フォームでラベル下に表示されるか ②一行テキストに最大文字数(例10)設定→公開フォームで11文字入れると超過エラーが出るか ③複数行の制限欄・最小文字数欄が消えているか。OK なら completed に昇格。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] builder.tsx コメント「push は最大のみ」が不正確（実際は min_length も push・機能的には byte-invariant no-op で実害なし・reviewer round1 申し送り）
- [ ] [OPTIONAL-POLISH] description が空白のみ(whitespace-only)でも truthy 判定で push/fingerprint に含まれる（軽微な edge case・実害なし・reviewer round1 申し送り）

---

## piecemaker-line-harness — 第 2 テナント（Sukedachi 顧客提供 1 号）+ 双方向伝播体制

🎯 目的: ks と**同一システムをそのまま** Piecemaker (Sukedachi の顧客) 専用インフラで第 2 テナント稼働させ、以後の修正/機能が ks ⇄ Piecemaker で**双方向伝播**する体制を作る。repo/forum は Sukedachi 経路（ks は Ksplanning のまま）。

計画正本: `.plans/2026-07-15-piecemaker-line-harness/{spec,plan,tasks}.md` / sidecar: workspace `.ars-state/piecemaker-line-harness-sidecar.md`

推奨 repo 戦略（planner 確定）: **共有 1 tree → dual-remote mirror**（origin=ksplanning 不変 + 2nd remote=Sukedachi PUBLIC mirror）+ per-tenant config 兄弟ファイル + テナント別挙動は wrangler `[vars]` flag。双方向伝播＝同一 commit を両 remote に push（drift 構造ゼロ）。データ完全分離＝deploy `--config` が指す独自 Worker/D1/R2/Vectorize/Pages/secrets/(CF account)。

**P0〜P6 全完了（2026-07-15）**。P1（repo 戦略配線）+ P2（config+invariant test）+ P3（bootstrap script）+ P4/P4a（CF provisioning + config 実値記入）+ P4b（D1 bootstrap 実行・reviewer PASS・piecemaker-p4b で main 統合）+ P5（secrets 投入 + D1 seed + LINE webhook 配線 + build-env deploy + cutover + smoke）+ **P6（LIFF 配線 + Discord 発注窓口 + ログイン Key 固定）は本 closer 案件（piecemaker-liff-and-forum）で完遂**。稼働中: worker https://line-harness-piecemaker.piecemaker.workers.dev / admin https://line-harness-piecemaker-admin.pages.dev/login。詳細は app-profile `docs/shared-runbooks/app-profiles/line-harness-piecemaker.md`。

### 実装フェーズ（全完了）
- [x] **P0** owner 決定 gate（CF 別アカウント / GitHub 新規 / 履歴込み mirror / LINE credential 受領）— OWNER-DECISIONS.md
- [x] **P1** repo 戦略配線: `ksplanning/line-harness-piecemaker` mirror repo 作成 + remote `piecemaker` 登録 + `verify-tenant-sync.sh` + dual-push（closer 工程で origin+piecemaker 両 push・SHA 一致確認済み）
- [x] **P2** `apps/worker/wrangler.piecemaker.toml`（invariant test 込み・ks 識別子 0 hit）
- [x] **P3** `scripts/bootstrap-piecemaker-tenant.sh`（既知欠陥: guard1 が `_cf_KV` システム表を誤カウント・本 run は scratch-patch で回避・repo 本体は未修理＝次回 fresh-tenant 立ち上げ時に再修理要）
- [x] **P4/P4a** CF リソース provisioning（Worker/D1 `5a12defb…`/R2/Vectorize 1024-cosine-metadata line_account_id/Pages）+ config 実値記入
- [x] **P4b** D1 bootstrap 実行（reviewer PASS Round1・main 統合コミット a15a101）
- [x] **P5** secrets 投入（API_KEY/ADMIN_API_KEY 新規生成・LINE_CHANNEL_ID/SECRET owner 提供・LINE_CHANNEL_ACCESS_TOKEN 発行）+ D1 line_accounts seed（channelId 1661399637）+ owner ID/PASS ログイン作成（login_id=piecemaker-owner）+ webhook 配線・疎通確認（`/webhook` active=true, test 200）+ worker/admin build-env deploy（cutover: crons-empty→steady-state 2 段）+ smoke 全 green（worker/admin/D1 read/ks 非影響）
- [x] **P6** LIFF 配線（liffId `2010719554-oNAvHzEr`・D1 登録・worker/admin 再deploy・smoke 全pass）+ Piecemaker Discord forum bot 新設（フォーラム `1526909290026242138`・operator-console 登録・readiness=ready・ks 混線 0）+ ログイン Key 固定（本番実測 login 200）— closer 案件 piecemaker-liff-and-forum（2026-07-15）で完遂

### 🎯 次の必須（required backlog）
- [x] [REQUIRED-BACKLOG] owner が「piecemaker受付」フォーラムへ最初の投稿 → claim→spawn→reply の live round-trip 実証（`shouldClaim()` が owner ID 送信者のみ claim する設計上、closer/bot 側では実証不能・owner action 待ち）。**実 evidence（2026-07-16 closer backlog-confirm-sweep CO-2 / workspace repo 源・3記録で証明）**: claim=`secretary-ops-ledger.jsonl` event:claimed ownerId 363387444487389196 targetId 1527117273075159050 @2026-07-16T01:01:46.646Z / spawn=`.ars-state/reception-shadow.jsonl` hook:before_dispatch decision:route targetId 同一 @01:01:46.649Z / reply=`.ars-state/secretary-v3/forums/1526909290026242138/events.jsonl` type:secretary_reply @01:02:40.682Z（54秒でround-trip成立）。1通目 09:59:08 はgateway warmup直後でfail-closed(設計どおり)→2通目で成立。owner目視「OKでした」記録あり。
- [ ] [REQUIRED-BACKLOG] BOLT piecemaker-* 6 ファイルの SECRETS-LEDGER.md/escrow-manifest.txt 一括登録（P5 由来のギャップ。FROZEN baseline を歪めないため単独 append せず matched-pair 一括登録の別 case で実施）

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] O-1: `piecemaker.skdcc.jp` 等カスタムドメイン配線（当面既定 URL で稼働・memory sukedachi-domain 戦略: 道具=サブドメイン）
- [ ] Formaloo 連携鍵の後日投入（当面 Formaloo 無しで芯機能稼働）
- [ ] [OPTIONAL-POLISH] bootstrap-piecemaker-tenant.sh guard1 の `_cf_%` 誤カウント欠陥を repo 本体で修理（`AND name NOT IN ('_cf_KV','_cf_METADATA')` を guard1 SQL に追加）
- [ ] FAQ_BOT_ENABLED の owner 立会後 flip（現状 dark-ship "false"）
- [ ] LINE_CHANNEL_ACCESS_TOKEN の長命トークンへの切替（現状 client_credentials 短命 ~30日）
- [ ] scripts/inject-version.ts が repo に存在しない gap の解消（/admin/version が 0.0.0-dev のまま・cosmetic）
- [ ] [OPTIONAL-POLISH] SECRETS-LEDGER.md の pre-existing mojibake クリーン化

> **ks 本番不可触**: 全工程 `--config wrangler.piecemaker.toml`。ks の worker/D1/Pages/webhook/secrets/wrangler.ks.toml は 1 バイトも触らない（additive only・2026-07-15 closer 検証: wrangler.ks.toml diff 0 / runtime source 変更 0 / ks /admin/version 200 を deploy 前後で確認）。

---

## 📅 owner 確定キュー (2026-07-16 16:2x 承認「その順でOKです」) — フォーム強化ロードマップ

発進経路 = Sola レーン (docs/shared-runbooks/sola-lane-submit-line-harness.md・workspace 側)。調査正本 = .plans/2026-07-12-research/{research-formaloo-api-value-max.md,research-form-media-and-edit.md}。

1. [x] **差し込み最優先: scenario-condition-contains** — 分岐条件に部分一致 (タグ名 contains / カスタムフィールド値 contains)。2026-07-16 closer で main 統合 + ks/piecemaker 両テナント dual-push + deploy 完了 (REPORT_2026-07-16_{HHMMSS}_scenario-contains.md 参照)
2. [x] **form-design-theme (第4弾)** — テーマ色/カバー/ロゴ。2026-07-16 closer で main 統合 (fd08a87..0d694f1) + ks/piecemaker 両テナント dual-push + 4 デプロイ (worker×2 + admin×2) 完了。reviewer PASS Round 2 (F1-F4 High 解消済み)。**owner 確認済み completed 確定** — owner がスマホで実機スモークを実施し「OKでした」(フォームビルダー→「デザイン」タブ→プリセット/個別色→ロゴ/カバー画像→保存→公開ページで反映確認)。詳細 REPORT_2026-07-16_190324_form-design-theme.md 参照
3. [ ] **弾 S: form-media-limits + 編集禁止トグル** — file field に「ファイル種類 (画像/書類/動画含む全て) + サイズ上限」設定を追加 (**写真の 2MB 上限もこれで解放**・実測 50MB 受理済・プラン上限は着工時スパイク) + フォーム単位「編集不可」トグル (harness 側列 additive)
3.5 [ ] (弾 S 内 or 直後) スマホ実機でのカメラ/動画選択挙動確認 (browser-evaluator or owner スモーク)
4. [ ] **弾 M: 回答のあと編集** — LINE 経由本人の再入場編集 (fr_id prefill 続き・再提出=新 row・fr_id ごと最新正) + 管理者編集 (着工前に PUT/PATCH rows の半日スパイク必須 — live で 200 なのに反映されない謎の解明)
5. [ ] **弾 L: メール編集 URL (埋め込み式)** — メール送信基盤新設 + 署名付き編集トークン + row_update webhook (sheets-1b の FORMALOO_ROW_UPDATE_ENABLE 設計と束ねて実装)
6. [ ] **お宝 20 件 (owner「絶対です」2026-07-16)** — 残タスク完了後に research-formaloo-api-value-max.md のロードマップ 3 段 (①rating/signature/UTM/画像スパイク/success_page ②計算/行列/繰り返し/choice_fetch/PDF/webhook 即時 ③決済 JPY/lookup/分析/**AI フォーム生成本体 (gpt-image-2 差し込み画像積極活用 = owner 恒久方針)**)

- [x] `apps/web/tsconfig.tsbuildinfo` dangling build cache — 2026-07-16 closer で untrack + `.gitignore` 追加済み (commit 0d694f1)。

> 既存 A〜E 残タスク (立会系/設計済み実装待ち) はこのキューと並行消化。正本の全量棚卸しは 2026-07-16 残タスク sweep (session 記録) 参照。
