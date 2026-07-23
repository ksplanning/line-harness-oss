case-scope-echo: caseId=operator-chat-layout target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-23-operator-chat-layout/tasks.md"]

TDD Red: `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/app/chats/chat-inline-draft.test.tsx src/app/chats/chat-history-popup.test.tsx src/components/chats/canned-response-picker.test.tsx src/components/shared/personalized-text-editor.test.tsx` → 4 files failed / 8 tests failed / 38 passed (exit 1)。期待した未実装点（48px textarea、sticky composer、既定折りたたみ設定、1行 header、可視ラベル、入力横送信）で失敗。

追補 TDD Red: `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/app/chats/chat-inline-draft.test.tsx -t '48pxから約5行まで伸びる入力欄'` → 実ブラウザ相当の余白・行高契約が未実装で 1 test failed (exit 1); `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/app/chats/chat-history-popup.test.tsx -t 'composerをmobile下端へ固定'` → mobile 詳細が viewport 全体を使わず 1 test failed (exit 1)。最小実装後は各 1 test passed (exit 0)。

実ブラウザ補助確認: Playwright から Chromium 390 × 667 で同一 textarea CSS を計測し、修正前は空欄 `scrollHeight=64 / height=64`、修正後は 0〜2行 `height=48`・7行 `height=120` (exit 0)。

全体 suite の初回既定並列実行では、今回の差分外であるフォームビルダー 3 テストだけが 5 秒 timeout（240 files / 1795 tests は pass）。該当 2 files の単独再実行は 80 / 80 tests pass、worker 数を 2 に抑えた同一全体 suite は 242 / 242 files・1798 / 1798 tests pass。

- D-1: PASS — `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/app/chats/chat-inline-draft.test.tsx src/app/chats/chat-history-popup.test.tsx src/components/chats/canned-response-picker.test.tsx src/components/shared/personalized-text-editor.test.tsx` → 48px〜120px 自動伸縮、既定で畳む送信設定と保存後再取得、sticky composer、3操作の文字ラベル、本文16pxを含む 4 files / 46 tests passed (exit 0)
- D-2: PASS — `rtk pnpm --filter web exec vitest run --config vitest.config.ts src/app/chats/chat-inline-draft.test.tsx src/app/chats/chat-history-popup.test.tsx` → mobile の viewport 全画面詳細、履歴の flex 主役構造、1行 header、通常送信・メモ保存・対応状態・拡大表示の回帰を含む 2 files / 30 tests passed (exit 0)
- D-3: PASS — `rtk pnpm --filter web exec vitest run --config vitest.config.ts --maxWorkers=2` → 242 files / 1798 tests passed (exit 0); `rtk pnpm --filter web exec tsc --noEmit --incremental false --pretty false` → diagnostics なし (exit 0); `git diff --quiet d93b97152 -- packages/db apps/worker` → migration・worker 差分なし (exit 0)
- D-4: PASS — `rg -n -e 'historyRatio >= 50' -e 'sendInsideViewport === true' -e 'chat-desktop-after.png' -e 'chat-mobile-after.png' .sola/live-checklist.md` → desktop/mobile 履歴比率、mobile viewport 内操作、before/after screenshot の host closer 実測手順を検出 (exit 0)
