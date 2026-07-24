case-scope-echo: caseId=data-cockpit-columns target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-data-cockpit-columns/tasks.md"]
- D-1: PASS — `pnpm --filter web test -- src/components/forms-advanced/data-cockpit.test.tsx` → 49 tests passed; 詳細の右隣の友だちボタン、連携済み遷移、未連携非活性、既存の回答詳細を検証 (exit 0)
- D-2: PASS — `pnpm --filter web test -- src/components/forms-advanced/data-cockpit.test.tsx` → 49 tests passed; 回答上位3列の既定、固定列、チェック切替、フォーム別localStorage往復を検証 (exit 0)
- D-3: PASS — `pnpm --filter worker test -- src/routes/forms-advanced.data.test.ts` → 24 tests passed; アカウント分離したタグ・カスタムフィールド取得と、取得失敗時も検索・ページング済み一覧を200で返すfail-safeを検証 (exit 0)
- D-4: PASS — `pnpm --filter worker test; pnpm --filter web test; pnpm --filter worker typecheck; pnpm --filter web exec tsc --noEmit; NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm --filter web build` → worker 305 files/3822 tests、web 247 files/1874 tests、両tsc、66ページのproduction buildが全て成功 (exit 0)
