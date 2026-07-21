case-scope-echo: caseId=test-send-allowlist-hardening target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-21-test-send-allowlist-hardening/tasks.md"]

# test-send-allowlist-hardening verification

## R2 TDD Red → Green

- Red (worker): `rtk pnpm --filter worker exec vitest run src/routes/test-sends.test.ts --reporter=verbose --maxWorkers=1` → env 未設定の DB 2名 preview と別 tenant 送信が 400 のままで、新規2件だけ失敗・22件成功を確認 (exit 1)
- Red (web): `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx --reporter=verbose --maxWorkers=1` → 旧 idempotency replay が「送信結果に送信先userIdが含まれていません」の赤表示になり、新規1件だけ失敗・6件成功を確認 (exit 1)
- Green (worker): `rtk pnpm --filter worker exec vitest run src/routes/test-sends.test.ts --reporter=verbose --maxWorkers=1` → env 未設定の DB 2名 preview+送信、別 tenant、env 明示上限、空上限を含む 24 tests passed (exit 0)
- Green (web): `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx --reporter=verbose --maxWorkers=1` → 新形式 userId 表示、匿名 fresh 応答拒否、旧 replay 成功互換を含む 7 tests passed (exit 0)

## 全体検証

- Build-first: `NEXT_PUBLIC_API_URL=https://worker.invalid APP_BUILD_TIME=2026-07-21T00:00:00.000Z WRANGLER_LOG_PATH=/tmp/test-send-allowlist-hardening-r2-wrangler.log rtk pnpm build` → Worker build、Web compiled successfully、static pages 64/64、Exporting 2/2 (exit 0)
- TypeScript: `rtk pnpm -r --workspace-concurrency=1 --if-present run typecheck` → 11 of 12 workspace projects の対象 typecheck が完走 (exit 0)
- Workspace regression: `rtk pnpm -r --workspace-concurrency=1 --if-present run test -- --passWithNoTests --reporter=dot --maxWorkers=1 --testTimeout=15000` → 640 files / 6067 tests passed (exit 0)
- Root scripts: `rtk pnpm run test:scripts -- --reporter=dot --maxWorkers=1 --testTimeout=15000` → 9 files / 80 tests passed (exit 0)
- Sandbox safety: test-send の LINE client は mock/capture のみを使用し、実 LINE 送信・本番3フォーム・本番 D1・Discord投稿・deploy・migration は実行していない。

## done_conditions

- D-1: PASS — `rtk pnpm --filter worker exec vitest run src/routes/test-sends.test.ts --reporter=verbose --maxWorkers=1` → DB `test_recipients` を正本に env 未設定の2名 preview+送信と別 tenant を許可し、env 明示時の上限外・空上限・cross-account は送信前 400、24 tests passed (exit 0)
- D-2: PASS — `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/components/shared/test-send-dialog.test.tsx --reporter=verbose --maxWorkers=1` → 実 sentUserIds 表示、匿名 fresh 応答拒否、sentUserIds の無い旧 deduplicated replay の正直な成功表示を含む 7 tests passed (exit 0)
- D-3: PASS — `NEXT_PUBLIC_API_URL=https://worker.invalid APP_BUILD_TIME=2026-07-21T00:00:00.000Z WRANGLER_LOG_PATH=/tmp/test-send-allowlist-hardening-r2-wrangler.log rtk pnpm build` / `rtk pnpm -r --workspace-concurrency=1 --if-present run typecheck` / `rtk pnpm -r --workspace-concurrency=1 --if-present run test -- --passWithNoTests --reporter=dot --maxWorkers=1 --testTimeout=15000` / `rtk pnpm run test:scripts -- --reporter=dot --maxWorkers=1 --testTimeout=15000` → build・64/64 static pages・2/2 export・型検査・640 files / 6067 tests・root 9 files / 80 tests が全て成功 (exit 0)
- D-4: PASS — `rg -n -A 42 '^# test-send-allowlist-hardening — host closer 実機チェック$' .sola/live-checklist.md` → DB 設定が正本・env は追加上限という owner 日常語、登録済み全員（現行あやこ+三原栄一）への API 1回、隔離 runtime の上限外 synthetic fixture を送信前 400 にする host 手順、安全境界、PASS 記録を確認 (exit 0)
