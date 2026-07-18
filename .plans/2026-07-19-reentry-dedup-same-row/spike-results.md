# reentry-dedup-same-row — Sheets 挙動調査ログ

## 結論

`D-1 result: PASS (docs fallback)` — この sandbox では外向き API 通信と自前 Google Sheet 接続を成立させられなかったため、監督ブリーフが許す Formaloo API・既存実測・公式文書の代替経路で確定した。

- Formaloo の同一 row への flat `PATCH` は、既存 live spike で FRESH GET の `data.row.data` が編集後値になることまで確認済みである。
- Google Sheets の二方向同期では、既存 submission の変更は対応する既存 Sheet 行へ反映され、Formaloo 側で submission を削除すると対応行も削除される。対応キーは Sheet の `Formaloo Record ID` である。
- 標準の一方向同期では、新規 submission は自動追記される一方、Formaloo 側の既存データ変更は `Resync data` で Sheet へ送る、と公式資料が区別している。したがって PATCH 直後の自動反映は保証せず、再同期後の既存行更新として扱う。
- 以上から、row PATCH は「新しい Sheet 行の追加」ではなく、二方向同期なら同じ行を自動更新、一方向同期なら再同期まで旧値のまま・再同期後に同じ行を更新、と分類する。row DELETE の自動行削除は二方向同期について確定し、一方向同期では未実測のため自動反映を保証しない。

## 1. 今回の live 試行

### 安全ガード

- protected set: `GMOxoMtK`, `puw7lh`, `Z5IEH85R`
- 非 GET は protected set を path/body に含んだ時点で拒否する。
- mutation は同じ run で `POST /v3.0/forms/` が返した自作 slug にだけ許可する。
- credentials は `/root/.secrets/formaloo/api-credentials.env` を Bash source し、値を出力しない。
- User-Agent は browser 風 Chrome/126 とした。
- 合成値は `before` / `after` のみを使う設計で、実 PII は使わない。

### 観測結果

- run id: `reentry-dedup-1784393418141`
- 初回 auth request は 2026-07-18T16:50:18.141Z に実行し、Node `fetch failed`、process exit 1。
- 2026-07-18T17:10:11.402Z の同 endpoint 診断でも DNS `EAI_AGAIN`。いずれも `POST https://api.formaloo.net/v1.0/oauth2/authorization-token/` で、form slug を含まず form mutation ではない。
- HTTP response を得た call: 0 件。
- form/field/row 作成: 0 件。
- cleanup 対象: 0 件。使い捨て slug が生成されていないため DELETE→404 工程は不発火。
- protected 3 slug への POST/PATCH/DELETE: 各 0 件、合計 0 件。
- protected 3 slug への送信: 0 件。
- Discord 投稿: 0 件。

秘匿済み機械ログ: `evidence/spike-attempt.json`。

## 2. Google Sheet を接続できなかった理由

完全実測には、Form の owner が Formaloo の Apps & Integrations から、編集権限を持つ Google Sheet の URL と sheet title を指定して接続する必要がある。今回の環境では次がすべて欠けていた。

1. Google Drive plugin の install は提案したが user confirmation が無く、利用可能にならなかった。
2. `gdrive`, `rclone`, `gcloud` は無く、ローカル Google OAuth credential も無かった。
3. owner/editor 権限を持つ使い捨て Sheet URL が briefing に無かった。
4. Formaloo form object の `sync_gsheet` / `user_spreadsheet_id` を API で直接偽装することは、Google OAuth と Sheet editor 権限を満たさず、安全な接続手順ではないため行わなかった。
5. さらに sandbox は Formaloo OAuth endpoint への通信自体を `fetch failed` で止めた。

これは「Sheets を見ずに live PASS とした」のではなく、`tasks.md` D-1 の「不可なら Formaloo API/doc レベルで確定し不可理由を明記」に従った fallback である。

## 3. 採用した一次証拠

### Formaloo row PATCH

- ローカル live 証跡: `REPORT_2026-07-17_152919_edit-save-confirm-fix.html:320,332`
- 使い捨て form `fM6Wpk2u` で row を作成し、flat PATCH 後の GET が `data.row.data` に編集後値を返した記録がある。終了時に form DELETE→GET 404 も記録されている。
- 現行実装: `apps/worker/src/routes/formaloo-public.ts:609-623` は同じ row slug を PATCH し、FRESH GET で全 field の persist を照合する。

### Google Sheets

- [Formaloo: two-way sync setup and behavior](https://help.formaloo.com/en/articles/8456772-how-to-set-up-two-way-sync-between-formaloo-and-google-sheets)（2026-05-28 更新）
  - Formaloo 上の既存 submission の変更は connected Sheet に自動反映される。
  - Formaloo 上の submission 削除は対応する Sheet 行を自動削除する。
  - `Formaloo Record ID` は変更禁止の system column で、対応関係の識別に使われる。
  - 標準一方向同期は新規 submission を自動同期し、既存変更は re-sync で送る、と二方向同期と区別されている。
- [Formaloo: Google Sheets connection troubleshooting](https://help.formaloo.com/en/articles/8194292-i-can-t-connect-my-google-sheets-i-connected-my-google-sheets-but-the-data-doesn-t-sync)
  - form creator と、対象 Sheet への十分な Google editor 権限が接続条件である。
- [Formaloo API documentation](https://help.formaloo.com/en/articles/9310643-formaloo-api-documentation)
  - API key/secret と短命 authorization token の二段認証を確認した。

## 4. D-1 の分類

| 操作 | Formaloo | 二方向 Sheet sync | 標準一方向 Sheet sync | 判定 |
|---|---|---|---|---|
| 同じ row slug を flat PATCH | 同じ row の値が変わる。新 row は作らない | 同じ `Formaloo Record ID` の既存行を自動更新 | 自動反映は保証しない。`Resync data` 後に既存変更を送る | **in-place**。一方向では反映タイミングが手動 |
| 新 submission | 新 row を作る | 新しい Sheet 行を自動追加 | 新しい Sheet 行を自動追加 | **append** |
| row DELETE | 対象 submission を削除 | 対応する Sheet 行を自動削除 | 現行資料だけでは自動削除を保証しない | 二方向は **delete-in-place**、一方向は live 再確認対象 |

「PATCH が Sheet の新行を作らない」は、公式資料が new submission と changes in existing submissions を別動作として定義し、`Formaloo Record ID` で対応行を持つことからの推論である。実 Sheet の poll 結果ではない。この境界を隠さないため、推奨案の production flag を ON にする前に Active integrations で二方向同期 ON を確認するか、editor-owned disposable Sheet で 1 回だけ行数・Record ID を実測する rollout gate を残す。

## 5. D-5 本番不可触監査

`D-5 result: PASS`

- `GMOxoMtK`: mutation 0 / submission 0
- `puw7lh`: mutation 0 / submission 0
- `Z5IEH85R`: mutation 0 / submission 0
- form-data API response を得た application call は 0 件である。記録された 2 回はいずれも form slug を含まない OAuth token request で、DNS 失敗前の guard 判定も `formMutation=false` / `protectedTargetPresent=false` であるため、本番 form の設定・回答は変更されていない。
- repo/plan/report の読取と Formaloo 公式 help page の GET だけを行った。

## 6. 完全 live spike を再実行できる条件

editor-owned disposable Sheet と Formaloo dashboard connection が利用可能になった場合は、同じ合成 marker 1 件について次を上限付き poll で測る。

1. submit 後: Sheet `row_count=1`, `Formaloo Record ID=<rowSlug>`, value=`before`。
2. flat PATCH + Formaloo FRESH GET 後: 最大 120 秒 poll。`row_count=1`, Record ID 不変, value=`after` なら in-place。2 行なら append、旧値のままなら timeout/no-reflection。
3. row DELETE + Formaloo GET 404 後: 最大 120 秒 poll。対応 Sheet 行 0 を確認。
4. 自作 form のみ DELETE→GET 404。未 cleanup が 1 件でも全体 FAIL。
5. protected set への非 GET が 0 であることを監査ログから再確認。
