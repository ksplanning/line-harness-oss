/**
 * form-media-limits (T-A6) — drift fingerprint への file field max_size 射影 + 既定 2048 ガード。
 *   - max_size >2048 (=引上げ済) の変化 → hash 変化 (真 drift 検知)
 *   - max_size 未載 / =2048 (既定) → hash は等値 (既存 file-field フォームの false-drift 回避 = RK-1)
 * 既定 2048 を「未設定」扱いにするガードが無いと、既存 file-field 全件の fingerprint が変わり
 * cron drift 検知が全件 false-drift を鳴らす (後方互換の要)。description 非空ガード (S-2) と同型。
 */
import { describe, it, expect } from 'vitest';
import { formalooDefinitionFingerprint } from './formaloo-fingerprint';

/** raw Formaloo file field 要素 (form-detail の fields_list 要素 read-shape)。 */
function rawFileField(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug: 'file1', type: 'file', title: '添付', required: false, position: 0, ...over };
}

async function fp(fields: unknown[], logic: unknown = null): Promise<string> {
  return formalooDefinitionFingerprint(fields, logic);
}

describe('form-media-limits — fingerprint max_size 射影 + 既定2048ガード (T-A6)', () => {
  it('max_size 未載 と =2048 (既定) は fingerprint 等値 (false-drift 無し / 後方互換の要)', async () => {
    const none = await fp([rawFileField()]);
    const default2048 = await fp([rawFileField({ max_size: 2048 })]);
    expect(default2048).toBe(none);
  });

  it('max_size >2048 (引上げ) は 未載/既定 と別 fingerprint (真 drift 検知)', async () => {
    const none = await fp([rawFileField()]);
    const raised = await fp([rawFileField({ max_size: 20480 })]);
    expect(raised).not.toBe(none);
  });

  it('異なる引上げ値は別 fingerprint (10MB vs 20MB を区別)', async () => {
    const a = await fp([rawFileField({ max_size: 10240 })]);
    const b = await fp([rawFileField({ max_size: 20480 })]);
    expect(a).not.toBe(b);
  });

  it('数値でない max_size は射影に入れない (未載扱い = false-drift 回避)', async () => {
    const none = await fp([rawFileField()]);
    expect(await fp([rawFileField({ max_size: 'big' })])).toBe(none);
    expect(await fp([rawFileField({ max_size: null })])).toBe(none);
  });
});
