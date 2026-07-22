case-scope-echo: caseId=sheet-instant-setup-helper-ui target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-22-sheet-instant-setup-helper-ui/tasks.md"]

- D-1: PASS — `pnpm --dir apps/web exec vitest run src/components/forms-advanced/internal-sheets-setup-panel.test.tsx src/components/forms-advanced/internal-sheets-instant-setup.contract.test.tsx --reporter=dot` → 2 files / 9 tests passed。モーダル、日常語5ステップ、5項目の名前・値コピー、Apps Script全文コピーを確認 (exit 0)
- D-2: PASS — `pnpm --dir apps/web exec vitest run src/lib/sheets-connections-api.webhook-secret.test.ts src/lib/sheets-connections-api.test.ts --reporter=dot` と `pnpm --dir apps/worker exec vitest run src/routes/sheets-connections.test.ts src/routes/sheets-friend-ledger-docs.test.ts --reporter=dot` → web 2 files / 7 tests、worker 2 files / 22 tests passed。押下時取得、伏字、表示/隠す、close・接続変更時破棄、未保存案内、接続とLINE accountの二重スコープを確認 (each exit 0)
- D-3: PASS — `pnpm --dir packages/shared test`、`pnpm --dir apps/web test`、`pnpm --dir apps/worker exec vitest run --silent --reporter=default --testTimeout=60000`、3 workspaceの`tsc --noEmit`、`NEXT_PUBLIC_API_URL=https://api.example.test pnpm --dir apps/web build`、`sha256sum docs/google-sheets-friend-ledger-onedit.gs apps/web/out/_next/static/media/google-sheets-friend-ledger-onedit.414686e6.gs` → shared 43 files / 533 tests、web 223 files / 1678 tests、worker 282 files / 3394 tests、型検査3本、64 pages buildが全て成功。正本と配布assetは同一SHA-256 `860bd34e6f2223fb208469b1cf683801ffbd981a717004c4ee16793d3778ecaf`、migration変更なし (each exit 0)
- D-4: PASS — `pnpm --dir apps/web exec vitest run src/components/forms-advanced/internal-sheets-setup-panel.test.tsx src/components/forms-advanced/internal-sheets-instant-setup.contract.test.tsx --reporter=dot` と `rg -n '^# sheet-instant-setup-helper-ui' .sola/live-checklist.md` → grandma desk観点9 tests passed、owner日常語と「モーダル表示→5項目コピー→Apps Script全文コピー→実貼付→1セルの即時反映」のtrusted-host手順を2735行目から収録 (each exit 0)

## TDD Red evidence

- API test先行: `sheetsConnectionsApi.webhookSecret is not a function` を観察してから最小配線を追加 (exit 1 → exit 0)
- UI contract test先行: accessible name `即時反映の設定を見る` が存在せず2 tests failedを観察してからモーダルを追加 (exit 1 → exit 0)
- grandma review test先行: 5ステップ要約、固定コピー通知、見える「名前をコピー」が不足するRedを順に観察してから導線を修正 (exit 1 → exit 0)
- production build回帰: shared buildだけでDOM型がなく `Cannot find name 'URL'` を観察し、browser asset moduleへDOM lib参照を限定追加。worker buildとbundle testを再実行してGreen (exit 2 → exit 0)

## Security and single-source closure

- 署名キーは既存の認証済み管理APIから接続単位で押下時だけ取得し、master secretやサービスアカウントJSONは扱わない。stateはconnection IDとLINE account IDの両方へ結び、別accountへの切替時も再利用しない。
- `rg -l "var FRIEND_LEDGER_PROPERTY_NAMES" docs/google-sheets-friend-ledger-onedit.gs packages/shared/src apps/web/src/components/forms-advanced/internal-sheets-setup-panel.tsx` → script本体はdocs正本だけ。Web build assetとの`cmp -s`も成功 (exit 0)
- base `c0caff009` からの変更はweb UI/APIと関連test、shared asset loader/test、`.sola`証跡だけ。worker route、migration、LINE送信経路の変更なし。

## Host closer handoff

- trusted hostでの実クリックはlane sandboxでは未実施。`.sola/live-checklist.md` の本件host欄は意図的に未チェックのままにし、査読済みrevision反映後、使い捨てフォーム・接続・シートだけで実測する。
- hostで実測するまで「実際に即時反映が動いた」とは扱わない。安全な使い捨て資材が無ければ本番資材で代用せずBLOCKEDとする。

## Regression note

- worker全suite初回は無関係なbootstrap同期test 1件が並列負荷下の30秒上限でtimeout。単体再実行は9/9 Green、全suiteを60秒上限で再実行して282/282 files・3394/3394 tests Greenを確認した。
