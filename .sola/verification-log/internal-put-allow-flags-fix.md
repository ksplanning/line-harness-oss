case-scope-echo: caseId=internal-put-allow-flags-fix target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-internal-put-allow-flags-fix/tasks.md"]
tdd-red-evidence: `pnpm --filter worker test -- src/routes/internal-forms-admin.test.ts -t 'edit flags'` → PUT 応答が allowPostEdit=0、allowEditMail=0、editMailFieldId=null のため 2 tests failed（実装前の期待どおり exit 1）
- D-1: PASS — `pnpm --filter worker test -- src/routes/internal-forms-admin.test.ts -t 'edit flag'` → 内部 PUT→DB保存→publish→exact GET→一覧の往復を含む 4 tests passed (exit 0)
- D-2: PASS — `pnpm --filter worker test -- src/routes/internal-forms-admin.test.ts -t 'edit flag'` → allowPostEdit、allowEditMail、editMailFieldId の正規化・未指定保持・null解除・非email拒否・原子保存を含む 4 tests passed (exit 0)
- D-3: PASS — `pnpm --filter worker test -- src/routes/internal-form-edit-public.test.ts` → /ife/ の分岐選択変更・保存・拒否境界を含む 21 tests passed (exit 0)
- D-4: PASS — `pnpm --filter worker test` → 282 files・3398 tests passed、`pnpm --filter web test` → 221 files・1672 tests passed、`pnpm --filter @line-crm/db test` → 93 files・630 tests passed、worker/web の `tsc --noEmit` → diagnostics 0、`git diff --quiet -- packages/db/migrations` → migration 差分なし (exit 0)
- D-5: PASS — `rg -n -e 'internal-put-allow-flags-fix' -e 'オーナー向けの日常語' -e 'host 実測手順' -e '本番3フォーム変更数' .sola/live-checklist.md` → 使い捨て内部フォーム専用の保存→公開→再読込→/ife/分岐変更手順、owner 日常語、安全境界、撤収記録欄を確認 (exit 0)
