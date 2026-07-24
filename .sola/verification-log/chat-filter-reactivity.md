case-scope-echo: caseId=chat-filter-reactivity target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-24-chat-filter-reactivity/tasks.md"]

tdd-red: `pnpm --filter web test -- src/app/chats/chat-inline-draft.test.tsx` → 新規6件が期待どおり FAIL（一覧行が2件残る / openInquiry 0 calls）、既存21件は PASS (exit 1)
- D-1: PASS — `pnpm --filter web test -- src/app/chats/chat-inline-draft.test.tsx src/app/chats/chat-history-popup.test.tsx` → Test Files 2 passed / Tests 37 passed、未対応・未読・対応中の各絞り込みで API 応答待ち中にも行が即時に消える (exit 0)
- D-2: PASS — `pnpm --filter web test -- src/app/chats/chat-inline-draft.test.tsx src/app/chats/chat-history-popup.test.tsx` → 開封後の除外・未読に戻す再表示・success:false rollback を含む Tests 37 passed (exit 0)
- D-3: PASS — `pnpm --filter web test` → Test Files 243 passed / Tests 1812 passed (exit 0); `pnpm --filter web exec tsc --noEmit --incremental false` → diagnostics 0 (exit 0); `git show --format= --name-only ae7b4b659bfc5df999faff1509a58d3fbaf826b1` → apps/web の3ファイルのみ、server・migration 変更なし (exit 0)
- D-4: PASS — `rg -n "画面遷移・再読み込み・30秒 poll|LINE 送信 API|owner 実機確認: 完了操作" .plans/2026-07-24-chat-filter-reactivity/live-checklist.md` → host 実測手順・LINE送信0件・owner確認欄を検出 (exit 0)
