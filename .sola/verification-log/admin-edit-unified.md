case-scope-echo: caseId=admin-edit-unified target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-admin-edit-unified/tasks.md"]
- D-1: PASS — `pnpm --filter worker exec vitest run src/services/internal-form-edit.test.ts src/routes/internal-forms-admin.test.ts src/routes/internal-form-edit-public.test.ts` → 3 files / 191 tests passed（認証・権限・opaque短命token・不正token 403を含む） (exit 0)
- D-2: PASS — `pnpm --filter worker exec vitest run src/routes/internal-form-edit-public.test.ts && pnpm --filter @line-crm/db exec vitest run src/internal-forms.test.ts` → 59 + 34 tests passed（admin-originはeditLocked編集可・外部編集フラグなし、公開tokenは従来挙動） (exit 0)
- D-3: PASS — `pnpm --filter worker exec vitest run src/routes/internal-form-edit-public.test.ts` → 59 tests passed（同一renderer、分岐、添付、上限検証、CASを含む） (exit 0)
- D-4: PASS — `pnpm --filter worker exec vitest run src/routes/internal-form-edit-public.test.ts` → 59 tests passed（発行→保存→管理GET→/ife/再表示の往復と公開編集回帰を含む） (exit 0)
- D-5: PASS — `pnpm --filter worker test; pnpm --filter web test; pnpm --filter @line-crm/db test; pnpm --filter worker typecheck; pnpm --filter web exec tsc --noEmit; pnpm --filter @line-crm/db typecheck` → worker 284 files / 3567 tests、web 226 files / 1704 tests、DB 98 files / 652 tests、3型検査すべて成功 (exit 0)
- D-6: PASS — `rg -n '^# admin-edit-unified' .sola/live-checklist.md` → host closer用の管理画面→/ife/→保存反映・公開URL比較・安全境界を記載 (exit 0)
