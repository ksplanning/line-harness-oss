# chat-history-popup — Sola verification log

- Base: `85f2390a80f0766eb7c5c761b3d2a943c4421c1b` (`origin/main`)
- Feature commit: `d460c4adb02b761accd555a6fd3d5b35e189baa6`
- Media-load fix commit: `fdbe2838c221fe7b9beb5b132f02abcffb304758`
- Scope: `apps/web` の個別チャット履歴に additive な拡大モーダルを追加。worker と本番 API / DB は変更していない。

## 対象特定

`apps/web/src/components/friends/friend-list-row.tsx:24` の友だち行は `/chats?friend=<friend-id>` へ遷移する。`apps/web/src/app/chats/page.tsx:525` が選択した友だちの履歴を `api.chats.get(chatId)` で取得し、同ファイル `:108` の共有 `ChatMessageHistory` が、従来の狭い履歴 (`:1116`) と拡大モーダル (`:1281`) の両方を描画する。この右側 LINE 風履歴を owner 原文の「個別のチャット履歴をチャット風の窓」と確定した。

## TDD 証跡

- Red 1: 実装前に新規テストを実行し、「チャット履歴を拡大表示」ボタンが存在しないため 4 tests failed を確認した。
- Green 1: 共有履歴と開閉処理の最小実装後、同じ 4 tests passed を確認した。
- Red 2: レビュー指摘をテスト化し、前面 z-index、390px media 幅、遅延スクロール、Tab フォーカスの失敗を確認した。
- Green 2: `z-[70]`、280px Flex 上限、ユーザースクロール保護、フォーカストラップを実装し、対象 7 tests passed を確認した。
- Red 3: 150ms より後のメディア伸長をテスト化し、`ResizeObserver` が未登録で 1 test failed を確認した。
- Green 3: 各メッセージの高さ変更を監視し、閲覧者が上へ動くまでは最新へ追従、動いた後は位置を維持して、対象 8 tests passed を確認した。

## done_conditions

- D-1: PASS — `rg -n 'router\.push|api\.chats\.get|function ChatMessageHistory|Messages — LINE-style chat bubbles|チャット履歴を拡大表示|role="dialog"' apps/web/src/components/friends/friend-list-row.tsx apps/web/src/app/chats/page.tsx` → `/friends` 行 `:24` → `/chats?friend=` → `api.chats.get` `:525` →共有履歴 `:108`／従来窓 `:1116`／モーダル `:1281` を特定。D-4 の platform 契約に従い lane 内実レンダーは行わず、static export と host 手順で受入点を固定した (exit 0)
- D-2: PASS — `pnpm --filter web test -- src/app/chats/chat-history-popup.test.tsx` → 1 file passed、8 tests passed。同一履歴内容、desktop 約90%／mobile 全画面、遅いメディア伸長後の最新追従と読書中スクロール維持、×／背景／Esc、フォーカス、前面表示、390px media 幅を検証した (exit 0)
- D-3: PASS — `pnpm --filter web test`、`pnpm --filter web exec tsc --noEmit --incremental false --pretty false`、`NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm --filter web build` → 138 files passed、1040 tests passed、tsc diagnostics なし、`/chats` を含む static prerender 成功 (各 exit 0)
- D-4: PASS — `test -f .sola/visual-checklist.md && rg -n 'pnpm --filter worker dev|NEXT_PUBLIC_API_URL=http://127\.0\.0\.1:8787 pnpm --filter web dev|http://127\.0\.0\.1:3001/chats|desktop|mobile|おばあちゃん|line-harness-ks|piecemaker|Esc|背景' .sola/visual-checklist.md` → lane で server を起動せず、host 起動コマンド、URL、1440 × 900、390 × 844、開閉、同一内容、最新スクロール、初見5秒、両テナントの実レンダー手順を全て収録した (exit 0)
- D-5: PASS — `git diff --name-only 85f2390a80f0766eb7c5c761b3d2a943c4421c1b..HEAD -- apps` と保護4ファイルへの `git diff --quiet`、production page の tenant ID 検索 → app 差分は `apps/web` の2ファイルのみ、formaloo-public／formaloo-webhook／formaloo-row-edit／formaloo-friend-token は差分なし、tenant／account 固定値なし (exit 0)
