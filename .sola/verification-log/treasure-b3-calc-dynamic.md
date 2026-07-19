case-scope-echo: caseId=treasure-b3-calc-dynamic target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-19-treasure-b3-calc-dynamic/tasks.md"]

# treasure-b3-calc-dynamic verification

## Contract evidence

- Official source: https://help.formaloo.com/en/articles/8143269-api-endpoint-specifications-for-fetch-choice-field — public GET, raw top-level `{label,value}[]`, maximum 10 results, `q` search, and CORS.
- Official source: https://help.formaloo.com/en/articles/8143467-dynamic-fetch-choice-field-for-developers-beta — `choice_fetch`, `choices_source`, URL validation during field creation, and `{label,value}` answers.
- Sandbox intentionally did not create a live Formaloo `choice_fetch` field: Formaloo fetches and validates `choices_source` at creation time, so live registration is deferred until the endpoint is deployed. No production form was contacted.
- TDD Red observed before implementation: missing choice routes failed 5/5; public CORS failed 2 assertions; rotating-Bearer rate-limit, invalid fingerprint projection, existing formula self/mutual cycles, URL normalization, and description symmetry each failed their new regression tests before the minimal fixes.
- Final focused run: shared dynamic push/pull/fingerprint 15/15, worker sync/public API/CORS/rate-limit 15/15, web palette/builder/CRUD/reimport/shared-state/preview/API 16/16.
- Full recursive Vitest required `--passWithNoTests` only because the untouched SDK package contains zero test files. Packages with tests ran normally. The untouched plugin template has a pre-existing standalone typecheck setup defect; all other typecheck scripts and the Web `tsc --noEmit` passed.

## Done-condition results

- D-1: PASS — `pnpm --filter @line-crm/shared test -- formaloo-dynamic-fields.test.ts formaloo-fingerprint.dynamic-fields.test.ts && pnpm --filter worker test -- formaloo-sync.dynamic-fields.test.ts formaloo-choice-lists.test.ts rate-limit.test.ts && pnpm --filter web test -- builder-dynamic-fields.test.tsx field-types.dynamic-fields.test.ts form-preview-dynamic-fields.test.tsx formaloo-choice-lists-api.test.ts` → variable 4 subtypes・formula `{id}`→slug push/pull・existing cycle guard・builder reference insertionを含む shared 15/15、worker 15/15、web 16/16 (exit 0)
- D-2: PASS — `pnpm --filter worker test -- formaloo-choice-lists.test.ts rate-limit.test.ts && pnpm --filter web test -- builder-dynamic-fields.test.tsx formaloo-choice-lists-api.test.ts` → form/list scoped CRUD、raw array、最大10件、`q`、GET/OPTIONS wildcard CORS（credentialsなし）、IP rate-limit、管理URL自動配線・再取込み・共有更新を含む 21/21 (exit 0)
- D-3: PASS — `pnpm --filter web test -- form-preview-dynamic-fields.test.tsx builder-dynamic-fields.test.tsx` → variableは偽計算せず公開側計算placeholder、choice_fetchは保存中の実 `{label,value}` と公開時再取得注記、合計11/11 (exit 0)
- D-4: PASS — `pnpm --filter @line-crm/shared test -- formaloo-fingerprint.dynamic-fields.test.ts && git diff c693d52 --quiet -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts` → additive射影・必須key未設定drop・legacy canonical byte固定 5/5、保護4ファイルdiffなし (exit 0)
- D-5: PASS — `pnpm -r --if-present test -- --passWithNoTests && pnpm -r --filter '!@line-harness/plugin-myservice' --if-present typecheck && pnpm --filter web exec tsc --noEmit && NEXT_PUBLIC_API_URL=https://api.example.test pnpm --filter web build && pnpm --filter @line-crm/db generate:bootstrap --check && pnpm --filter worker test -- piecemaker-tenant.wrangler.test.ts formaloo-choice-lists.test.ts` → workspace Vitest全script完走（shared 440、DB 460、worker 2427、update-engine 117ほか）、対象tsc rc0、60 static pages export、bootstrap同期、KS/Piecemaker共通経路11/11 (exit 0)
- D-6: PASS — `rg -n "treasure-b3-calc-dynamic|8143269|8143467|soft-200|見積り・診断フォームの自動計算" .sola/live-checklist.md` → endpoint先行deploy→raw array/CORS/q/max10→field作成→hosted表示・選択・submit、sandbox非登録、soft-200と実効PASSの区別、owner日常語、公式2資料を確認 (exit 0)
