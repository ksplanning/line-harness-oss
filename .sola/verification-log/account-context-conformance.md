case-scope-echo: caseId=account-context-conformance target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-account-context-conformance/tasks.md"]

# account-context-conformance verification

## TDD Red

- `pnpm --filter web test -- src/app/settings/page.test.tsx src/app/accounts/page-quota.test.tsx src/app/settings/formaloo-workspaces/page.test.tsx src/components/settings/email-sender-settings-panel.test.tsx src/components/broadcasts/broadcast-form.segment.test.tsx src/app/broadcasts/page.segment.test.tsx` → 実装前は、設定内の独自 selector、accounts のカード別導線、Formaloo の他アカウント行、一斉配信の P2 タブと配信先 selector、`not_started` 時の無効な確認ボタンをそれぞれ検出して失敗。
- `pnpm --filter worker test -- src/routes/email-sender-settings.test.ts` → 実装前は登録済みドメインの `resendDomainId` がレスポンスに無く、追加した 3 assertion が失敗。

## Done conditions

- D-1: PASS — `pnpm --filter web test -- src/app/settings/page.test.tsx src/app/accounts/page-quota.test.tsx src/app/settings/formaloo-workspaces/page.test.tsx src/components/settings/email-sender-settings-panel.test.tsx src/components/broadcasts/broadcast-form.segment.test.tsx src/app/broadcasts/page.segment.test.tsx` → Test Files 6 passed、Tests 23 passed (exit 0)
- D-2: PASS — `pnpm --filter web test -- src/app/settings/page.test.tsx src/components/settings/email-sender-settings-panel.test.tsx src/components/broadcasts/broadcast-form.segment.test.tsx` → A→B→A の表示・保存再取得、別アカウント非混線、選択中アカウントへの payload 固定を含む 3 files / 16 tests が passed (exit 0)
- D-3: PASS — `pnpm --filter web test`; `pnpm --filter worker test`; `pnpm --filter web exec tsc --noEmit --pretty false --incremental false`; `pnpm --filter worker typecheck` → web 243 files / 1808 tests、worker 300 files / 3719 tests が passed、両 typecheck も成功。`account-context.tsx`・scenarios・DB migration・LINE 送信経路は base から差分なし (exit 0)
- D-4: PASS — `test -f .plans/2026-07-24-account-context-conformance/live-checklist.md; rg -n "左上|認証状態を確認|LINE 送信ゼロ" .plans/2026-07-24-account-context-conformance/live-checklist.md` → 左上 A/B 切替、各設定の追随、登録直後の認証確認、一斉配信固定、LINE 送信ゼロの host closer 実測手順を収録 (exit 0)

## Defense checks

- `git diff --quiet cb333926b...HEAD -- apps/web/src/contexts/account-context.tsx apps/web/src/app/scenarios packages/db/migrations packages/db/schema.sql packages/db/bootstrap.sql` → 差分なし (exit 0)
- `git diff --quiet cb333926b...HEAD -- apps/worker/src/services apps/worker/src/routes/broadcasts.ts apps/worker/src/routes/webhook.ts` → LINE 送信経路の差分なし (exit 0)
- `git diff --check cb333926b...HEAD` → whitespace error なし (exit 0)
