case-scope-echo: caseId=form-duplicate target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-form-duplicate/tasks.md"]

# form-duplicate verification

## TDD Red → Green

- worker RED — `pnpm --filter worker test -- src/routes/forms-advanced.duplicate.test.ts` → 複製 route 未実装のため 3 tests failed（expected 201, received 404）(exit 1)
- worker GREEN — `pnpm --filter worker test -- src/routes/forms-advanced.duplicate.test.ts` → 1 file / 3 tests passed (exit 0)
- web RED — `pnpm --filter web test -- src/app/forms-advanced/forms-advanced-duplicate.test.tsx src/lib/formaloo-advanced-api.scope.test.ts` → API method と複製ボタン未実装のため 4 tests failed / 15 passed (exit 1)
- web GREEN — `pnpm --filter web test -- src/app/forms-advanced/forms-advanced-duplicate.test.tsx src/lib/formaloo-advanced-api.scope.test.ts` → 2 files / 19 tests passed (exit 0)
- worker hardening RED — `pnpm --filter worker test -- src/routes/forms-advanced.duplicate.test.ts` → folder 継承・choice slug 変換・部分失敗 cleanup の 3 tests failed / 3 passed (exit 1)
- raw-template RED — `pnpm --filter worker test -- src/services/formaloo-sync-preserve.test.ts` → 複製 raw template の新 field/choice slug 解決 1 test failed / 4 passed (exit 1)
- fail-closed RED — `pnpm --filter worker test -- src/services/formaloo-sync-preserve.test.ts` → 未解決 provider 参照を送信してしまい 1 test failed / 5 passed (exit 1)
- worker hardening GREEN — `pnpm --filter worker test -- src/services/formaloo-sync-preserve.test.ts src/routes/forms-advanced.duplicate.test.ts` → 2 files / 12 tests passed (exit 0)
- web race RED — `pnpm --filter web test -- src/app/forms-advanced/forms-advanced-duplicate.test.tsx` → folder/account 切替競合と再取得失敗の 3 tests failed / 4 passed (exit 1)
- web race GREEN — `pnpm --filter web test -- src/app/forms-advanced/forms-advanced-duplicate.test.tsx` → 1 file / 7 tests passed (exit 0)

## done_conditions

- D-1: PASS — `pnpm --filter worker test -- src/services/formaloo-sync-preserve.test.ts src/routes/forms-advanced.duplicate.test.ts` → 2 files / 12 tests passed；定義一致、下書き・未公開・回答0件・連携なし、元フォーム完全不変、choice/matrix/provider identity 除去、複合 logic の新 slug 解決、部分失敗の不可視化を検証 (exit 0)
- D-2: PASS — `pnpm --filter worker test -- src/routes/forms-advanced.duplicate.test.ts` → 1 file / 6 tests passed；複製→account・folder 別一覧→詳細の往復、タイトル「〜 のコピー」、同一項目/分岐、A/B分離と cross-account 404 を検証 (exit 0)
- D-3: PASS — `pnpm --filter web test -- src/app/forms-advanced/forms-advanced-duplicate.test.tsx src/lib/formaloo-advanced-api.scope.test.ts` → 2 files / 23 tests passed；API呼出、成功時の現在 folder 一覧反映、失敗時日本語エラー、A→B→A・folder 切替 race、再取得失敗時の既存一覧維持を検証 (exit 0)
- D-4: PASS — `pnpm --filter worker test` / `pnpm --filter web test` / `pnpm --filter @line-crm/db test` / `pnpm -r --if-present typecheck` / `pnpm --filter web exec tsc -p tsconfig.json --noEmit` → worker 306 files・3826 tests、web 248 files・1873 tests、db 115 files・713 tests、workspace typecheck と web tsc が全て green (exit 0)
