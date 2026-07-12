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
- [ ] reviewer 通過 → closer（worktree ff/cherry-pick → main + build + `wrangler pages deploy`）
- **owner ゲート: 不要**（低リスク・read-only・早く見せられる）

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
