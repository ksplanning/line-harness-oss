case-scope-echo: caseId=treasure-b5-webhook-instant target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-19-treasure-b5-webhook-instant/tasks.md"]

# treasure-b5-webhook-instant 検証証跡

base: `fd9daf98d99fa4e0fb7cb50d5c8a9d98afa4114a`

head-at-suite: `fead15a0af6124079610344580b2237253b34f8a`

## TDD red-green

- Red: 登録 DAO 3件、未実装 service/route、公開 rate limit 101件目、UI 未実装を各々失敗で確認後に実装した。
- Red: 並行登録、末尾 callback、別 isolate claim、fencing、通信 deadline、URL-only cleanup、deadline 後の provider 再開を失敗テストで再現した。最終 Red は worker 3 FAIL / 21 PASS、DB 1 FAIL / 8 PASS。
- Green: 最終 focused は worker 5 files / 49 tests、DB 1 file / 9 tests、UI 3 files / 8 tests、mock pin 1 file / 1 test がすべて PASS。
- worker 全体の初回は既存の乱数依存 2 tests がフレークしたが、対象 20 tests の単独再実行と全体再実行でどちらも PASS を確認した。

## done conditions

- D-1: PASS — `pnpm --filter worker exec vitest run src/services/formaloo-client.test.ts src/services/formaloo-instant-webhook.test.ts src/routes/formaloo-instant-webhook.test.ts src/routes/formaloo-instant-webhook.mock-pin.test.ts src/not-found.test.ts && pnpm --filter @line-crm/db test -- formaloo-webhook-registration.test.ts` → worker 49 tests PASS、DB 9 tests PASS、read-back true・重複収束・ID不明時URL解除・migration 106 を確認 (exit 0)
- D-2: PASS — `pnpm --filter worker exec vitest run --reporter=dot` → 212 files / 2,339 tests PASS、未知・OFF・secret不一致は404、payload非依存、mount/rate-limit を含む (exit 0)
- D-3: PASS — `pnpm --filter worker exec vitest run src/routes/formaloo-instant-webhook.test.ts src/services/formaloo-client.test.ts && pnpm --filter @line-crm/db test -- formaloo-webhook-registration.test.ts` → 36 worker tests + 9 DB tests PASS、D1 generation/claim・20s有限wait・1 page/10件・5s provider deadline・lease renewal・fail-soft を確認 (exit 0)
- D-4: PASS — `pnpm --filter web exec vitest run src/app/forms-advanced/detail/form-builder-instant-webhook-wiring.test.tsx src/components/forms-advanced/instant-webhook-settings.test.tsx src/lib/formaloo-instant-webhook-api.test.ts --reporter=dot` → 3 files / 8 tests PASS、form単位トグル・既定OFF・API配線を確認 (exit 0)
- D-5: PASS — `pnpm --filter worker exec vitest run src/routes/formaloo-instant-webhook.mock-pin.test.ts --reporter=dot && test -s .sola/live-checklist.md && rg -q 'Z5IEH85R.*GMOxoMtK.*XqACeA2v' .sola/live-checklist.md && rg -q 'FORM_GET_STATUS' .sola/live-checklist.md && rg -q 'test "\$FORM_GET_STATUS" = 404' .sola/live-checklist.md && rg -q 'KS が完了したら.*PIECE MAKER' .sola/live-checklist.md` → mock 登録→callback→bounded pull→mirror→解除 1 test PASS、host checklist の本番3form denylist・KS/PIECE MAKER分離・DELETE→404 grep も exit 0。sandbox での external mutation は安全規律に従い未実行 (exit 0)
- D-6: PASS — `pnpm --filter worker exec vitest run --reporter=dot`, `pnpm --filter @line-crm/db exec vitest run --reporter=dot`, `pnpm --filter @line-crm/shared exec vitest run --reporter=dot && pnpm --filter @line-crm/shared typecheck`, `pnpm --filter web exec vitest run --reporter=dot && pnpm --filter web exec tsc --noEmit`, `pnpm --filter worker typecheck && pnpm --filter @line-crm/db typecheck && pnpm --filter @line-crm/shared typecheck && pnpm --filter web exec tsc --noEmit`, `pnpm exec tsx scripts/check-migrations.ts packages/db/migrations/106_formaloo_webhook_registration.sql && pnpm --dir packages/db generate:bootstrap --check`, `pnpm --filter worker exec vitest run src/services/formaloo-resolver.test.ts src/services/piecemaker-tenant.wrangler.test.ts src/services/formaloo-drift.wrangler.test.ts src/routes/forms-advanced.account-scope.test.ts src/routes/forms-advanced.key-share-isolation.test.ts --reporter=dot`, `git diff --exit-code fd9daf98d99fa4e0fb7cb50d5c8a9d98afa4114a..HEAD -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts && git diff --exit-code fd9daf98d99fa4e0fb7cb50d5c8a9d98afa4114a..HEAD -- apps/worker/src/routes/forms-advanced.ts apps/web/src/components/forms-advanced/builder.tsx packages/shared/src/formaloo-forms.ts` → worker 212/2,339、DB 65/438、shared 31/421、web 143/1,059 が PASS、4 package TypeScript・migration/bootstrap・両tenant 24 tests・保護 4 files + forms-advanced.ts/builder.tsx/shared schema diff がすべて exit 0 (exit 0)

## 追加の機械検証

- `pnpm exec tsx scripts/check-migrations.ts packages/db/migrations/106_formaloo_webhook_registration.sql && pnpm --dir packages/db generate:bootstrap --check` → `OK — 1 migrations pass.` + bootstrap clean (exit 0)
- `pnpm --filter worker typecheck && pnpm --filter @line-crm/db typecheck && pnpm --filter @line-crm/shared typecheck && pnpm --filter web exec tsc --noEmit` → 全 TypeScript 検査成功 (exit 0)
- `pnpm --filter worker exec vitest run src/services/formaloo-resolver.test.ts src/services/piecemaker-tenant.wrangler.test.ts src/services/formaloo-drift.wrangler.test.ts src/routes/forms-advanced.account-scope.test.ts src/routes/forms-advanced.key-share-isolation.test.ts --reporter=dot` → 5 files / 24 tests PASS (exit 0)
- `git diff --exit-code fd9daf98d99fa4e0fb7cb50d5c8a9d98afa4114a..HEAD -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts` → output なし、byte 不変 (exit 0)
