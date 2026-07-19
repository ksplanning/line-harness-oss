case-scope-echo: caseId=richmenu-conditional-rules target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-19-richmenu-conditional-rules/tasks.md"]
- D-1: PASS — `pnpm --filter @line-crm/db test` → migration 107・rule model・account-scoped CRUD を含む 68 files / 456 tests passed (exit 0)
- D-2: PASS — `pnpm --filter worker test` → 条件評価・同値skip・default復帰・fail-soft retry・属性更新raceを含む 222 files / 2415 tests passed (exit 0)
- D-3: PASS — `pnpm --filter worker exec vitest run src/services/rich-menu-rule-engine.test.ts` → priority DESC・created_at ASC・id ASC のwinner固定を含む 12 tests passed (exit 0)
- D-4: PASS — `pnpm --filter web test; NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm --filter web build` → 149 files / 1099 tests passed、static export 60 pages (exit 0)
- D-5: PASS — `pnpm --filter worker exec vitest run src/services/rich-menu-rule-work.test.ts` → 最大20人・進捗集計・cooldown・lease/CAS競合を含む 11 tests passed (exit 0)
- D-6: PASS — `pnpm --filter @line-crm/db typecheck; pnpm --filter @line-crm/shared typecheck; pnpm --filter worker typecheck; NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm --filter web exec tsc --noEmit` → 全4 typecheck rc0、KS/Piecemaker config 7 tests、bootstrap check、protected 4 files差分ゼロ (exit 0)
- D-7: PASS — `pnpm --filter @line-crm/db exec vitest run src/rich-menu-display-rules.schema.test.ts; pnpm --filter worker exec vitest run src/services/rich-menu-rule-engine.test.ts` → ruleless tenant queue 0・LINE client 0・assignment 0・再フォロー/再有効化を含む 8 + 12 tests passed (exit 0)
