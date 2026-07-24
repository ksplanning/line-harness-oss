case-scope-echo: caseId=autoreply-actions target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-autoreply-actions/tasks.md"]

# autoreply-actions verification

- D-1: PASS — `(cd packages/db && pnpm test -- src/auto-replies.test.ts test/143_auto_reply_actions.test.ts test/bootstrap.test.ts) && (cd apps/worker && pnpm test -- src/routes/auto-replies.multi-message.test.ts) && (cd apps/web && pnpm test -- src/components/shared/friend-actions-editor.test.tsx src/components/auto-replies/edit-dialog.test.tsx src/app/auto-replies/auto-replies-embed.test.tsx src/components/forms-advanced/builder-submit-actions.test.tsx)` → DB 3 files/13 tests、API 1 file/15 tests、Web 4 files/26 tests passed。4種類・複数・順序・保存再取得・明示空配列を確認 (exit 0)
- D-2: PASS — `cd apps/worker && pnpm test -- src/routes/webhook.test.ts src/services/form-submit-actions.test.ts` → 2 files/56 tests passed。text/postbackの送信成功後呼出し、P1エンジン直接再利用、2回実行の最終状態一致、失敗後続継続、送信失敗時非実行、friend_not_linked skipを確認 (exit 0)
- D-3: PASS — `(cd packages/db && pnpm test) && (cd apps/worker && pnpm test) && (cd apps/web && pnpm exec vitest run --config vitest.config.ts --maxWorkers=4) && (cd packages/db && pnpm typecheck) && (cd apps/worker && pnpm typecheck) && (cd apps/web && pnpm exec tsc --noEmit) && pnpm exec tsx scripts/check-migrations.ts packages/db/migrations/143_auto_reply_actions.sql && (cd packages/db && pnpm generate:bootstrap) && git diff --exit-code -- packages/db/bootstrap.sql packages/db/bootstrap-meta.json` → DB 112 files/703 tests、worker 300 files/3732 tests、Web 244 files/1818 tests、全typecheck、migration guard、bootstrap再生成一致がpassed (exit 0)
- D-4: PASS — `rg -n '^# autoreply-actions' .sola/live-checklist.md && rg -n '^## 送信成功後・再実行・fail-safeを確認する' .sola/live-checklist.md && rg -n '^## 未設定回帰と撤収を確認する' .sola/live-checklist.md` → host closer用の安全境界、migration、保存往復、送信後、再実行、fail-safe、未連携、未設定回帰、撤収、PASS/FAIL/BLOCKED結果欄を確認 (exit 0)

## TDD Red observations

- Persistence Red: migration・schema/bootstrap・DAOの先行テストで7件の期待失敗を観察後、最小実装でGreen。
- API Red: `replyActions`のPOST/PUT/legacy往復テストで3件の期待失敗を観察後、P1 parser/resolver接続でGreen。
- Web Red: 新規draft・一覧からの受け渡し・編集ダイアログ往復で3件の期待失敗を観察後、共有UI接続でGreen。
- Execution Red: text/postbackのP1実行とfail-safeで3件の期待失敗を観察後、送信成功直後のhookでGreen。

## Atomic commits

- `74750b888 feat(db): store auto-reply actions`
- `06edc3c2b feat(worker): persist auto-reply actions`
- `342efb7d9 refactor(web): share friend action editor`
- `06433b01c feat(web): configure auto-reply actions`
- `97ad9a92c feat(worker): run auto-reply actions`
