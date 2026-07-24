case-scope-echo: caseId=draft-to-faq target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-draft-to-faq/tasks.md"]

# draft-to-faq 検証記録

## TDD Red 観測

- TDD-RED-worker: `pnpm --filter worker exec vitest run src/routes/chats.inline-drafts.test.ts` → 新規3件がFAQ未登録・fail-safe未実装で失敗、既存23件は成功（期待どおり exit 1）
- TDD-RED-web: `pnpm --filter web test -- src/app/chats/chat-inline-draft.test.tsx src/app/knowledge/knowledge-page.test.tsx` → 新規4件がチェック未表示で失敗、既存33件は成功（期待どおり exit 1）

## done_conditions

- D-1: PASS — `pnpm --filter web test -- src/app/chats/chat-inline-draft.test.tsx src/app/knowledge/knowledge-page.test.tsx` → 2 files passed・37 tests passed、チェック・注意書き・既定OFF・通常/拡大同期・送信後リセットを確認 (exit 0)
- D-2: PASS — `pnpm --filter worker exec vitest run src/routes/chats.inline-drafts.test.ts src/routes/faqs.test.ts src/services/faq-fts.test.ts` → 3 files passed・67 tests passed、ON/OFF・無効FAQ・一覧再取得・fail-safeを確認 (exit 0)
- D-3: PASS — `pnpm --filter worker test && pnpm --filter web test && pnpm --filter worker typecheck && pnpm --filter web exec tsc --noEmit` → worker 300 files・3730 tests、web 243 files・1817 tests、両TypeScript検査成功 (exit 0)
- D-4: PASS — `rg -q '^# draft-to-faq' .sola/live-checklist.md && rg -q 'addToFaq:false' .sola/live-checklist.md && rg -q 'addToFaq:true' .sola/live-checklist.md && rg -q 'A/B分離' .sola/live-checklist.md && rg -q '結果（PASS / FAIL / BLOCKED）' .sola/live-checklist.md` → host closer用の安全境界・OFF/ON・A/B分離・結果記録欄を検出 (exit 0)
