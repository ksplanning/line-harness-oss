case-scope-echo: caseId=form-notify-and-sheet-followups target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-22-form-notify-and-sheet-followups/tasks.md"]

# form-notify-and-sheet-followups — verification

- base SHA: `ea5090d3187ec0aec320bd138a287e6a51f71fb7`
- implementation commits: `5101af530` (default notification filtering), `4e8098905` (split-sheet admin deep link)
- D-1: PASS — `pnpm --filter @line-crm/shared exec vitest run src/internal-submission-notification.test.ts` → Red: 3 failed / 8 passed (exit 1); Green: 1 file / 11 tests passed、空文字・null・未定義・空配列を非表示、`0`・`false`・`"未"` と編集リンクを保持、全未回答は `（回答なし）` (exit 0)
- D-2: PASS — `pnpm --filter worker exec vitest run src/services/form-results-sync.test.ts src/services/form-results-sync-jobs.test.ts` → Red: 2 failed / 21 passed (exit 1); Green: 2 files / 23 tests passed、分離シートの file セルで管理画面 deep-link・readOnly 復元・no-origin marker fallback・job adminOrigin 配線を確認 (exit 0)
- D-3: PASS — `pnpm --filter @line-crm/shared test -- --reporter=dot --maxWorkers=2; pnpm --filter @line-crm/db test -- --reporter=dot --maxWorkers=2; pnpm --filter web test -- --reporter=dot --maxWorkers=2; pnpm --filter worker test -- --reporter=dot --maxWorkers=2` → shared 42 files / 532 tests、db 93 / 626、web 220 / 1666、worker 281 / 3370、合計 636 files / 6194 tests passed; `pnpm --filter {workspace} exec tsc --noEmit --incremental false` (shared/db/web/worker) → 全4 workspace exit 0; `git diff --name-only ea5090d3187ec0aec320bd138a287e6a51f71fb7 --` + migration path guard → 対象8ファイルのみ・migration 0件 (exit 0)
- D-4: PASS — `test "$(rg -c '^# form-notify-and-sheet-followups — host closer 実機チェック$' .sola/live-checklist.md)" -eq 1 && rg -n -e '^## owner 日常語$' -e '未回答' -e '回答を開く:' -e 'readOnly' -e '本番3フォーム' -e 'LINE送信0件' .sola/live-checklist.md` → owner 日常語、安全境界、未回答混在の自動返信控え、分離回答シートの認証必須リンク/readOnly、撤収・PASS記録欄を確認 (exit 0)
