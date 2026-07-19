# 新テナント開通チェックリスト（LINE ハーネス全テナント共通）

> 正本: `.plans/2026-07-18-fr-id-capture-fix/`（spec R5 / T-D1）。
> 新テナント（例: piecemaker=夢花火）を LINE ハーネスに載せる時、**再入場 prefill（/fo の fr_id 捕捉）を
> 含む導線がそのまま効く**ために焼き込む地雷チェックリスト。deploy 伝播そのものは
> `docs/piecemaker/propagation-runbook.md`（3 段）を参照。

## 開通チェック項目（各テナントで確認）

- [ ] **(i) LIFF endpoint 配線** — LIFF アプリの endpoint URL がテナントの admin/worker origin を指す。
      誤配線だと fo-liff の起点解決が壊れる。
- [ ] **(ii) LINE login channel** — friend↔user link 用 login channel（`LINE_LOGIN_CHANNEL_ID` /
      `LINE_LOGIN_CHANNEL_SECRET`）がテナント固有値で設定済。※ Tier B の login_channel_id 是正は別工程。
- [ ] **(iii) fr_id / fr_name フィールドは alias 必須** — **これが本 case の地雷**。
      Formaloo hosted の URL prefill は **field の `alias` でのみ**一致する（field slug 名 param は無効・
      planner LIVE spike F1/F2 実測）。`/fo` は `?fr_id=<署名>` `?fr_name=<表示名>` を付与するので、対象 form に
      `alias='fr_id'` / `alias='fr_name'` の **hidden field** が実在しないと fr_id が row に載らず friend_id 復元 0 =
      再入場 prefill 白紙になる。
    - **自動化**: publish 経路（`pushDefinitionToFormaloo` → `ensureSystemHiddenFields`）が
      `type='hidden'` + `alias='fr_id'`/`'fr_name'` の system field を**冪等 auto-push**する（全/将来テナント標準装備）。
      既定有効。`FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE='1'` で短絡（rollback）。
    - **手動フォーム / Formaloo 管理画面直作成フォーム**は auto-push を通らないことがある → その場合は
      各 field に alias を手動設定するか、下の O-6 backfill を回す。
    - **⚠️ logic は位置条件つきで共存可（T-C7 / grammar 実測 2026-07-19）**: Formaloo の
      **「回答されたら送信」(`is_answered(X)→submit`) はトリガー X の position 以降の field を保存しない**。
      `fr_id` を先頭 (`position 0`) に固定すれば再入場 prefill と logic は共存できる。`fr_id` がトリガーより後ろに
      ある場合だけ `ensureSystemHiddenFields` / `checkSystemFieldHealth` の `logicConflict` で検知し、
      `syncStatus='out_of_sync'` + owner 向け位置修正 message を表示する。
- [ ] **(iv) `VITE_LIFF_ID` bake** — テナント固有 LIFF ID で web/worker を再 build（空焼き禁止）。
      空焼きは fo-liff 無限ループ / ぐるぐるの回帰源。deploy は必ずテナント build env で再 build
      （propagation-runbook §2 / build-env-rebuild.md）。
- [ ] **(v) fr_name（氏名）は PII** — fr_name は LINE 表示名 = 氏名相当の個人情報。
    - **用途**: Google Sheets の列に「どの LINE アカウントの回答か」を可読化するため（owner 意図）。
    - **owner-gate**: `FORMALOO_FR_NAME_AUTOPUSH_DISABLE='1'` で fr_name の auto-push だけを切れる
      （fr_id=identity は残る）。PII 保守テナントは off にできる。
    - **取り扱い**: fr_name は URL query / Referer / ログに載り得る。ログ redaction・Referer 漏洩に留意し、
      保持は最小限（識別に必要な範囲）。

## system hidden field の仕組み（実装参照）

- 単一正本: `packages/shared/src/formaloo-forms.ts` の `FRIEND_SYSTEM_FIELDS` / `isFriendSystemAlias`。
- 冪等 ensure / 健全性チェック / backfill: `apps/worker/src/services/formaloo-system-fields.ts`。
- pull/drift 除外（逆流・false-drift ゼロ）: `formaloo-pull.ts` / `formaloo-fingerprint.ts` が `isFriendSystemAlias` で除外。

## O-6 — 再 publish されない既存フォームへの backfill（owner_role: infra-ops）

`ensureSystemHiddenFields` は publish 時に走るため、**再 publish されないフォーム**（ks/TRïNA の既存フォーム・
過去コピー）は hidden field を持たないか、末尾に配置されたままになり得る。恒久標準装備を担保するには backfill を回す:

1. テナント別（ks / piecemaker）の稼働フォーム inventory を作成（formaloo_slug 一覧）。
2. `backfillSystemHiddenFields(client, formSlugs[], { includeOwnerGated })` を実行（通常 field/回答は不可触。予約 field の追加と先頭への位置修復だけを行う）。
3. **除外**: Z5IEH85R / puw7lh 等 owner 実フォームは owner 承認が要る → inventory から外すか承認後に実行。
4. 対象総数 / 修復数 / 除外数 / out_of_sync（衝突）を記録。未実施フォームは残タスクとして明示（殻完了禁止）。

## D-5 — release gate 順序（drift cron 誤検知の回避 / codex#5）

除外ロジックを先に deploy してから auto-push を有効化する:

1. pull/drift **除外ロジックを `FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE=1` で先行 deploy**。
2. drift cron が正常（system field 無しでも既存フォーム drift 誤検知ゼロ）を確認。
3. 本番 field 是正（③ qBSQdjyz の alias='fr_id' / owner_role: infra-ops）。
4. **auto-push を有効化**（`FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE` を外す / ④）。

各段の gate 通過を REPORT に記録。

## rollback

- ④ auto-push 無効化: `FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE='1'`（byte 同等 = Layer A land 済の現状へ復帰）。
- fr_name のみ無効化: `FORMALOO_FR_NAME_AUTOPUSH_DISABLE='1'`。
- ③ field 是正の rollback: `PATCH /v3.0/fields/qBSQdjyz/ {alias:<元値>}` もしくは `DELETE /v3.0/fields/qBSQdjyz/`
  （捕捉値が無いことを確認できた時のみ DELETE）。

## R-2 — 残余リスク（識別≠認証 / codex#1）

friend-token は friendId のみ束縛する署名（forgery は防ぐが、leaked/共有された valid token の
replay / cross-form / cross-tenant は署名では防げない）。これは **owner が受容した識別境界**であり、
PII-safe を無条件完了扱いにしない。tenant/form/期限束縛への拡張は別案件の owner 判断。
