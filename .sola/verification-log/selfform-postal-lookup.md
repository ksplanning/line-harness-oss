case-scope-echo: caseId=selfform-postal-lookup target_paths=["/root/.openclaw/line-harness-ks/.plans/2026-07-21-selfform-postal-lookup/tasks.md"]

# selfform-postal-lookup verification

検証日: 2026-07-21 JST

## データソース選定 spike

| 観点 | 案A: ZipCloud API | 案B: 日本郵便 UTF-8 CSV + D1 |
| --- | --- | --- |
| Workers からの信頼性 | 外部通信と提供元の継続性に依存。利用規約上、変更・停止の可能性がある | lookup 時の外部依存なし。D1 が利用可能なら自社制御できる |
| 実測レイテンシ | 2026-07-21 の3回で約 0.277〜0.305 秒 | D1 内部 lookup のため外部往復はないが、本 spike では import 前なので未実測 |
| データ鮮度 | 提供元が更新。API 文書表示のデータ更新日は 2026-06-30 | 日本郵便の月次データを自社で再取込する運用が必要 |
| 初期データ量 | 自前保存なし | 公式 UTF-8 CSV は 124,513 行・展開後約 18.36 MiB。重複郵便番号もあり、単純な zip 主キー import にはできない |
| 初期構築 | service と HTTP 防御のみ。migration 不要 | `116_postal_dict`、取込 script、冪等 import、更新 runbook/cron が必要 |
| 無料枠との相性 | API キー不要。外部側のレート上限は明示保証なし | 初回 12 万行超に加え index write もあり、D1 free の 100,000 rows written/day を一括で超える |
| 障害時の正直さ | timeout・503・再試行案内が必要 | 古い辞書を返せる一方、更新失敗を監視する必要がある |

根拠:

- ZipCloud 公式 API: <https://zipcloud.ibsnet.co.jp/doc/api>
- ZipCloud API 利用規約: <https://zipcloud.ibsnet.co.jp/rule/api>
- 日本郵便 UTF-8 データ説明・download: <https://www.post.japanpost.jp/service/search/zipcode/download/utf-readme.html> / <https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html>
- Cloudflare D1 pricing/limits: <https://developers.cloudflare.com/d1/platform/pricing/> / <https://developers.cloudflare.com/d1/platform/limits/>

### 決定

案Aを採用した。W1 の lookup 部品を先行させる目的に対して、migration と辞書更新運用を増やさず、実測約0.3秒で住所を取得できるためである。外部依存の弱点は、2秒 timeout、HTTP/JSON/返却郵便番号の検証、複数住所を勝手に選ばない 409、外部障害の 503、正常1時間・未登録5分 cache、最大1,000件 LRU、postal 専用 IP 100件/分 bucket で抑えた。したがって `116_postal_dict` は作成していない。

## 実在データ実射

実装した Hono route と実 service を ZipCloud へ接続したローカル実射結果:

```text
5690000 200 {"pref":"大阪府","city":"高槻市","town":""}
1000001 200 {"pref":"東京都","city":"千代田区","town":"千代田"}
0600000 200 {"pref":"北海道","city":"札幌市中央区","town":""}
0000000 404 {"error":"Postal code not found"}
```

## done 条件の機械検証

- D-1: PASS — `pnpm --filter worker exec vitest run src/services/postal-lookup.test.ts src/routes/postal-lookup.test.ts src/middleware/auth-method-aware.test.ts src/middleware/permission-map.test.ts src/middleware/rate-limit.test.ts src/not-found.test.ts` → 6 files / 62 tests passed、実 route + ZipCloud 実射は 5690000・1000001・0600000 が正しい住所、0000000 が 404 (exit 0)
- D-2: PASS — `pnpm --filter worker run test` → route mount・GETだけ公開・形式不正400・未登録404・曖昧409・外部障害503・postal専用100/min bucket・既存form submit枠との分離を含む 241 files / 2579 tests passed (exit 0)
- D-3: PASS — `pnpm run test:scripts && pnpm --filter @line-crm/db --filter @line-harness/sdk --filter @line-crm/shared --filter @line-harness/update-engine --workspace-concurrency=1 run test && pnpm --filter web exec vitest run --config vitest.config.ts --maxWorkers=1 && pnpm --filter worker run test && pnpm -r --workspace-concurrency=1 --if-present run typecheck && pnpm --filter web exec tsc --noEmit && NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm --filter web run build && git diff --exit-code aea16fd5013973e6d8dc25e02e21b8509ff21339 -- apps/worker/src/routes/formaloo-public.ts apps/worker/src/services/formaloo-webhook.ts apps/worker/src/services/formaloo-row-edit.ts apps/worker/src/services/formaloo-friend-token.ts` → 全7 suite合計 4,988 tests passed、全typecheck rc0、62 static pages + Exporting 2/2、保護4ファイル差分なし (exit 0)
- D-4: PASS — `test -s .sola/live-checklist.md && test -s .sola/selfform-postal-lookup-integration.md && rg -n --fixed-strings '郵便番号から住所を自動で引ける部品ができました。' .sola/live-checklist.md` → host実射3件+異常系checklist、W1/W2 config/API/UI統合仕様、owner日常語を確認 (exit 0)
