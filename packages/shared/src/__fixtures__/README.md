# Formaloo logic 実スキーマ fixtures（formaloo-logic-fidelity Batch 0 spike / R0 実測）

> Batch 0 spike で使い捨て Formaloo フォーム（`spike-*` prefix・作成後 DELETE + verify 404）から捕捉した
> **redacted 実 API response**。owner 実フォーム `Z5IEH85R` は read 含め不使用。secret-scan 0（API key/JWT/email なし）。
> 正本の実スキーマ記述 = `.plans/2026-07-12-formaloo-logic-fidelity/plan.md §Formaloo logic 実スキーマ（R0 実測）`。

## ファイル

- `formaloo-logic-compound-matrix.json`（spike fixture `60`）: AND/OR + 複数アクション + numeric `gt` を
  `PATCH /v3.0/forms/{slug}/ {logic:<bare array>}` で 200 永続 → `GET` 応答。
  - `sent`: PATCH で送った logic 配列 / `getLogic`: GET が返した canonical logic 配列（`.data.form.logic`）。
    両者は object の key 順のみ異なり構造は semantic-deep-equal（server-managed prop 無し）。
  - logic item 形 = `{ type, identifier, actions:[{ action, args, when }] }`。AND/OR は `when` の入れ子再帰木。
- `formaloo-logic-compound-roundtrip.json`（spike fixture `61`）: `60` の GET を再 PATCH → GET の往復。
  - `canonical1`（初回 GET）と `canonical2`（再 PATCH 後 GET）が semantic-deep-equal（`semanticEqual:true`）＝
    preserve-raw（未編集なら raw 配列を verbatim 再送）で往復不変が成立する実測根拠。

## 用途（Batch 1 preserve-only）

- `fromFormalooLogic`（bare-array 射影）の RED 素材（D-2）。
- preserve 往復不変 `semanticLogicEqual` / `serializeRawLogicForPush` の RED 素材（D-5）。
- route end-to-end 配線（D-7）の raw logic 入力素材。
