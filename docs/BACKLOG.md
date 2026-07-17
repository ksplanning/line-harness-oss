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

## builder-usability — フォームビルダー使い勝手5点セット（owner 実運用フィードバック）

🎯 目的: owner がフォームを作って保存・公開した後、「未同期のまま何をすればいいか分からない」「プレビューで文字数制限をテストしたいのに入力できない」「公開してもテスト方法が分からない」で手が止まらないようにする。

計画正本: `.plans/2026-07-16-builder-usability/spec.md`

owner 実運用フィードバック（2026-07-16 21:1x 原文）:「Formaloo 未同期 のままでどうしたらいいかわからない　同期とかアップロードとかのボタンは無いのかな？　それとプレビューで入力禁止になってるが、文字数制限のテストとかでも使いたいから入力可能にしてほしい　そして保存と公開もしたが、どうやってそれをテストすればいいのか分からない」

### 進捗チェックリスト
- [x] ①「今すぐ同期」ボタン: out_of_sync 時のみ表示・既存 handleSave 再利用（新経路なし）+ 原因/一言ヘルプ表示
- [x] ②プレビュー入力可能化 + 残り文字数ライブカウンター（送信ボタンなし・外部送信経路ゼロ・maxLength 実効）
- [x] ③「公開ページを開いてテスト」導線（公開URLを開くボタン・未公開時は案内）
- [x] ④ワークスペース自動紐付け（孤立フォーム恒久修正・active workspace 1件のみ時自動採用・明示選択/既存 binding 非上書き）
- [x] ⑤公開アドレス正本化（full_form_address を唯一の正本・host推測補完を完全廃止・buildPublicUrl は絶対https以外null）※ closer 独立検証(Codex)で部分ギャップ発見。下記「次の必須」参照
- [x] R-4 read-only regression test 新仕様（入力可・送信不可）へ整合更新
- [x] 後方互換・全pkg test green（worker1789/web871/db352/shared171）+ tsc rc0×4 + static export rc0・両テナント適用

**reviewer PASS Round 1（Critical/High 0・closer_allowed true）。closer 統合: main commit `73766f0`（merge commit・origin+piecemaker 両 push・SHA一致確認済み）。ks/piecemaker 両 worker+両 admin 再デプロイ済み（health 4点 200・⑤回帰 live-check: fa_5127eb98…b0481 の /fo が peace-maker.formaloo.me/puw7lh へ 302 継続確認）。closer 独立検証(Codex cross-vendor)で①③のみ即PASS・②④とR-4はCodexが過度に文字通り解釈した誤検出と closer が判断(コード実読+既存test精査で実質PASS)・⑤に実質的ギャップ1件発見(下記)。**⑤(a) 修正弾 (builder-usability-5a-fix) が commit `6c40ca8` (merge `24b282d`) で main 統合・reviewer PASS Round 1・origin+piecemaker 両 push・SHA一致確認済み・ks/piecemaker 両 worker 再デプロイ済み(health 2点 200)。status: pending_owner_confirmation**（owner 実機スモーク待ちのみ）。

### ✅ 解消済み（要 generator follow-up → 完了）
- **⑤(a) GET フォールバック条件が狭すぎる**: `formaloo-sync.ts:90` の GET 再取得は `if (!publicAddress)`（`full_form_address ?? address ?? null` の結果が両方欠落の時のみ）で発火していた。しかし実際の本番事故シナリオ（`docs/shared-runbooks/app-profiles/line-harness-piecemaker.md` 記載）は「create 応答に `address`(裸コード) はあるが `full_form_address` が無い」ケースであり、この場合 `publicAddress` は裸 `address` で truthy になり GET 再取得が発火しなかった。**builder-usability-5a-fix (commit 6c40ca8) で解消**: トリガーを `if (!form?.full_form_address)` に変更・回帰test追加・reviewer PASS Round 1。

### 🎯 次の必須（required backlog）
- [x] **[REQUIRED-BACKLOG] ⑤(a) GET フォールバック条件修正** — builder-usability-5a-fix commit `6c40ca8` (merge `24b282d`) で消化済み。
- [ ] owner 実機スモーク（⑤修理後）: ①未同期フォームで「今すぐ同期」ボタンが目立って表示され、押すと再送されるか ②プレビューで文字を入力でき、残り文字数カウンターが動くか（送信は相変わらずできない） ③保存・公開後にビルダー上から公開ページを開いてテストできるか ④新規フォームを作って保存したら自動で正しい公開URLが手に入るか（⑤(a)修正の核心確認）。OK なら completed に昇格。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] preview-char-counter の over/赤字分岐は maxLength 属性が入力を物理的に頭打ちにするため到達不能な防御的 dead branch（無害・要修正でない・reviewer round1 申し送り）

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
3. [x] **弾 S: form-media-limits + 編集禁止トグル** — file field に「ファイル種類 (画像/書類/動画含む全て) + サイズ上限」設定を追加 (**写真の 2MB 上限もこれで解放**・実測 API 上限≈100MB受理済) + 動画添付 UI (allowedExtensions 射影) + フォーム単位「編集不可」トグル (harness 側列 additive・inert)。2026-07-17 closer で main 統合 (3885179) + ks/piecemaker 両テナント migration099 適用 + dual-push + 4 デプロイ (worker×2 + admin×2) 完了。reviewer PASS Round1。詳細 REPORT_2026-07-17_{HHMMSS}_form-media-limits.md 参照
3.5 [ ] **[REQUIRED-BACKLOG] O-1 owner 立会 hosted スモーク** — raised max_size + 動画許可 test フォームで実写真 10MB 級・実動画 mp4 を実アップロード → submit → Formaloo 添付表示を owner が確認して初めて「動画OK / NMB上限OK」を確定報告 (コードだけでは hosted 実効を断定していない)。合わせてスマホ実機でのカメラ/動画選択挙動確認も owner スモークで実施
4. [x] **弾 M: 回答のあと編集** — LINE 経由本人の再入場編集 (friend 厳密最新row prefill・再提出=新row・OFF byte同等) + 管理者編集 (PATCH rows/:rowId flat slug body / row_slug 3経路解決 / free-value限定 / persist確認成功のみ mirror更新) + allow_post_edit 実効 gate (form AND env) + 編集履歴最小記録。2026-07-17 closer で main 統合 (343430b) + ks/piecemaker 両テナント migration100 適用 + FORM_POST_EDIT_ENABLED 供給 (両テナント secret) + dual-push + 4 デプロイ (worker×2 + admin×2, health 200) 完了。reviewer R1 FAIL (High2: prefill fail-open PII露出 / row_slug上書き) → R2 5 fix commitsで根治 → PASS。詳細 REPORT_2026-07-17_{HHMMSS}_form-post-edit.md 参照。
4.5 [ ] **[REQUIRED-BACKLOG] O-1 owner 立会 live smoke (弾M)** — closer は本番認証情報(env.API_KEY / staff login)取得が安全ゲート(prod-db-write-gate + auto-mode classifier)で物理 block されたため、以下 3 点の実機実測を **closer では完了できなかった**。owner が admin 画面(https://line-harness-ks-admin.pages.dev)から使い捨てフォームで直接確認するか、closer に一時テスト用ログインを明示発行して再依頼要: ①管理画面で回答詳細を編集→保存→Formaloo row の readable_data が編集後値に一致 ②allow_post_edit=1 フォームへ LINE 本人が再入場すると自分の最新回答が prefill される ③allow_post_edit=0 フォームは編集不可 + prefill 無し。コード側は reviewer R1+R2 (cross-vendor Claude+Codex・adversarial負テスト全pass)で強く裏付け済みだが、実 Formaloo ネットワーク往復の 1 回実測のみ未了。
5. [x] **弾 L: メール編集 URL (埋め込み式) — Phase A** — 署名付き編集トークン + 公開編集ページ (`/fe/:token`) + builder トグル。
   2026-07-17 closer で main 統合 (7d241f8) + ks/piecemaker 両テナント migration101 適用 (additive・TRINA行数不変)
   + `FORMALOO_EDIT_TOKEN_SECRET` 新規生成・両テナント供給 (BOLT escrow: ks `2352160816359` / piecemaker `2352161601197`)
   + dual-push + 4 デプロイ (worker×2 + admin×2, health 200) 完了。reviewer PASS Round1 + Codex 独立検証 8/8 PASS
   (T-A1〜T-C2)。closer live smoke で保存機能の重大バグを発見 (5.0.1 で hot-fix 済 / 下記)。
   `status: pending_owner_confirmation`（deployed `/fe` 経由の完全 round-trip 再現は webhook secret 不所持で
   closer 未達・owner 確認事項として残置。下記 5.0.3）。
   詳細 REPORT_2026-07-17_135634_form-edit-mail-link.md 参照 (box_file_id_md `2352377372517`)。
5.0.1 [x] **弾L save バグ hot-fix + 再検証** — `edit-save-confirm-fix` closer (2026-07-17) で
   `formaloo-public.ts:589` + `forms-advanced.ts:985`(弾M 同型)を `verifyRes.data?.data?.row?.data` に修正 +
   両 route test の stub fetch shape を実API相当に修正 (main 統合 `7326926`)。reviewer Round1 PASS
   (Critical0/High0・RED真正性6/6・独立全再走173files/1888tests green・cross-vendor codex-companion approve)。
   ks/piecemaker 両 worker 再デプロイ (health 200)。closer が本番 Formaloo API に対し独立に PATCH→GET を実行し
   実応答 shape (`data.row.data`) が修正コードの読み先と完全一致することを確認。
5.0.3 [ ] **[REQUIRED-BACKLOG] 弾L T-B2 deployed `/fe` 経由の完全 round-trip smoke** —
   5.0.1 の hot-fix はコードレベル(reviewer 独立検証 + closer の実 Formaloo API shape 直接確認)で強く裏付け
   済みだが、deployed worker の `/fe/:token` GET→PATCH→FRESH-GET を実際に往復させる完全な smoke (本 REPORT の
   smoke (b) と同一手順) は今回未達 — D1 `formaloo_submissions` ミラー行は実 Formaloo webhook (API 作成 row
   には発火しない) 経由でしか作られず、closer には webhook secret への読み出し権限がなく、また本番 D1
   直接書込は安全ゲート(classifier)で明示的にブロックされた。owner が実 LINE/実ブラウザで一度提出→編集URL
   経由の保存を確認するか、closer に webhook secret の限定 escrow を許可すれば再現可能。
5.0.2 [ ] **[次の必須] 弾 L Phase B: メール送付** — 送信完了時に編集用URLをメールで自動送付 (T-D1/T-D2/T-D3/S-4)。
   owner OD-A = Resend 確定済みだが送信元ドメイン DNS(SPF/DKIM/DMARC) 未整備 = infra-ops 工程。
5.3 [ ] **[REQUIRED-BACKLOG] forms-advanced.ts:901 admin prefill endpoint 実測確認** —
   admin GET drill-through `/v3.0/forms/{formSlug}/rows/{rowId}/` (`rowId`=harness id・Formaloo row slug でない)
   を使っており、他エンドポイントの実測知見(form-nested path は Formaloo に存在しない)と同型の疑いがある。
   fail-soft で D1 mirror にフォールバックするため実害はないが、弾M 管理者編集画面の prefill 精度に影響し得る。
   reviewer edit-save-confirm-fix Round1 申し送り。実測 (実 row + 実 admin セッションでの prefill 目視) が必要。
5.1 [ ] **[OPTIONAL-POLISH] choice/dropdown 編集対応 (弾M+)** — 弾M は free-value 型 (short_text/textarea/number/email/phone/date) のみ管理者編集対応。choice/dropdown/multiple_select は choice-slug 解決の仕組みが要るため別弾で choice-slug map を用意して対応 (弾M spec Out-of-Scope 明示済み)。
5.2 [ ] **[REQUIRED-BACKLOG] worker full-suite test isolation 改善** — staff-docs/knowledge cluster の共有 fetch mock/env leak で run 毎に他 case 未 touch のテストが flake する (form-post-edit reviewer R2 で確認・本 case 起因ではない・CI 安定性の恒久課題)。
6. [x] **お宝 20 件 バッチ1 (B1) — rating/signature/video パレット追加**（owner「絶対です」2026-07-16 + 「弾LとB1も続けて進めて」2026-07-17）。research-formaloo-api-value-max.md #1/#7/#13 対象。2026-07-17 closer (treasure-b1-palette) で main 統合 (merge commit `07d1f01`・弾L Phase A `120237b` 後着統合・merge-tree clean 実証) + secret-scan/dep-scan clean + ks/piecemaker 両テナント dual-push (SHA一致確認済み) + 4 デプロイ (worker×2 + admin×2, health 200) + ks admin `/forms-advanced` spot-check (headless chrome 実レンダー・パレットに ⭐評価/🖋署名/🎬動画 3型表示を目視確認) 完了。reviewer PASS Round1 (Critical0/High0・R-2 fingerprint byte不変・region-disjoint 実証)。**status: pending_owner_confirmation**（O-1 owner 立会 hosted スモーク待ち・下記「次の必須」参照）。詳細 REPORT_2026-07-17_{HHMMSS}_treasure-b1-palette.md 参照。残り②③段（計算/行列/繰り返し/choice_fetch/PDF/webhook即時・決済JPY/lookup/分析/AIフォーム生成本体）はバッチ2以降。

6.1 [ ] **[REQUIRED-BACKLOG] B1 owner 立会 hosted スモーク (O-1)** — rating(⭐評価タップ入力) / signature(✍️手書きサイン) / video(🎬動画埋め込み再生) の3型を owner が公開フォームで実際にタップ・手書き・再生し、回答が Formaloo 側(rows/webhook)に到達することを確認して初めて「hosted で動く」を確定する（コードのみでは断定しない = soft-200 回避）。OK なら completed に昇格。
6.2 [ ] **[OPTIONAL-POLISH] video push の `videoUrl ?? ''` defense 強化** — 現状は validate gate 前提で妥当な設計（validate 非経由の直接呼出でのみ空url出得る honest surface）。強化は任意・非ブロッカー（reviewer round1 申し送り）。
6.3 [ ] **[REQUIRED-BACKLOG] お宝バッチ2以降** — バッチ1完了後、research-formaloo-api-value-max.md ロードマップ残り2段 (②計算/行列/繰り返し/choice_fetch/PDF/webhook 即時 ③決済 JPY/lookup/分析/**AI フォーム生成本体 (gpt-image-2 差し込み画像積極活用 = owner 恒久方針)**) に着手。

> **相互参照**: デザイン未設定フォーム（テーマ色/カバー未設定のまま公開）での配色事故（既定色が意図せず視認性を損なう等）は、本案件のスコープ外。**恒久対策は `form-design-presets` 案件で 2026-07-17 closer 完了（下記セクション参照）** — create-seed で既定パレットを自動 seed し、#37352F 同色トラップ（入力欄不可視）を根絶。B1 のパレット追加自体は既存デザイン機構（form-design-theme・completed 済）に影響しない additive 変更。

- [x] `apps/web/tsconfig.tsbuildinfo` dangling build cache — 2026-07-16 closer で untrack + `.gitignore` 追加済み (commit 0d694f1)。

> 既存 A〜E 残タスク (立会系/設計済み実装待ち) はこのキューと並行消化。正本の全量棚卸しは 2026-07-16 残タスク sweep (session 記録) 参照。

---

## 🧭 form-route-branching 後続 (2026-07-16 実装完了・spike T-A0 確定地雷起票)

本案件 (A/B/C ルート分岐 jump + form_type 切替 + choice_slug モデル化) で CLOSE 済 (pending_owner_confirmation)。以下は本案件外の後続:

- [x] **[REQUIRED-BACKLOG] 同一フィールド複数jumpルールの compound 化是正（A/B/C多岐分岐の実機バグ / 2026-07-16 closer O-1 live-check で発見）** — `toFormalooRawLogic()` が同一 `sourceFieldId` の複数ルールを別々の top-level item として push する現行実装は、Formaloo 実本番エンジンで**2番目以降の item の `when` 条件が無視され常に最初の item が適用される誤動作**を実機で確認済み(使い捨てフォーム slug=4DLvHfEF で A/B 2択とも常に最初のルールの飛び先に着地・2回再現)。**単一jumpルール(2択:飛ぶ/飛ばない)は正しく動作**・**同一フィールド内を1つのtop-level itemにまとめ`actions`配列に複数`{action,args,when}`を格納するcompound形にすると正しく分岐する**ことも実機確認済み(修正方針確定済み)。owner の core use case(「Aルート Bルート Cルートのように分ける」)が現状未達のため優先度高。**2026-07-17 closer route-branching-fix で消化**: compound グルーピング実装 (c78427a) を main へ統合・両テナント deploy 済。O-1 再 live-check (使い捨てフォーム slug=2rqAm6BL・DELETE+404済) で A/B/C 3ルート全て実コード経由 push→pull→hosted 実遷移を実測確認 (A→ONLY-ON-PAGE-A / B→ONLY-ON-PAGE-B / C→ONLY-ON-PAGE-C)。status: pending_owner_confirmation (owner スマホ実機確認待ち)。
- [ ] **[OPTIONAL-POLISH] same-source jump+show/hide 混在の push→pull round-trip pin test** (reviewer route-branching-fix Round 1 申し送り) — 同一 source に jump と show/hide を混在させた rule 群は push で 1 item に grouping され、pull で 1 flat rule + additive(`.raw`) へ collapse する (2 flat rule に戻らない)。`.raw` 付与→refuse-push/preserve-raw で data loss は防止済・本番挙動は旧 separate-item (2番目 when 無視で壊れ) より改善のため製品退行ではなく非ブロッカー。将来 refactor で refuse 保護が外れても安全側に倒すよう、この round-trip を pin する回帰 test の追加を推奨。
- [ ] **case-b: 同一 save で新規作成した choice field への jump/show/hide** — choice_item slug は Formaloo push 後にしか確定しないため、「新規 choice field + それを条件源にする jump」を 1 回の save で組むと初回は constant 近似 (hosted 不発)。builder は「保存後 再取り込みで有効化」を注記済 (case-b UI 注記)。恒久対応 = field POST/GET で choice_item slug を捕捉して同一 save 内で解決 (push 回帰面ありゆえ別 case)。
- [ ] **回答別リダイレクト (redirect)** — `redirect`(constant URL) は PATCH 200 受理まで実測済だが hosted 実挙動**未実証**。live spike → UI 化を別案件。
- [ ] **jump_to_success_page 第一級 UI** — 本案件 spike で args 形だけ裏取り。「回答 X なら即完了ページへ」を UI 化 (診断フォームの早期終了ルートに有用)。
- [ ] **logic-fidelity B2 compound-edit** — AND/OR・複数条件・複数アクション・計算 variable の builder 内編集 (現状は refuse-push で Formaloo 側編集へ誘導)。
- [x] **jump 後 Prev (戻る) の再評価挙動確認** — closer O-1 live-check (2026-07-16) で実機確認: PAGE-Bへjump後に戻る操作をすると、フィールドラベルの無い空白ページ(Continueのみ)が表示された。スキップされたページの内容が正しく復元されない可能性を観察(詳細未診断・[OPTIONAL-POLISH]として残置)。
- [ ] (任意) form-themes 名前付きテーマ / jump のビジュアル分岐図 / native LIFF form renderer への jump 対応 (/t/:token 別系統)。

> spike 確定地雷 (正本 = `.ars-state/form-route-branching-sidecar.md` §spike): ①choice source jump は `{type:'choice',value:<slug>}` のみ hosted 発火 (constant は不発) ②form_type=`simple`/`multi_step` の 2 値のみ ③旧 `PUT {logic:{rules}}`=本番 500 (PATCH bare-array へ是正済) ④jump で skip されたページの**必須 field は submit をブロック**する dead-end footgun (builder で skip され得るページに必須 field を置かない旨の運用注意)。

---

## form-design-presets — 配色プリセット8種追加 + 新規フォーム既定配色seed + プレビュー可読化fix

🎯 目的: owner が「フォームビルダーのデザインタブで配色プリセット（4種）これって増やせますか　ダークトーンとか他の色とか」と発注（2026-07-17 13:5x）。背景 = puw7lh 調査で Formaloo 既定パレットが `field_color=text_color=#37352F` の同色（入力欄が黒くて見えない）と確定した罠の恒久対策も同時に扱う。

計画正本: `.plans/2026-07-17-form-design-presets/{spec,plan,tasks}.md`

owner 決定（D-0・2026-07-17）: OD-1 = 8候補すべて追加(dark-sumi/dark-indigo/dark-tokiwa/sand-washi/mono-ink/fresh-mint/coral-pop/matcha-wa。現行4種+計12種) / OD-2 = 既定preset = line-green。

### 進捗チェックリスト
- [x] T-A1 shared に8プリセット additive + `defaultFormDesign()` + コントラスト番人テスト（全12で field/text・bg/text >=4.5・line-greenのみbtn grandfather）
- [x] T-A2 デザインタブに12プリセット描画（明るい/ダーク グループ化 + スクロール枠）
- [x] T-B1/T-B2 `createFormalooForm` の POST create に既定パレット(line-green) seed（既存フォーム不可触・byte一致維持）
- [x] F-HIGH-1（reviewer R1差し戻し根治）: builder プレビューのラベル/section が preset textColor/fieldColor に追随せずダーク時に不可視だった欠陥を修正（form-preview.tsx）
- [x] 全pkg test green（shared288/db397/worker1894/web936）+ tsc rc0 + static export rc0 + migration ゼロ

**reviewer PASS Round 2（Critical0/High0・closer_allowed true）。closer 統合: main merge commit `70ce259`（origin+piecemaker 両 push・`verify-tenant-sync.sh` SHA一致確認済み）。ks/piecemaker 両 worker+両 admin 再デプロイ済み（health 4点 200）。**

**O-1/O-2/O-3 live-check 実測（2026-07-17 closer）**: 使い捨てフォームで検証・DELETE+404 済（本番フォーム不可触）。
- ks: 手動デザイン未操作の create-seed フォーム（slug=ixfrq6）で **design 未提供 PUT では #37352F 同色トラップが再現**（`color===backgroundColor`, contrast=1）→ **design 提供 PUT（builder相当）後は contrast 10.63 に解消**（罠根絶を実測確認）。dark-sumi 適用フォーム（slug=gtg2bp）でも contrast 10.63・legibility 良好。
- piecemaker: 同型トラップ再現（slug=gythn1・contrast 1）→ 解消（contrast 10.63）を実測。両テナントで罠根絶を確認。

**⚠️ 発見事項（新規 caveat / 要 owner 確認）**: headless-chrome(playwright) での画面実測において、**入力欄の legibility（可読性）は line-green/dark-sumi いずれも安全に確保される**が、**視覚的にはどちらの preset でも同一のFormaloo既定ライトテーマ（薄灰入力欄・珊瑚色ボタン）が表示され、dark-sumi の暗色（#1A1917背景等）は hosted 公開ページ上で視覚的に反映されなかった**（Formaloo API の `/pull` では push した正確な hex が form オブジェクトに保存されていることを確認済み・SSR HTML にも hex は埋め込まれている＝データ層は正しい。が、実際のレンダリングは変わらず）。既存の `form-design-theme` 案件では owner が実機で「OKでした」と確認済みのため、キャッシュ/伝播タイミングの可能性が高い（本 closer のテストは公開直後数十秒〜数分以内）が、断定はできない。**入力欄が見えなくなる事故（本案件の核）は解消済みだが、「ダークトーンが実際にダークに見えるか」は owner 実機確認が必要**。

### 🎯 次の必須（required backlog）
- [x] **owner 実機スモーク（色の見た目確認・本案件の核心確認）** — **design-hosted-apply-fix（2026-07-17 closer）で根治**。真因確定: hosted 公開ページは `background_color`/`button_color`/`field_color`/`text_color`/`submit_text_color` を **JSON-string RGBA**（例 `"{\"r\":6,\"g\":199,\"b\":85,\"a\":1}"`）で受け取った時のみレンダーし、**hex 文字列（旧実装の push 形式）は parse されず既定色にフォールバック**していた（theme resource/cache は無関係と実測で排除・Branch A1）。`formaloo-design.ts` の push を JSON-string RGBA 化（commit d6dbc54/fec629d/cf34fe1、main merge `3abb174`）。owner テスト実フォーム puw7lh（piecemaker）で実機確認: 修理前は既定ライトテーマ（bg white/button pink rgb(229,105,112)）、修理後は line-green 完全反映（bg rgb(244,251,247)/button rgb(6,199,85)/field white/text rgb(23,53,42)）。ks/piecemaker 両テナントで dark-sumi・line-green とも 4 assertion 全一致で確認済み。
- [x] **Formaloo hosted の色反映タイミング/キャッシュ調査** — **design-hosted-apply-fix で解消**。キャッシュ/タイミングではなく **color-shape（hex vs JSON-string RGBA）の parse 契約**が真因（cache-protocol.md: no-store・3s/12s で不変=timing 起因を実測で否定）。上記 fix で解消済み。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] preset badge stale（builder setColor 明示 null 送信 or PUT merge を presetId クリア時 replace 化・reviewer round1/2 申し送り）
- [ ] [OPTIONAL-POLISH] dark preset の入力欄（PreviewControl・builder内プレビューのみ）は白のまま=可読だが fieldColor 非追随（fidelity のみ・legibility 問題なし・reviewer round2 申し送り）

---

## forms-list-count-fix — 高機能フォーム一覧の回答数カウント修理（owner 判断待ち follow-up）

計画正本: `.plans/2026-07-17-forms-list-count-fix/{spec,plan,tasks}.md`

owner 実機報告（2026-07-17）「高機能フォーム一覧の　回答が０件」を修理（main merge `1b693fb`）。一覧の `submitCount` 読取源を `formaloo_forms.submit_count`（harness-only カウンタ）から D1 ミラー行数（`formaloo_submissions` の form 別 COUNT）へ切替え。deployed piecemaker 実機（headless chrome 実レンダー）で fa_5127eb98 の一覧カウント=4 を確認・ks/piecemaker 両テナントでミラー重複行なし（total==distinct_ids）を D1 直接確認。

### O-2（owner 判断・自動着手禁止）
- [ ] **未閲覧フォームの count 完全鮮度化** — 今回の修理は「一覧描画時、既に reconcile 済み（閲覧済み）のミラー行数」を表示する。**一度も回答データページを開いていない新規フォームは、実際に回答があっても一覧カウントが 0 のまま**（ミラーが reconcile-on-read でしか充填されないため）。恒久解は下記いずれか（owner 判断）:
  - (a) 一覧描画時に bounded live count（フォームごとに Formaloo `/stats/` を軽量 drill）— レイテンシ/API 呼数とのトレードオフ
  - (b) 定期 count-sync（cron で全フォームを巡回し reconcile）
  - (c) O-1 webhook 恒久配線（`FORMALOO_WEBHOOK_TOKEN` 投入）が完了すれば新規回答はリアルタイムでミラーに入るため本問題は事実上解消（webhook 配線時は submissionId を `row.slug` へ寄せて reconcile と2重化しないこと必須）
  - 本件は最小修理として意図的に対象外（spec §2.1 Risk 2 参照）。owner の実運用頻度次第で優先度を判断。

---

## form-jp-localization — フォーム公開ページの英語文言を日本語で個別指定

🎯 目的: owner 発注（2026-07-17 17:5x）「文字数エラーの日本語化/指定」「送信ボタンを送信・提出等に自由設定」「完了メッセージの実装」「英語部分を全体的に日本語化したい」。

計画正本: `.plans/2026-07-17-form-jp-localization/{spec,plan,tasks}.md`。reviewer PASS Round 2（Critical0/High0・closer_allowed true）。closer 統合: main merge commit `2be522d`（origin+piecemaker 両 push・`verify-tenant-sync.sh` SHA 一致確認済み）。ks/piecemaker 両 worker+両 admin 再デプロイ済み（health 4点 200）。

**O-1/O-2 hosted 実測（2026-07-17 closer・使い捨てフォームで検証・DELETE→404 済）**: ks（slug `55kbor`）/ piecemaker（slug `817foj`）両テナントで、ビルダー相当の PUT で `formCopy={buttonText:"送信テスト", successMessage:"ご協力ありがとうございました（テスト）", errorMessage:"エラーテスト文言"}` を保存→publish→hosted 公開ページを実描画確認。**送信ボタン「送信テスト」が実描画**（スクショ証跡）。**実際に送信 (playwright headless chrome) して完了ページに「ご協力ありがとうございました（テスト）」が実描画される**ことを両テナントで確認（スクショ証跡）。

**⚠️ 発見事項（新規 defect / 要 follow-up・generator 未着手）**: `confirmFormCopyReflected`（GET-after-PATCH の soft-200 対策確認）が **success_message のみ**常に不一致判定を返し、route が `out_of_sync`（`文言が公開ページに反映されませんでした（success_message）`）を誤って surface する。**ks/piecemaker 両テナントで再現**（button_text/error_message は確認 OK・success_message のみ）。しかし上記の通り **hosted 実描画は正しく日本語で反映される**（false negative = 「保存済なのに未反映と誤警告する」パターンで、逆の「未反映なのに保存済と誤認させる」殻完了パターンではない）。~~想定原因: Formaloo GET envelope で success_message の実 key/位置が異なる（id-191 型 fixture-vs-reality 疑い）~~ → **planner の live spike で否定・真因確定（2026-07-18）**。真因 = **Formaloo が保存時に文言を server-side 正規化する（全角！→半角! ？→? （）→() NBSP/TAB/CR→space・\n/emoji/&/<> は保持）× harness の strict 等値比較**。harness は owner が打った全角値（例 `受付完了！`）をそのまま送るが Formaloo は `受付完了!` を保存/返却 → `confirmFormCopyReflected` の `form[field] !== value` strict 突合が恒久不一致 → out_of_sync 誤警告。envelope 抽出（extractForm）は正しく無罪。field 固有でなく data 依存（button_text/error_message は畳み込み対象文字を含まなかっただけ / closer O-1 test の success_message `…（テスト）` は全角丸括弧を含み同じ畳み込みに当たった）。**owner フォーム puw7lh 実測 = success_message は実反映済（誤警告 = false positive・実失敗でない）**。→ 計画正本 `.plans/2026-07-18-form-copy-sync-warning-fix/`（spec/plan/tasks + evidence/spike-normalization-matrix.md）。修正方式 = confirm 比較を NFKC + \r\t→space の正規化耐性化（送信経路は不変・fail-closed 温存）。closer は独立検証のみ実施（コード修正はしない）。

### 🎯 次の必須（required backlog）
- [x] **success_message の false out_of_sync 根治** → **修理完了（form-copy-sync-warning-fix closer 2026-07-18）**。`confirmFormCopyReflected` の strict 等値比較を `normalizeForCompare`（NFKC + `\r\t`→space + 連続スペース畳み込み）で正規化耐性化。main merge commit `9e0f725`（origin+piecemaker 両 push・SHA 一致確認済み）。ks/piecemaker 両 worker 再デプロイ済み（`/admin/version` 200×2）。**O-1 実測**: 両テナントで使い捨てフォーム（ks `fa_a16b1807…`/formalooSlug `ImvyCCwS`・piecemaker `fa_8fa619f9…`/formalooSlug 経由 publicUrl `peace-maker.formaloo.me/tyvwyh`）に全角！入り success_message を保存 → `syncStatus:idle`（誤警告なし）・publish 後の hosted 公開ページ埋込 JSON に Formaloo が正規化した半角値 `受付完了!`（U+0021）が実描画確認済み（サーバ側正規化を harness confirm が正しく吸収した直接証拠）→ 自作 slug を DELETE→404 で cleanup 済み（両テナント）。**O-2（owner 手交・未実施）**: owner が puw7lh で文言を保存し直すと「未同期」警告が消えることを owner 自身が目視確認する（puw7lh は今回 PATCH/DELETE していない・GET のみ不可触のまま）。REPORT: `.ars-state/REPORT_2026-07-18_020000_form-copy-sync-warning-fix.md`。
- [ ] **文言 pull 対応**（push-only MVP・spec backlog 節から繰越）: 現状ビルダーは保存済み formCopy を表示せず常に空欄開始。Formaloo→harness の pull 対応は別タスク。
  - **付随の honest-idle 限界（form-copy-sync-warning-fix planner が明示・Codex gap-check FINDING-3/5・上記修理では非解消のまま残置）**: pull が無いため画面 reload 後は builder に copy が載らず、out_of_sync のまま「今すぐ同期」を押すと formCopyProvided=false で GET-after 確認が skip され idle 化し得る（値は実反映済ゆえ実害はないが verify を経ない hollow-clear）。同一セッション内（打った直後）の経路は copy を再送し confirm 実行で honest に idle 化する（owner 実症状はこちら・今回の修理で根治済み）。**恒久解消 = 本 pull 対応**（builder が保存済み copy を表示→今すぐ同期で必ず再送・再確認）。

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] [OPTIONAL-POLISH] D-2 fingerprint test 2 本を「form に button_text を実際に足しても不変」の意味ある形へ強化
- [ ] [OPTIONAL-POLISH] out_of_sync で design/copy 両失敗時 design error が copy error を mask する順序（両方とも out_of_sync=正しく非ブロッカー）
- [ ] [OPTIONAL-POLISH] builder 注記に「既に設定済みの文言はここには表示されません（保存済みの値は保持されます）」を追記（pull-backlog の混乱緩和）
- [ ] [OPTIONAL-POLISH] `apps/worker/src/utils/password.test.ts` T-F2 が full-suite 並列実行下で稀に flaky fail する（改竄検知の crypto race・pre-existing・form-copy-sync-warning-fix 非起因）。単体隔離では 7/7×2 green。並列非依存化 or retry 許容の調整を検討（製品挙動不変・reviewer round1 で確認済み）。
