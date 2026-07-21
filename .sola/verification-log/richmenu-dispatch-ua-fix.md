case-scope-echo: caseId=richmenu-dispatch-ua-fix target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-21-richmenu-dispatch-ua-fix/tasks.md"]

# Verification — richmenu-dispatch-ua-fix

- D-1: PASS — `pnpm --filter worker test -- src/services/rich-menu-rule-work.cron.test.ts` → `Test Files 1 passed (1); Tests 15 passed (15)` (exit 0; Red は UA 欠落・403/503・通信例外の4件を期待どおり確認)
- D-2: PASS — `pnpm test:scripts && pnpm -r --if-present run test && pnpm -r --if-present run typecheck && git diff --quiet f8d5d2cfaa713ff6fe7ec4b2702a95fc7b30397e -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts && git diff --quiet f8d5d2cfaa713ff6fe7ec4b2702a95fc7b30397e -- packages/db/migrations && test -z "$(git ls-files --others --exclude-standard -- packages/db/migrations)"` → `650 test files / 6212 tests passed; all existing typecheck scripts Done; protected files diff 0; migrations diff 0` (exit 0)
- D-3: PASS — `rg -q '^# richmenu-dispatch-ua-fix — host closer 実測チェック$' .sola/live-checklist.md && rg -q '^## オーナー向けの説明$' .sola/live-checklist.md && rg -q '^## cron / 自動 dispatch の実測手順$' .sola/live-checklist.md && rg -q '手動 internal invoke 回数 / 再適用開始回数' .sola/live-checklist.md` → `owner 日常語・cron/dispatch・手動介入0回・実測記入欄の4項目を確認` (exit 0)
