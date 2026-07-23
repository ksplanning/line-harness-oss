# unanswered-respect-status — 監督ブリーフ (2026-07-23 / owner 実機報告・小中)

## owner 報告
未対応の赤丸の数字と個別チャットの件数は一致するようになった(unanswered-badge-unify OK)。
しかし**「対応済み(完了)」にしたのに未対応とカウントされている**。

## 真因の見当 (レーンで確定)
未対応の正本判定(unanswered-inbox.ts)は「最後の受信に人間の返信があるか」基準のみで、
inquiry-console(migration 137)の**対応状態(未対応/対応中/完了)を参照していない** → 返信せずに完了にしたスレッドが未対応に残る。

## 仕様 (監督指定)
- **完了にしたスレッドは未対応から外れる**(3表示すべて: 一覧/数字バッジ/チャット赤丸 — badge-unify で正本は一本化済みなので正本side 1箇所の修正で3表示に波及するはず)
- **完了後に新しい受信が来たら未対応へ戻る**(見落とし防止・console 側の状態も未対応へ戻す既存挙動と整合)
- 対応中は従来どおり未対応カウントに含める(まだ終わっていないため)。ただし表示上「対応中(担当)」が分かる現状は維持

## 🛡️ 防御語彙
- 判定の正本は unanswered-inbox に一本化のまま(表示側に分岐を足さない)。auto_reply 除外・keep_unresponded の既存挙動不変。
- console の状態遷移ロジック(開いたら対応中等)は不変。migration なし想定(137 の状態テーブルを参照するのみ)。LINE送信ゼロ。

## done_conditions
- id: D-1
  desc: 完了スレッドが未対応カウント/一覧/赤丸から外れる(Red 先行=現状の残存を再現)。TDD
- id: D-2
  desc: 完了後の新規受信で未対応に戻る。対応中は未対応に含まれ続ける。auto_reply/keep_unresponded の回帰テスト green
- id: D-3
  desc: 往復 — 完了→3表示から消える→新規受信→3表示に戻る、を API テストで固定。既存 suite 全 green (worker + web + tsc)
- id: D-4
  desc: live-checklist に host 実測手順(実機で完了→赤丸/数字が減る)。実測は host closer 工程(owner 確認項目)

## live-checklist（host closer / owner確認）

- [ ] 未対応スレッド1件について、一覧表示・数字バッジ・個別チャット赤丸を事前記録する
- [ ] 返信せず inquiry-console で「完了」にする
- [ ] focus／再読込後、必要なら最大30秒待ち、一覧から消える・数字がちょうど1減る・赤丸が消えることを確認する
- [ ] owner実機から同じスレッドへ新規受信し、一覧・数字バッジ・個別チャット赤丸へ戻り、状態も未対応へ戻ることを確認する
- [ ] 日時・アカウント・匿名化したスレッド識別子・WorkerからのLINE送信0件を記録する
- 実測担当: host closer。owner確認項目として実施し、Sola工程では未実施と記録する

## 閉集合
- apps/worker/src/services/unanswered-inbox.ts, packages/db(137状態テーブルの参照DAO最小), 各test, .plans/2026-07-23-unanswered-respect-status/, .sola/。repo外禁止。console状態遷移・webhook変更禁止。
