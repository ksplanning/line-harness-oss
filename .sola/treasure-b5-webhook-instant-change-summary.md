# treasure-b5-webhook-instant 変更概要

## owner 向けの一言

回答が届いた瞬間に管理画面へ反映されるようになる (最大6時間待ち→即時)。

## 何が変わったか

- form 単位の「回答を即時反映」トグルを追加した。既定値は OFF なので、今のフォームは勝手に変わらない。
- ON で Formaloo outbound webhook を登録し、submit event が本当に ON だと read-back で確認できたときだけ有効化する。OFF で remote 登録も解除する。
- callback は保存済み form と secret/path を照合し、送信 payload の回答値は信用しない。Formaloo から最新行を最大1 page / 10件だけ取り直し、既存 mirror upsert と friend metadata 反映経路へ渡す。
- D1 の generation、form-global lease、cooldown で連打と複数 Worker isolate の同時 pull を抑え、末尾 callback は次の pull へ繰り越す。provider 通信と job に有限の期限を持たせた。
- POST の成否が不明で webhook id が取れなかった場合も、D1 に先行保存した URL から OFF 時に remote 登録を回収できる。

## データと安全境界

- additive migration は `106_formaloo_webhook_registration.sql` だけ。105 予約には触れていない。
- callback URL/secret/webhook id は D1 に保存するが、管理 API と UI へは返さない。未知・OFF・secret 不一致は同じ 404 にする。
- 保護対象の既存 4 経路と `forms-advanced.ts`、`builder.tsx`、shared form schema は base revision から byte 不変。
- 本番 3 フォームと外部資源は sandbox から一切操作していない。実射は `.sola/live-checklist.md` に分離した。

## 検証結果

- worker: 212 files / 2,339 tests PASS
- DB: 65 files / 438 tests PASS
- shared: 31 files / 421 tests PASS
- web: 143 files / 1,059 tests PASS
- worker / DB / shared / web TypeScript: exit 0
- migration 106 validator、bootstrap sync、両 tenant 回帰 24 tests、保護ファイル diff: すべて exit 0

## rollout と rollback

1. migration 106 を適用し、worker と web を同じ査読済み revision で deploy する。
2. trusted host で `.sola/live-checklist.md` を KS、PIECE MAKER の順に、別の使い捨て form で実行する。
3. 異常時は対象 form のトグルを OFF にする。remote 解除が失敗しても callback 受信は先に止まり、情報を保持して再解除できる。additive 列はそのまま残してよい。
