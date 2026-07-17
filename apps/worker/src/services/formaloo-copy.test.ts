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
});
