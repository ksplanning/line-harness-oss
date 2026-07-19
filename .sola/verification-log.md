# form-jp-reapply-impl — verification log

Base SHA: `aebc05438d6ae0c5dabce7691af2af8cb29cdc68`

実装 commit（全 commit に `Generator-LLM: codex` / `Task-Size: large` trailer あり）:

- `ac0b5be` — localized_content の非破壊 shared merge
- `56a9840` — Worker localized_content GET-merge / confirm
- `2f580cb` — localizationJa 保存配線 / localization kill-switch
- `afc1b41` — 一発再反映 service / per-part 部分失敗
- `94c9cb4` — reapply endpoint / D1-workspace fail-closed / reapply kill-switch
- `275ee93` — host live checklist / rollback

## TDD RED → GREEN 証跡

- Shared localization RED: `pnpm --filter @line-crm/shared exec vitest run src/formaloo-localization.test.ts` → module 不在で exit 1。その後 5 tests PASS。
- Worker localization service RED: `pnpm --filter worker exec vitest run src/services/formaloo-copy.localization.test.ts` → 6 tests が未実装 function で FAIL (exit 1)。その後新規 6 + 既存 copy 33 tests PASS。
- 保存 route RED: `pnpm --filter worker exec vitest run src/routes/forms-advanced-form-copy.test.ts` → 新規 5 件中 4 FAIL / 既存 14 PASS (exit 1)。実装後 18 tests PASS。
- Reapply service RED: `pnpm --filter worker exec vitest run src/services/formaloo-reapply.test.ts` → module 不在で suite FAIL (exit 1)。最初の Green 後、安全契約を remote URL 保持 + form fields_list 読取 + `color` part に強化して 6 FAIL / 2 PASS を再観察し、最終 9 tests PASS。
- Reapply route RED: `pnpm --filter worker exec vitest run src/routes/forms-advanced-reapply.test.ts` → endpoint 不在で 6 FAIL / 2 PASS (exit 1)。実装後 8 tests PASS。

## 最終機械検証

- Shared 全 suite: `pnpm --filter @line-crm/shared test` → 30 files / 413 tests PASS (exit 0)。
- Shared type/build: `pnpm --filter @line-crm/shared typecheck && pnpm --filter @line-crm/shared build` → `tsc --noEmit` / `tsc -p tsconfig.build.json` ともに exit 0。
- Focused Worker: `pnpm --filter worker exec vitest run src/services/formaloo-reapply.test.ts src/services/formaloo-copy.test.ts src/services/formaloo-copy.localization.test.ts src/services/formaloo-design.test.ts src/routes/forms-advanced-reapply.test.ts src/routes/forms-advanced-form-copy.test.ts src/routes/forms-advanced-design.test.ts src/routes/forms-advanced.b1-field-polish.test.ts` → 8 files / 124 tests PASS (exit 0)。
- Worker typecheck: `pnpm --filter worker typecheck` → `tsc --noEmit` exit 0（workspace dependency は事前 build 済み）。
- Surgical guard: base SHA から保護 4 ファイルを `git diff --quiet` + `git rev-parse BASE:path` / `git hash-object path` で比較し、全て byte-identical。`formaloo-reapply.ts` の `pushDefinitionToFormaloo(` / `toFormalooFieldPayload(` 呼出は 0。
- Full Worker/db suite と外部 hosted 通信は lane sandbox の done 対象外。land 工程が host で再実行する。

## done conditions

- D-1: PASS — `pnpm --filter worker exec vitest run src/services/formaloo-reapply.test.ts src/routes/forms-advanced-reapply.test.ts` → 2 files / 17 tests PASS、D1/workspace fail-closed・body slug/workspace 非採用・per-part 部分失敗・GET-merge・definition/field-map/logic 非破壊を確認 (exit 0)
- D-2: PASS — `pnpm --filter @line-crm/shared test && pnpm --filter worker exec vitest run src/services/formaloo-copy.localization.test.ts src/routes/forms-advanced-form-copy.test.ts` → shared 30 files / 413 tests + localization Worker 2 files / 24 tests PASS、ON/OFF・foreign/nested key 保持・未指定/kill-switch の raw definition byte 一致を確認 (exit 0)
- D-3: PASS — `pnpm --filter @line-crm/shared typecheck && pnpm --filter worker typecheck && git diff --quiet aebc05438d6ae0c5dabce7691af2af8cb29cdc68..HEAD -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts` → shared/Worker tsc rc0、focused Worker 8 files/124 tests、shared 30 files/413 tests、保護 4 ファイル byte-identical (exit 0)。full Worker/db suite は lane 対象外で land host 再実行
- D-4: PASS — `test -f .sola/live-checklist.md && bash -n <(awk '/^```bash$/{inside=1; next} /^```$/{if (inside) {inside=0; print ""}; next} inside' .sola/live-checklist.md)` → reapply→API GET-after→cache-bust Chromium 9秒→star/video/dark/copy/日本語 chrome→Formaloo/Harness DELETE→404、両テナント別実行、本番 3 ID denylist の手順を確認 (exit 0)。live 自体は lane 外の host 工程へ明示移管
- D-5: PASS — `rg -n 'FORMALOO_REAPPLY_DISABLE' apps/worker/src/index.ts apps/worker/src/routes/forms-advanced.ts .sola/live-checklist.md && rg -n 'FORMALOO_LOCALIZATION_DISABLE' apps/worker/src/index.ts apps/worker/src/routes/forms-advanced.ts .sola/live-checklist.md` → endpoint 全体と localization の独立 `'1'` 短絡、実装内 rollback コメント、両テナント停止/復帰コマンドを確認 (exit 0)
