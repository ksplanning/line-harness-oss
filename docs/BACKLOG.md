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

## piecemaker-line-harness — 第 2 テナント（Sukedachi 顧客提供 1 号）+ 双方向伝播体制

🎯 目的: ks と**同一システムをそのまま** Piecemaker (Sukedachi の顧客) 専用インフラで第 2 テナント稼働させ、以後の修正/機能が ks ⇄ Piecemaker で**双方向伝播**する体制を作る。repo/forum は Sukedachi 経路（ks は Ksplanning のまま）。

計画正本: `.plans/2026-07-15-piecemaker-line-harness/{spec,plan,tasks}.md` / sidecar: workspace `.ars-state/piecemaker-line-harness-sidecar.md`

推奨 repo 戦略（planner 確定）: **共有 1 tree → dual-remote mirror**（origin=ksplanning 不変 + 2nd remote=Sukedachi PUBLIC mirror）+ per-tenant config 兄弟ファイル + テナント別挙動は wrangler `[vars]` flag。双方向伝播＝同一 commit を両 remote に push（drift 構造ゼロ）。データ完全分離＝deploy `--config` が指す独自 Worker/D1/R2/Vectorize/Pages/secrets/(CF account)。

**P1（repo 戦略配線 additive 部分: P1-3 verify-tenant-sync.sh）+ P2（wrangler.piecemaker.toml + invariant test）+ P3（bootstrap-piecemaker-tenant.sh）+ B-4/B-5 runbook 文書 は piecemaker-p1 で実装・reviewer PASS・2026-07-15 closer で main 統合済み**（コミット 10896b1/6ecd8bd/1b48bec/e341e1c）。P1-1/P1-2/P1-4/P1-5（remote 登録・dual-push配線・cron）は owner 着荷物待ちのため未着手。

### 次の必須: P0 owner 決定 gate（4 択・これが埋まるまで P1 remote 登録以降の着手不可）
- [ ] **P0-1** CF アカウント名義: 「ks 同一 account 内別リソース」or「Sukedachi 別 CF account」（推奨=別 account）— owner 決定
- [ ] **P0-2** Sukedachi GitHub org 名（推奨=独立 PUBLIC mirror repo）— owner 決定
- [ ] **P0-3** Piecemaker LINE OA credential（Messaging/Login/LIFF id）を **Box BOLT escrow**（生値非露出）— owner 作業
- [ ] **P0-4** ドメイン: 当面 `*.workers.dev`/`*.pages.dev` 既定で可の Yes/No（推奨=Yes）— owner 決定

### 実装フェーズ（P0 決定後・owner ゲート付き）
- [x] **P1-3** `scripts/verify-tenant-sync.sh`(SHA 一致検知) — 2026-07-15 piecemaker-p1 実装済み・main 統合済み
- [ ] **P1-1/P1-2/P1-4/P1-5** Sukedachi mirror repo 作成 + 2nd remote 登録 + dual-push を closer 配線 + weekly cron（owner_role: infra-ops）— P0-1/P0-2 着荷待ち
- [x] **P2** `apps/worker/wrangler.piecemaker.toml` 新設（wrangler.ks.toml 雛形・値差し替え・秘密ゼロ・placeholder）+ Piecemaker invariant test（自 config 番人）— 2026-07-15 piecemaker-p1 実装済み・main 統合済み
- [x] **P3** `scripts/bootstrap-piecemaker-tenant.sh`（空 D1 assert→bootstrap.sql→pending→ledger→verify・冪等 fail-closed）— 2026-07-15 piecemaker-p1 実装済み・main 統合済み
- [ ] **[REQUIRED-BACKLOG] P4a**: placeholder-gate invariant test (`piecemaker-tenant.wrangler.test.ts:75-86`) は `<PIECEMAKER_D1_ID>`/`<PIECEMAKER_CF_ACCOUNT_ID>` が **残存すること**を assert する設計（意図的）。P4 provisioning で実 id を記入した時点でこの assertion は失敗する想定 → P4 実施時に同テストの assertion を「placeholder 残存」から「実 id 記入」検証へ flip すること（reviewer piecemaker-p1 Round1 carryover）。
- [ ] **P4** CF リソース provisioning（Worker/D1/R2/Vectorize 1024-cosine-metadata line_account_id/Pages）— owner_role: infra-ops + CF token（P0 着荷後）
- [ ] **P5** secrets 投入（BOLT から）+ LINE 配線（Webhook/LIFF）+ deploy + smoke（openapi 200 / friends count 200 / 友だち追加 1 行）— owner_role: infra-ops + owner 立会
- [ ] **P6** Piecemaker Discord forum bot 新設（別 systemd/tmux/DISCORD_STATE_DIR/Box folder・ks 混線 0）— owner_role: infra-ops

### 💡 任意磨き込み（後回し可・自動着手禁止）
- [ ] O-1: `piecemaker.skdcc.jp` 等カスタムドメイン配線（当面既定 URL で稼働・memory sukedachi-domain 戦略: 道具=サブドメイン）
- [ ] Formaloo 連携鍵の後日投入（当面 Formaloo 無しで芯機能稼働）
- [ ] [OPTIONAL-POLISH] `FAQ_BOT_ENABLED="false"` の H-8 cutover gate を invariant test でも明示 pin する（現状 toml 上は正しいが assert 未追加・非ブロッキング、reviewer piecemaker-p1 Round1 carryover）

> **ks 本番不可触**: 全工程 `--config wrangler.piecemaker.toml`。ks の worker/D1/Pages/webhook/secrets/wrangler.ks.toml は 1 バイトも触らない（additive only・2026-07-15 closer 検証: wrangler.ks.toml diff 0 / runtime source 変更 0）。
