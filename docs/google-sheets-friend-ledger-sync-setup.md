# 友だち台帳の編集をすぐ反映する設定

この設定をすると、Google スプレッドシートの選択した個人情報欄を編集した直後に、LINE ハーネスへ通知されます。5分ごとの自動確認も別に動くため、一時的に通知できなくても次の確認で追いつきます。

秘密の JSON や合言葉は、画面・この文書・Git へ書きません。サービス アカウントの JSON は Apps Script へ貼らず、Worker secret の `GOOGLE_SERVICE_ACCOUNT_JSON` にだけ置きます。

## 1. Worker に通知用の合言葉を入れる

作業用端末で `apps/worker` を開き、次を実行します。

```bash
pnpm exec wrangler secret put SHEETS_WEBHOOK_SECRET --config wrangler.ks.toml
```

32文字以上の新しい合言葉を入力してください。コマンド履歴へ合言葉そのものを書かないでください。Apps Script の設定でも同じ値を1回だけ使います。

## 2. Apps Script をコピペ1回で入れる

1. 対象スプレッドシートを開きます。
2. 上のメニューから「拡張機能」→「Apps Script」を開きます。
3. 最初からあるコードを全部消します。
4. `docs/google-sheets-friend-ledger-onedit.gs` の中身を、最初から最後までコピペ1回で貼り付けて保存します。
5. 左の歯車「プロジェクトの設定」→「スクリプト プロパティ」で、次の5項目を追加します。

- `SHEETS_WEBHOOK_URL`: Worker の公開URLの末尾に `/integrations/google-sheets/friend-ledger/webhook` を付けたもの
- `SHEETS_WEBHOOK_SECRET`: 手順1で Worker に入れたものと同じ合言葉
- `SHEETS_CONNECTION_ID`: LINE ハーネスの接続設定に表示される接続ID
- `SHEETS_SPREADSHEET_ID`: スプレッドシートURLの `/d/` と `/edit` の間
- `SHEETS_SHEET_NAME`: 友だち台帳のタブ名

サービス アカウントの JSON や秘密鍵は、ここへ追加しないでください。

## 3. インストール型の編集時トリガーを作る

1. Apps Script 上部の関数一覧で `installFriendLedgerSync` を選び、「実行」を押します。
2. Google の確認画面で、このスプレッドシートの編集と外部通信を許可します。
3. 左の時計「トリガー」を開き、`friendLedgerOnEdit` が「スプレッドシートから」「編集時」になっていれば完了です。

この操作は1回だけです。もう一度実行しても古いトリガーを消して作り直すため、通知が二重になりません。

## 4. 動作を確かめる

1. LINE ハーネスの「Google スプレッドシート連携」を開きます。
2. 対象のカスタム項目を選び、まず「手動同期」を押します。
3. シートに「表示名」「userId」「登録日」と、選んだ項目名が出たことを確認します。
4. 選んだカスタム項目のセルを1つ編集します。表示名・userId・登録日は保護列なので編集しません。
5. LINE ハーネスで値が変わり、「監査ログ」に編集者・項目名・変更前・変更後が出ることを確認します。

通知するのはシート名と編集範囲だけです。セルの内容は通知本文へ入れず、署名を確認したWorkerがGoogle Sheets APIから読み直します。

## 困ったとき

- 「署名を確認できません」: Worker とスクリプト プロパティの `SHEETS_WEBHOOK_SECRET` が同じか確認します。
- 「見出しが変わっています」: 見出しをLINE ハーネスの項目名へ戻してから手動同期します。
- 「接続できません」: 対象シートをサービス アカウントへ編集者として共有し、`GOOGLE_SERVICE_ACCOUNT_JSON` の設定を確認します。
- 即時通知が止まっても、5分ごとの確認が追いつきます。慌ててセルを連打しないでください。

## すぐ止める（ロールバック）

Apps Script の左の時計「トリガー」で `friendLedgerOnEdit` のトリガーを削除すると、即時通知だけ止まります。LINE ハーネス側の接続設定を停止・削除すると、5分ごとの同期も止まります。秘密値を文書やチャットへ貼らず、必要なら Worker secret を入れ替えてください。
