case-scope-echo: caseId=form-results-sheet-split target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-22-form-results-sheet-split/tasks.md"]

# form-results-sheet-split — verification log

- Base: `d729d2762` (`main` at lane creation)
- Verified implementation head: `238b1a6a0`
- Scope safety: disposable/local test databases and mocks only. Production Sheets connections, the three production forms, and LINE send APIs were not touched.

## TDD RED evidence

- DB schema/DAO RED: `pnpm --filter @line-crm/db test -- src/sheets-form-results.test.ts` → 16 failed / 1 passed because the target columns and DAO functions did not exist (exit 1).
- DB target-isolation RED: the flag-only settings test produced 1 failed / 17 passed because disabling one target killed the other target's pending work (exit 1).
- Worker engine RED: `pnpm --filter worker exec vitest run src/services/form-results-sync.test.ts` → 13 failed with `form results sync is not implemented` (exit 1).
- Worker jobs RED: `pnpm --filter worker exec vitest run src/services/form-results-sync-jobs.test.ts` → 5 failed before target-aware cursor/job routing existed (exit 1).
- Worker route RED: `pnpm --filter worker exec vitest run src/routes/sheets-connections.test.ts src/routes/sheets-friend-ledger.test.ts` → 8 failed / 29 passed; the additional disabled-results/null case failed `expected 400 to be 201` (exit 1).
- Web RED: the five focused Sheets UI/API files produced 5 failed / 63 passed before the two independent target controls were wired (exit 1).

## Final done-condition evidence

- D-1: PASS — `pnpm --filter @line-crm/db exec vitest run src/sheets-form-results.test.ts test/127_128_form_results_sync.test.ts test/bootstrap.test.ts test/119_friend_ledger_sync.test.ts test/126_sheets_sync_jobs.test.ts` + `pnpm --filter worker exec vitest run src/services/form-results-sync.test.ts src/services/form-results-sync-jobs.test.ts src/services/friend-ledger-sync.test.ts src/services/sheets-sync-jobs.test.ts src/services/sheets-sync-jobs.cron.test.ts` → DB 5 files / 32 tests and worker 5 files / 101 tests passed, including exact submission write-back, identity revert, custom metadata LWW, selected fields, legacy combined layout, and 450-submission chunk completion (exit 0)
- D-2: PASS — `pnpm --filter worker exec vitest run src/routes/sheets-connections.test.ts src/routes/sheets-friend-ledger.test.ts` + the D-1 DB command → routes 2 files / 37 tests and DB 5 files / 32 tests passed, including independent gates, new/legacy defaults, target-only event cancellation, webhook routing, and per-target jobs (exit 0)
- D-3: PASS — `pnpm --filter worker test`; `pnpm --filter @line-crm/db test`; `pnpm --filter web exec vitest run --config vitest.config.ts --maxWorkers=1 --shard=1/4` through `--shard=4/4`; `pnpm --filter @line-crm/shared test`; package typechecks; migration checker; `git diff --check d729d2762..HEAD` → worker 281 files / 3342 tests, DB 93 / 626, Web 215 / 1640 across four fresh-process shards, shared 42 / 531, all typechecks, 2 additive migrations, and diff check passed (exit 0)
- D-4: PASS — `pnpm --filter web exec vitest run --config vitest.config.ts src/components/forms-advanced/internal-sheets-setup-panel.test.tsx src/components/settings/sheets-connections-panel.test.tsx src/app/settings/sheets/page.test.tsx src/app/forms-advanced/detail/form-builder-scope.test.tsx src/lib/sheets-connections-api.test.ts` → 5 files / 68 tests passed for daily-language toggles, inspected tab choices, different-tab validation, saved defaults, API payloads, and settings display (exit 0)
- D-5: PASS — `test -f .sola/live-checklist.md && rg -n -m 12 'form-results-sheet-split|使い捨て|友だち台帳も同期する|LINEメッセージ送信は0件|本番で使っている3フォーム' .sola/live-checklist.md` → disposable two-tab procedure, ledger/results independence, identity revert, metadata/answer import, production-form prohibition, and zero-LINE-send checks found (exit 0)

## Web full-suite execution note

One monolithic 215-file/one-worker attempt passed 1,639 tests and hit Testing Library's one-second wait only in the unrelated existing `instant-webhook-settings` test. That file passed 4/4 alone (the affected assertion completed in 29 ms), and no mock/timer isolation leak was found. The final proof therefore ran all 215 files exactly once across four sequential fresh-process shards: 54/380 + 54/366 + 54/494 + 53/400 = 215 files / 1,640 tests, all green, without weakening a timeout or assertion.
