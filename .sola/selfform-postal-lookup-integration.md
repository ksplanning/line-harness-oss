# selfform-postal-lookup — internal renderer 統合仕様

## 目的と境界

自前フォームの郵便番号欄に置く「住所を入力」ボタンから `GET /api/postal-lookup` を呼び、都道府県・市区町村・町域の text field を補完する。今回できたのは lookup API までであり、renderer への UI 実装は W2/W3 の担当とする。Formaloo、本番3フォーム、既存フォーム定義には触れない。

## 推奨 config

郵便番号となる text field の `config` に、次の additive な設定を持たせる。

```json
{
  "postalAutofill": {
    "zipField": "postal_code",
    "prefField": "prefecture",
    "cityField": "city",
    "townField": "town"
  }
}
```

- 4 値は同一フォーム内の一意な field ID。設定を持つ欄と `zipField` は一致させる。
- source と target はすべて 1 行 text field とし、4 ID の重複、参照先なし、自己参照以外の循環を保存時に拒否する。
- W2 では internal renderer 用 field schema と validator に `PostalAutofillConfig` を追加する。Formaloo へ送る定義・変換・fingerprint には混ぜない。
- 設定なしの既存フォームは現在の表示・保存・送信挙動をそのまま保つ。

## API 契約

`zip` はハイフンなし半角数字 7 桁で送る。renderer 側は入力中の空白と `-` を除いてから 7 桁かを検査し、条件を満たしたときだけ明示ボタンを有効にする。

| HTTP | 意味 | renderer の動作 |
| --- | --- | --- |
| 200 | `{pref, city, town}` を取得 | 3 target へ反映し、成功を短く通知する |
| 400 | 形式不正 | 現在値を保ち「郵便番号を7桁で入力してください」と表示する |
| 404 | 該当なし | 現在値を保ち「住所が見つかりません。手入力してください」と表示する |
| 409 | 複数住所候補 | 現在値を保ち「住所を一意に決められません。手入力してください」と表示する |
| 429 | 回数制限 | 現在値を保ち、少し待って再試行する案内を出す |
| 503 | 外部参照先の一時障害 | 現在値を保ち、手入力または再試行を案内する |

## UI と状態遷移

1. 利用者が郵便番号を入力し「住所を入力」を押す。
2. ボタンを disabled にし、同じ欄の直前リクエストを `AbortController` で中止して lookup する。
3. 成功時だけ target を更新する。利用者がすでに入力した非空 target は勝手に上書きせず、未入力 target のみ補完する。
4. 失敗時は入力値を一切消さず、郵便番号欄の近くに日本語メッセージを出す。
5. 完了後にボタンを戻す。返答前に郵便番号が変わった古いレスポンスは捨てる。

自動補完後の各欄は通常の手入力と同じ値として扱い、利用者が修正できる。送信 payload、必須検証、dirty state、再描画後の保持も手入力時と同じ契約にする。

## W2/W3 の受け入れ確認

- config の有無、不正参照、成功、400、404、409、429、503、連打時の stale response を component test で確認する。
- 既入力 target を保持し、空欄だけを補完することを確認する。
- keyboard だけでボタンを操作でき、処理中と結果が支援技術へ通知されることを確認する。
- approved host では `.sola/live-checklist.md` の実在郵便番号を使い、本番3フォームとは無関係な scratch form だけで確認する。
