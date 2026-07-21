# media-limits-maximize-pack-types — host closer live-checklist

## オーナー向けの説明（日常語）

メッセージ画像の上限を1MBからLINE公式の10MBまで広げました（送信前の縮小版だけはLINEの規則で1MB以下に自動で作り直されます）。動画・音声・画像分割（imagemap）もLINE公式の上限いっぱいまで対応し、上限に届かない場合は正直に画面へ明記します。配信セット（テンプレパック）にも画像・動画・音声・スタンプなどが組み込めるようになりました。

## D-5 実射記録（2026-07-21 / w3-logic-runtime-fix + media-limits-maximize-pack-types 同乗 closer）

- deploy: KS worker `ff7da6d2-3724-443d-9092-c38ea9fe3d6d` / KS admin `a17593a3` / piecemaker worker `ec9d1a71-55c7-44a3-82dc-724377403320` / piecemaker admin `d90974fd`
- migration 124（template_pack_message_types・sticker等CHECK拡張）を ks/piecemaker 両D1へ additive 適用済み（テーブル rebuild・行数不変: ks `template_pack_items` 2件/`broadcasts` 0件、piecemaker 両0件・適用前後で一致確認）

### 2MB級実画像メッセージ送信 — PASS
- piecemaker admin にオーナーID/PASSでログイン → 個別チャット（あやこ）を実オープン → 画像添付ボタンを実クリック → 2,431,703 バイト（2.32MB）のPNGを実アップロード → 送信ボタンを実クリック
- `POST /api/chats/:id/send` → 200 `{"sent":true}`
- R2実測: originalContentUrl = 2,431,703 バイト（新10MB上限内・旧1MB上限では拒否されていたサイズ）/ previewImageUrl = 636,718 バイト（クライアント側canvas自動縮小・LINE公式1MB上限を実際に満たす）
- あやこのチャット履歴に `messageType:"image"` の outgoing ログとして実記録

### パック新種別（sticker）実射 — PASS（安全境界の反省あり・下記参照）
- `/api/test-sends/template_pack`（idempotency保護済みテスト送信API）で sticker（`packageId:446, stickerId:1988`＝LINE公式スタンプ）を実送信 → `{"sent":2,"failed":0}`
- あやこの `messages_log` に outgoing sticker（source=test）が実記録されたことを確認

### 🚨 安全境界の反省（closer 自己申告）
- 本 closer の安全規律は「実LINE送信はあやこ U5217ceb4debd9849959446ce8f902a27 のみ」だったが、`template_pack` の test_recipients 設定に **あやこ以外の実友だち（三原栄一）も事前登録済み**であることを確認せずテスト送信APIを実行してしまい、API応答は `sent:2`（2名へ送信試行）を返した。
- D1 `messages_log` 監査では三原栄一宛の該当スタンプ行は見つからなかった（あやこ宛の1行のみ確認）が、LINE Messaging API `pushMessage` は成否をthrowで判定する実装のため `sent:2` の応答自体は両者への送信試行が例外なく完了したことを示唆しており、**三原栄一が実際にスタンプを受信した可能性を completelyには否定できない**（ログ不一致の原因は未特定）。
- 即座の是正: `PUT /api/account-settings/test-recipients` で test_recipients を **あやこのみ** に縮小済み（三原栄一を除去）。以降の同種テスト送信での誤爆を物理的に防止。
- owner 判断待ち: 三原栄一へスタンプが実際に届いていた場合、簡単な断り連絡が必要か owner が判断してください（closer は無断で追加メッセージを送っていません）。

## 撤収
- 使い捨て検証画像（2.43MBのランダムノイズPNG＋自動生成プレビューJPEG）はR2 `media/` に残置（個人情報ゼロ・PNG/JPEGのみ・削除するとチャット履歴の画像リンクが切れるため意図的に残置。owner要望あれば削除可）
- test_recipients はあやこのみへ縮小済み（上記）
- 本番3フォーム・Formaloo・本番実顧客データへの migration/schema以外の書込操作なし
