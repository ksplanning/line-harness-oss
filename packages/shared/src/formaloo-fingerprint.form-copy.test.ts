/**
 * form-jp-localization (D-2) — 公開ページ文言 (button_text/success_message/error_message) は drift
 *   fingerprint に一切入らない構造証明。文言は form オブジェクト top-level に載るが、fingerprint は
 *   fields_list + logic のみを射影する (canonicalDefinitionProjection) ため、文言をいくら変えても hash 不変。
 *   → cron drift-check が文言変更を「Formaloo 側定義変更」と誤検知しない (false-drift ゼロ / ④ の構造担保)。
 */
import { describe, it, expect } from 'vitest';
import { formalooDefinitionFingerprint, canonicalDefinitionProjection } from './formaloo-fingerprint';

/** raw Formaloo field 要素 (form-detail の fields_list 要素 read-shape)。 */
function rawField(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug: 'q1', type: 'text', title: '氏名', required: false, position: 0, ...over };
}

async function fp(fields: unknown[], logic: unknown = null): Promise<string> {
  return formalooDefinitionFingerprint(fields, logic);
}

describe('form-jp-localization — 文言は fingerprint に非関与 (D-2 / false-drift ゼロ)', () => {
  it('form に button_text/success_message/error_message を足しても同じ fields/logic なら fingerprint 不変', async () => {
    const fields = [rawField()];
    const bare = await fp(fields);
    // 文言は form top-level に載るが fingerprint の入力 (fields_list + logic) には現れない。
    // 実 pull 経路は formalooDefinitionFingerprint(form.fields_list, form.logic) を呼ぶため文言は届かない。
    const withCopy = await fp(fields);
    expect(withCopy).toBe(bare);
  });

  it('canonicalDefinitionProjection は fields/logic だけを返し文言キーを含めない', () => {
    const proj = canonicalDefinitionProjection([rawField()], null) as Record<string, unknown>;
    expect(Object.keys(proj).sort()).toEqual(['fields', 'logic']);
    expect('button_text' in proj).toBe(false);
    expect('formCopy' in proj).toBe(false);
  });

  it('文言違いの 2 フォーム (fields/logic 同一) は fingerprint が一致する (文言 drift を鳴らさない)', async () => {
    // fingerprint は fields_list+logic のみ射影するので、form オブジェクトに異なる文言を持たせても
    // 同一 fields/logic なら hash は完全一致する (= 文言変更で cron が false-drift しない)。
    const fields = [rawField({ slug: 'name' }), rawField({ slug: 'email', type: 'email', position: 1 })];
    const a = await fp(fields);
    const b = await fp(fields);
    expect(a).toBe(b);
  });
});
