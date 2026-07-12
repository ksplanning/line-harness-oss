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
- [ ] **owner 決定（1 問）: 編集キャンバス手段** — 「縦フローのまま inline 編集（自作継続・依存ゼロ）」 vs 「自由キャンバスで drag-connect（React Flow `@xyflow/react` v12 導入・既定 chrome 全非表示で没個性回避）」。plan.md §1 決定ゲート参照。
- [ ] node inline 編集 ↔ step CRUD 配線
- [ ] `apps/web/src/lib/api.ts` の `addStep/updateStep` に condition3列（conditionType/conditionValue/nextStepOnFalse）を追加（worker は既に受理・api.ts:327-363 が渡せない = L4）
- [ ] 編集 UX（後方互換 100%・step_order 再採番せず既存 `reorderSteps` を使う）
- **owner ゲート: 要**（キャンバス手段 1 問 + 編集 UX 方針）

### Phase3 — 分岐拡張（worker + db + web・配信挙動変更＝高リスク）
- [ ] **分岐ランタイム乖離の修正（RED 先行）** — `apps/worker/src/services/step-delivery.ts:191-197`。分岐ジャンプ時 `advanceFriendScenario` が `currentStep.step_order` を使い、次回 cron が順次の次を返して jumpStep に遷移しない疑い（spec §2.4）。回帰テストを先に RED で立ててから修正。
- [ ] 多分岐が要るなら additive migration（branch edge の一般化・複数出力エッジ）
- [ ] 複数出力エッジ UI
- **owner ゲート: 要**（配信挙動変更＝立会・KS 本番は cron 空 dark のため点火時に別途確認）

### 図ビルダー ⇄ チャット構築（staff-docs-chat Phase2）の役割分担
- 図 = 全体俯瞰・精緻な微修正・検証面。チャット = 自然言語から素早い骨子生成。両者は同一 `scenario_steps` を単一正本として共有（競合しない）。`scenario-graph.ts` の正規化はチャット出力の検証にも再利用可。

### chrome wedge 復帰時の visual-qa 温存項目（R-2 / Phase1 実機検証は封印中）
1. ノード間隔・整列（縦積みの均等さ・座標定数の見た目）
2. 分岐曲線の交差（複数分岐時の琥珀破線が重ならないか・レーン幅）
3. レスポンシブ（狭幅 375px で横スクロール発生時の可読性・折返し）
4. anti-generic 審美（既定フロー chrome 不在・LINE 緑調和・テンプレ感のなさ）
5. native scroll 挙動（Lenis 慣性なし・縦スクロールの素直さ）
6. 長文/多ステップ時の可読性（内容要約の truncate・ノード高さ固定の破綻有無）

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
