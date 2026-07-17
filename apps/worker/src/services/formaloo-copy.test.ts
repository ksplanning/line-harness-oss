/**
 * form-jp-localization worker push helpers。
 *  - formCopyFields: FormCopy(非空 string)→ Formaloo form 直キー (button_text/success_message/error_message)。
 *  - confirmFormCopyReflected: meta PATCH 後に GET-after-PATCH で反映を確認 (soft-200 対策・design と同型)。
 * spike(2026-07-17 confirmed-table): hosted 公開ページは form 直下 top-level string をそのまま直読描画する
 *   (色のような JSON-string RGBA format 罠なし)。ただし form PATCH は存在しないキーを soft-200 で無言無視
 *   するため、metaRes.ok だけでなく GET-after-PATCH で反映を確認して殻完了を防ぐ。
 */
import { describe, test, expect, vi } from 'vitest';
import { formCopyFields, confirmFormCopyReflected } from './formaloo-copy';
import type { FormCopy } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

function okForm(form: Record<string, unknown>) {
  return { ok: true as const, status: 200, data: { data: { form } } };
}
function failRes(status = 500) {
  return { ok: false as const, status, error: `HTTP ${status}` };
}

describe('formCopyFields (文言 push body / update 意味論 / present-key only)', () => {
  test('非空文言のみ Formaloo 直キーへ map する', () => {
    const copy: FormCopy = { buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' };
    expect(formCopyFields(copy)).toEqual({
      button_text: '送信',
      success_message: 'ありがとうございました',
      error_message: '送信に失敗しました',
    });
  });

  test('partial (buttonText だけ) は button_text だけ返す (present-key only)', () => {
    expect(formCopyFields({ buttonText: '送信' })).toEqual({ button_text: '送信' });
  });

  test('空 copy / undefined / null は空 object (何も PATCH しない = 未変更)', () => {
    expect(formCopyFields({})).toEqual({});
    expect(formCopyFields(undefined)).toEqual({});
    expect(formCopyFields(null)).toEqual({});
  });

  test('空文字 / 空白のみの値は drop する (未指定=触らない)', () => {
    expect(formCopyFields({ buttonText: '', successMessage: '   ', errorMessage: '送信失敗' })).toEqual({
      error_message: '送信失敗',
    });
  });

  test('非 string 値は drop する (防御)', () => {
    expect(formCopyFields({ buttonText: 123 as unknown as string, successMessage: '完了' })).toEqual({ success_message: '完了' });
  });
});

describe('confirmFormCopyReflected (soft-200 対策 GET-after-PATCH)', () => {
  function getClient(remote: Record<string, unknown>, fail = false) {
    const request = vi.fn(async (method: string) => {
      if (method === 'GET') return fail ? failRes(500) : okForm(remote);
      return okForm({});
    });
    return { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
  }
  const noSleep = () => Promise.resolve();

  test('remote が送った文言に一致 → ok:true・GET を正しい path で呼ぶ', async () => {
    const c = getClient({ button_text: '送信', success_message: 'ありがとう' });
    const r = await confirmFormCopyReflected(c, 'slugX', { buttonText: '送信', successMessage: 'ありがとう' }, { retries: 0, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(c.request).toHaveBeenCalledWith('GET', '/v3.0/forms/slugX/');
  });

  test('remote が不一致 (soft-200 で無言無視) → ok:false + error', async () => {
    const c = getClient({ button_text: 'Submit' }); // 送った「送信」が反映されず既定英語のまま
    const r = await confirmFormCopyReflected(c, 'slugY', { buttonText: '送信' }, { retries: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
  });

  test('送る文言なし (空 copy) は確認スキップ (ok:true / GET しない)', async () => {
    const c = getClient({});
    const r = await confirmFormCopyReflected(c, 'slugZ', {}, { retries: 0, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(c.request).not.toHaveBeenCalled();
  });

  test('GET 自体が失敗 → ok:false', async () => {
    const c = getClient({}, true);
    const r = await confirmFormCopyReflected(c, 'slugF', { buttonText: '送信' }, { retries: 0, sleep: noSleep });
    expect(r.ok).toBe(false);
  });

  test('bounded retry: 途中不一致→最終一致で ok:true', async () => {
    let call = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== 'GET') return okForm({});
      call += 1;
      return call < 2 ? okForm({ button_text: 'Submit' }) : okForm({ button_text: '送信' });
    });
    const c = { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
    const r = await confirmFormCopyReflected(c, 'slugR', { buttonText: '送信' }, { retries: 2, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(call).toBe(2);
  });
});

// =============================================================================
// form-copy-sync-warning-fix — Formaloo server-side 正規化 耐性 (evidence/spike-normalization-matrix.md)
// -----------------------------------------------------------------------------
// 真因: Formaloo は保存時に success_message 等を server-side 正規化する (full NFKC + \r\t→space +
//   連続スペース畳み込み)。harness は owner が打った全角値 (受付完了！) をそのまま送るが Formaloo は
//   受付完了! (半角) を保存/返却 → strict 等値比較が恒久不一致 → out_of_sync 誤警告 (owner 実症状)。
// 修正: 比較の両辺に normalizeForCompare を適用 (comparison-only・送信経路は byte 不変)。
// =============================================================================
describe('confirmFormCopyReflected — Formaloo 正規化 耐性 (form-copy-sync-warning-fix)', () => {
  function getClient(remote: Record<string, unknown>, fail = false) {
    const request = vi.fn(async (method: string) => {
      if (method === 'GET') return fail ? failRes(500) : okForm(remote);
      return okForm({});
    });
    return { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
  }
  const noSleep = () => Promise.resolve();

  // BUG-1 / AC-1: owner 実症状の機械的再現。sent = 全角！(U+FF01) / remote = 半角!(U+0021・Formaloo 正規化後)。
  //   修正前は strict 不一致 → ok:false (RED)。修正後は normalizeForCompare で一致 → ok:true。
  test('BUG-1/AC-1: sent 受付完了！(全角！U+FF01) × remote 受付完了!(半角!U+0021) → ok:true (誤警告解消)', async () => {
    const c = getClient({ success_message: '受付完了!' }); // Formaloo が保存した半角! (U+0021)
    const r = await confirmFormCopyReflected(
      c,
      'slugCopy1',
      { successMessage: '受付完了！' }, // owner が打った全角！ (U+FF01)
      { retries: 0, sleep: noSleep },
    );
    expect(r.ok).toBe(true);
  });

  // ── AC-2 / fail-closed 負テスト①: 真の未反映 (soft-200 無言無視で英語既定のまま) は依然 ok:false ──
  //   確認を殺して常に green にする殻修理でないことの機械証明 (failure_observable 直結)。
  test('AC-2/fail-closed①: sent 受付完了！ × remote 英語既定 Thanks! submitted successfully → ok:false + error に success_message を含む', async () => {
    const c = getClient({ success_message: 'Thanks! submitted successfully' }); // 送信文言が反映されず既定のまま
    const r = await confirmFormCopyReflected(
      c,
      'slugCopy2',
      { successMessage: '受付完了！' },
      { retries: 0, sleep: noSleep },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('success_message');
  });

  // ── AC-2 系 / T-A4 fail-closed 負テスト② (Codex FINDING-1 応答): 正規化衝突しない別文言は ok:false ──
  //   normalizeForCompare が NFKC over-fold で異なる文言を green にしないことの駄目押し証明。
  test('T-A4/fail-closed②: sent 受付完了 × remote 別の文言です (正規化衝突しない異文言) → ok:false', async () => {
    const c = getClient({ success_message: '別の文言です' });
    const r = await confirmFormCopyReflected(
      c,
      'slugCopy3',
      { successMessage: '受付完了' },
      { retries: 0, sleep: noSleep },
    );
    expect(r.ok).toBe(false);
  });

  // ── AC-3 正規化マトリクス (evidence §2+§4 全網羅) ──
  // Formaloo が fold する文字クラス: sent = owner が打った値 / remote = Formaloo 正規化後値。
  //   3 フィールド (button_text/success_message/error_message) 全てに同値を載せて 1 test で uniform(field 非依存) を assert。
  const FIELD_LABELS = 'button_text/success_message/error_message';
  const foldCases: Array<{ label: string; sent: string; remote: string }> = [
    { label: '全角！(U+FF01)→!(U+0021)', sent: '受付完了！', remote: '受付完了!' },
    { label: '全角？(U+FF1F)→?(U+003F)', sent: 'よろしいですか？', remote: 'よろしいですか?' },
    { label: '全角（）→()', sent: '受付（完了）', remote: '受付(完了)' },
    { label: 'NBSP(U+00A0)→space', sent: '受付 完了', remote: '受付 完了' },
    { label: 'TAB(U+0009)→space', sent: '受付\t完了', remote: '受付 完了' },
    { label: 'CR(U+000D)→space', sent: '完了。\r担当', remote: '完了。 担当' },
    { label: '丸数字①→1', sent: '第①希望', remote: '第1希望' },
    { label: '㈱→(株)', sent: '㈱テスト', remote: '(株)テスト' },
    { label: '半角カナ→全角', sent: 'ｶﾀｶﾅ', remote: 'カタカナ' },
    { label: 'ローマ数字Ⅳ→IV', sent: 'レベルⅣ', remote: 'レベルIV' },
    { label: '単位㎏→kg', sent: '重さ㎏', remote: '重さkg' },
    { label: '濁点合成 か+U+3099→が(U+304C)', sent: 'が', remote: 'が' },
    { label: '連続スペース→単一', sent: '受付  完了', remote: '受付 完了' },
    { label: '全角内部スペース(U+3000)→space', sent: '受付　完了', remote: '受付 完了' },
  ];
  for (const fc of foldCases) {
    test(`AC-3 fold ${fc.label} → ok:true (${FIELD_LABELS} uniform)`, async () => {
      const c = getClient({ button_text: fc.remote, success_message: fc.remote, error_message: fc.remote });
      const r = await confirmFormCopyReflected(
        c,
        'slugMatrix',
        { buttonText: fc.sent, successMessage: fc.sent, errorMessage: fc.sent },
        { retries: 0, sleep: noSleep },
      );
      expect(r.ok).toBe(true);
    });
  }

  // Formaloo が fold しない文字クラス: sent === remote で挙動不変 (ok:true・既存挙動非退行)。
  const preserveCases: Array<{ label: string; value: string }> = [
    { label: '\\n 保持 (multiline 完了メッセージ)', value: '完了しました\n担当より連絡します' },
    { label: 'emoji 保持', value: 'ありがとうございました🙏' },
    { label: '& 保持', value: 'ありがとう & 感謝' },
    { label: '<> 保持 (HTML escape なし)', value: 'ありがとう <重要> です' },
    { label: '波ダッシュ〜(U+301C) 保持', value: '完了しました〜' },
    { label: 'ZWSP(U+200B) 保持', value: '受付​完了' },
  ];
  for (const pc of preserveCases) {
    test(`AC-3 preserve ${pc.label} → 挙動不変 ok:true (${FIELD_LABELS} uniform)`, async () => {
      const c = getClient({ button_text: pc.value, success_message: pc.value, error_message: pc.value });
      const r = await confirmFormCopyReflected(
        c,
        'slugPreserve',
        { buttonText: pc.value, successMessage: pc.value, errorMessage: pc.value },
        { retries: 0, sleep: noSleep },
      );
      expect(r.ok).toBe(true);
    });
  }
});
