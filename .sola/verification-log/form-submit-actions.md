case-scope-echo: caseId=form-submit-actions target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-form-submit-actions/tasks.md"]
- D-1: PASS — `pnpm --dir packages/db test -- src/form-submit-actions.test.ts && pnpm --dir apps/worker test -- src/routes/forms-advanced-submit-actions.test.ts && pnpm --dir apps/web test -- src/components/forms-advanced/builder-submit-actions.test.tsx src/app/forms-advanced/detail/form-builder-submit-actions-wiring.test.tsx` → DB 4/4、Worker API 4/4、Web UI/配線 7/7（追加・上下移動・削除・明示空配列・保存再取得・旧タグ互換）pass (exit 0)
- D-2: PASS — `pnpm --dir apps/worker test -- src/services/form-submit-actions.test.ts src/routes/internal-forms-public.test.ts src/routes/formaloo-public.test.ts` → 3 files / 104 tests pass、4種の逐次実行・再実行冪等・途中失敗後の継続・submission claim 1回を確認 (exit 0)
- D-3: PASS — `pnpm --dir apps/worker test -- src/services/form-submit-actions.test.ts src/routes/internal-forms-public.test.ts src/routes/formaloo-public.test.ts` → internal と Formaloo の匿名回答が 200 のまま全 action を `friend_not_linked` で skip、PII/設定値非出力を含む 104/104 pass (exit 0)
- D-4: PASS — `pnpm --dir packages/db test; pnpm --dir apps/worker test; pnpm --dir apps/web test; pnpm --dir packages/db typecheck; pnpm --dir apps/worker typecheck; pnpm --dir apps/web exec tsc --noEmit` → DB 107 files/680 tests、Worker 298 files/3,677 tests（追加匿名テスト 50/50 も別途 pass）、Web 238 files/1,777 tests、3系統 tsc、migration/bootstrap replay が全て green (exit 0)
- D-5: PASS — `test -f .plans/2026-07-23-form-submit-actions/live-checklist.md && rg -n "設定の往復|友だちに紐付く回答|匿名回答と失敗時の安全確認|後方互換と回帰|host closer 記録" .plans/2026-07-23-form-submit-actions/live-checklist.md` → host 実測の設定往復・実送信・匿名/fail-safe・旧設定回帰・記録欄を検出 (exit 0)

## TDD Red evidence

- DB: `pnpm --dir packages/db test -- src/form-submit-actions.test.ts` → migration/列/DAO 未実装で 4 tests failed を観察後、同 4 tests green。
- Worker: submit action service は module missing、両公開 route は旧単一タグ状態、保存 route は `submitActions` 欠落の Red を観察後、focused 242 tests green。
- Web: `pnpm --filter web test -- src/components/forms-advanced/builder-submit-actions.test.tsx src/app/forms-advanced/detail/form-builder-submit-actions-wiring.test.tsx` → 2 files failed / 6 failed・1 passed を観察後、7/7 green。
