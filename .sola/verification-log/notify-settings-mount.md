case-scope-echo: caseId=notify-settings-mount target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-notify-settings-mount/tasks.md"]

tdd-red: `pnpm --filter web test -- src/app/accounts/page-quota.test.tsx` → 新規導線テストだけが `Unable to find role="button" and name "スタッフ通知(Chatwork/LINE)"` で失敗、既存テストは成功 (exit 1)
- D-1: PASS — `pnpm --filter web test -- src/app/accounts/page-quota.test.tsx src/components/settings/email-sender-settings-dialog.test.tsx src/components/settings/staff-notification-settings-panel.test.tsx` → accounts の明示導線、対象 account の dialog、dialog 内 panel、登録済み Chatwork 通知先を 3 files / 13 tests passed で確認 (exit 0)
- D-2: PASS — `pnpm --filter web test -- src/components/settings/staff-notification-settings-panel.test.tsx src/components/settings/staff-notification-settings-api.test.ts` → 作成・編集の保存後 GET 再取得と表示一致を含む 2 files / 14 tests passed (exit 0)
- D-3: PASS — `pnpm --filter web test ; pnpm --filter web exec tsc --noEmit --pretty false ; git diff --quiet -- packages/db/schema.sql ':(glob)**/migrations/**'` → web 236 files / 1771 tests passed、TypeScript error 0、migration 差分 0 (exit 0)
