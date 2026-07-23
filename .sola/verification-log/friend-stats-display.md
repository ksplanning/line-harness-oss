case-scope-echo: caseId=friend-stats-display target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-friend-stats-display/tasks.md"]

# friend-stats-display 自己検証

## TDD Red の観測

- DB Red — `pnpm --dir packages/db exec vitest run src/friend-stats.test.ts` → 新しい集計関数2件が未定義、migration 140未作成、bootstrap索引未生成の計4件失敗（想定どおり exit 1）。
- Worker Red — `pnpm --dir apps/worker exec vitest run src/routes/line-accounts.test.ts` → 3値集計未接続と推移route未実装により新規4件失敗、既存17件成功（想定どおり exit 1）。
- Web Red — `pnpm --dir apps/web exec vitest run --config vitest.config.ts src/app/accounts/page-quota.test.tsx` → 3値領域と推移領域が未実装で新規2件失敗、既存2件成功（想定どおり exit 1）。
- Web安定化 Red — 同じ本件テストの反復で、領域表示後かつグラフ取得中に同期queryする競合を1件観測（exit 1）。`findByRole` でグラフ描画を待つ最小修正後、4件成功（exit 0）。

## 数字と履歴の定義

- 友だち総数 = 対象 `line_account_id` の `friends` 全行、ブロック数 = `is_following = 0`、一斉送信可能数 = `is_following = 1`。既存 `stats.friendCount` は配信対象数の互換契約を守り、一斉送信可能数のままにした。
- 登録推移 = `friends.created_at` の管理画面への初回登録数。明示的なUTC/offset付き日時だけJSTへ変換し、時差なしで保存済みの日時はJST日付として扱う。当日を含む30日または90日を0件の日も含めて返す。
- 現DBにはブロック・再フォローの履歴台帳がないため、グラフは過去時点の有効友だち総数ではない。LINE上の実追加日やフォロワー取込元日時がない行は、管理画面への登録日（取込なら取込日）として画面とlive-checklistに明示した。

## suite 実行上の注記

- Webの既定並列実行は、今回の差分外にあるフォームテストの5秒timeoutや別テスト間の非同期干渉が実行ごとに変わって発生した。該当ファイル単独は76/76成功。本件テストの待機競合を修正後、ファイル並列だけを止めた最終コマンドはテストをskipせず242 files / 1796 testsすべて成功した。
- Web buildの既存Flex export警告、Worker buildの既存static/dynamic import警告は残るが、どちらも今回の変更外でbuildはexit 0。

## done_conditions

- D-1: PASS — `pnpm --dir packages/db exec vitest run src/friend-stats.test.ts test/bootstrap.test.ts --reporter=dot` + `pnpm --dir apps/worker exec vitest run src/routes/line-accounts.test.ts src/routes/line-accounts-quota.test.ts src/routes/line-accounts-monthly-cap.test.ts --reporter=dot` + `pnpm --dir apps/web exec vitest run --config vitest.config.ts src/app/accounts/page-quota.test.tsx --reporter=dot` → 実SQLiteのaccount別3値と他account除外、APIの互換値、画面の12人/2人/10人と定義表示を固定し、2 files / 6 tests、3 files / 32 tests、1 file / 4 tests成功 (exit 0)
- D-2: PASS — `pnpm --dir packages/db exec vitest run src/friend-stats.test.ts --reporter=dot` + `pnpm --dir apps/worker exec vitest run src/routes/line-accounts.test.ts --reporter=dot` + `pnpm --dir apps/web exec vitest run --config vitest.config.ts src/app/accounts/page-quota.test.tsx --reporter=dot` → JST日次化、0件日の補完、当日を含む30/90日の境界、日別バー、30日初期表示と90日切替がテストデータと一致 (exit 0)
- D-3: PASS — `node packages/db/scripts/generate-bootstrap.mjs --check` + `git diff --check origin/main...HEAD` + `git diff --quiet origin/main...HEAD -- apps/worker/src/services apps/worker/src/routes/broadcasts.ts apps/worker/src/routes/chats.ts apps/web/src/components/shared/line-quota-display.tsx` → migration差分はadditiveな`140_friend_stats_index.sql`のみ、bootstrap同期済み、送信・quota経路は無変更、既存quota/月次上限を含むWorker対象32件成功 (exit 0)
- D-4: PASS — `pnpm --dir packages/db exec vitest run --reporter=dot` + `pnpm --dir apps/worker exec vitest run --reporter=dot` + `pnpm --dir apps/web exec vitest run --config vitest.config.ts --reporter=dot --no-file-parallelism --maxWorkers=1 --testTimeout=30000` + `pnpm --dir packages/db typecheck` + `pnpm --dir apps/worker typecheck` + `pnpm --dir apps/web exec tsc --noEmit` + `XDG_CONFIG_HOME=/tmp/friend-stats-worker-config pnpm --dir apps/worker build` + `NEXT_PUBLIC_API_URL=http://localhost:8787 pnpm --dir apps/web build` → DB 109 files / 692 tests、Worker 300 files / 3697 tests、Web 242 files / 1796 tests、3 typechecks、Worker SSR 378 modules/client 53 modules、Web 65 pagesすべて成功 (exit 0)
- D-5: PASS — `sed -n '47,125p' .sola/live-checklist.md` → trusted hostでのmigration 140確認、読取専用D1集計と3値照合、30/90日グラフ照合、既存配信数回帰、秘密値非記録、LINE送信0件を記録する実測手順と結果欄を収録 (exit 0)
