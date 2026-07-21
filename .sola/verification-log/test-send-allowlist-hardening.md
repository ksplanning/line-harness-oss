case-scope-echo: caseId=test-send-allowlist-hardening target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-21-test-send-allowlist-hardening/tasks.md"]

# test-send-allowlist-hardening verification

## TDD Red → Green

- Red (worker): `pnpm --filter worker exec vitest run src/routes/test-sends.test.ts --reporter=verbose --maxWorkers=1` → 許可リスト外の同一 account fixture が 200、`sentUserIds` 欠落で失敗を確認 (exit 1)
- Red (web): `pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx --reporter=verbose --maxWorkers=1` → 匿名件数表示が残り、実 userId 表示期待が3件失敗することを確認 (exit 1)
- Green (worker focused): `rtk pnpm --filter worker exec vitest run src/routes/test-sends.test.ts src/routes/broadcasts.new-types-sender.test.ts src/routes/broadcasts-combo-messages.test.ts src/routes/account-settings.test.ts --reporter=dot --maxWorkers=1` → 4 files / 60 tests passed (exit 0)
- Green (web focused): `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx src/lib/api.test-sends.test.ts src/components/accounts/test-recipients-setting.test.tsx --reporter=dot --maxWorkers=1` → 3 files / 13 tests passed (exit 0)

## 全体検証

- Build-first: `NEXT_PUBLIC_API_URL=https://worker.invalid APP_BUILD_TIME=2026-07-21T00:00:00.000Z WRANGLER_LOG_PATH=/tmp/test-send-allowlist-hardening-wrangler.log rtk pnpm build` → all builds completed、Web compiled successfully、static pages 64/64、Exporting 2/2 (exit 0)
- TypeScript: `rtk pnpm -r --workspace-concurrency=1 --if-present run typecheck` → 11 of 12 workspace projects の対象 typecheck が完走 (exit 0)
- Workspace regression: `rtk pnpm -r --workspace-concurrency=1 --if-present run test -- --passWithNoTests --reporter=dot --maxWorkers=1 --testTimeout=15000` → 640 files / 6064 tests passed (exit 0)
- Root scripts: `rtk pnpm run test:scripts -- --reporter=dot --maxWorkers=1 --testTimeout=15000` → 9 files / 80 tests passed (exit 0)
- Sandbox safety: LINE client は全対象テストで mock/capture を使用し、実 LINE 送信・本番3フォーム・Discord投稿・deploy・migration は実行していない。

## done_conditions

- D-1: PASS — `rtk pnpm --filter worker exec vitest run src/routes/test-sends.test.ts src/routes/broadcasts.new-types-sender.test.ts src/routes/broadcasts-combo-messages.test.ts src/routes/account-settings.test.ts --reporter=dot --maxWorkers=1` → 許可外混在・空 allowlist・旧 API を送信前 400、正常複数宛先を含む 60 tests passed (exit 0)
- D-2: PASS — `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx src/lib/api.test-sends.test.ts src/components/accounts/test-recipients-setting.test.tsx --reporter=dot --maxWorkers=1` → 実 sentUserIds 表示・匿名成功拒否を含む 13 tests passed (exit 0)
- D-3: PASS — `NEXT_PUBLIC_API_URL=https://worker.invalid APP_BUILD_TIME=2026-07-21T00:00:00.000Z WRANGLER_LOG_PATH=/tmp/test-send-allowlist-hardening-wrangler.log rtk pnpm build` / `rtk pnpm -r --workspace-concurrency=1 --if-present run typecheck` / `rtk pnpm -r --workspace-concurrency=1 --if-present run test -- --passWithNoTests --reporter=dot --maxWorkers=1 --testTimeout=15000` → build・static export・型検査・640 files / 6064 tests が全て成功 (exit 0)
- D-4: PASS — `rg -n -A 40 '^# test-send-allowlist-hardening — host closer 実機チェック$' .sola/live-checklist.md` → owner 日常語、あやこ1射、未登録 synthetic fixture の HTTP 400 実測、安全境界、PASS 記録を確認 (exit 0)
