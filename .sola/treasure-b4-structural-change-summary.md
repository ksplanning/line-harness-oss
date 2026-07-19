# treasure-b4-structural — 変更概要

「複数項目をまとめて聞く表形式と、人数分だけ増やせる入力欄が作れるようになります」

フォーム作成画面に「行列」と「繰り返しセクション」を追加しました。行列では質問の行と回答の列をまとめて設定でき、繰り返しセクションでは人数や注文明細ごとに増やす入力列と最小・最大行数を設定できます。プレビューは構造と制限を表示し、実際の入力操作は hosted form で行うことを明記します。

保存時は Formaloo の field 専用 endpoint と正式な property 名へ変換し、読込時は同じ編集データへ戻します。繰り返し列が参照する field は、作成後に得た remote slug へ解決してから送ります。既存 field の送信内容と fingerprint は変えず、新しい 2 種類にだけ構造を追加します。

回答 mirror は provider row 1 件につき local row 1 件です。matrix の object と repeating section の array/object は `answers_json` の値として形を変えずに保存します。`fr_id` による本人解決と row-status metadata は従来どおり scalar 値だけを扱い、構造値を文字列へ変換しません。

sandbox では Formaloo への実登録をしていません。hosted 表示、実 submit、実際の回答形、webhook の実効確認は `.sola/live-checklist.md` に KS / Piecemaker 別の手順として残しています。
