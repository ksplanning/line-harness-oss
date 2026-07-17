/**
 * route-terminal-phase2 (D-2) — redirect は fingerprint 非関与 + SP 参照 fingerprint の責務分界。
 *  - CI-3: SP を含むフォームの再保存で slug 永続 → jump_to_success_page.args.identifier 不変 →
 *    logicFingerprint / drift fingerprint が round-trip で不変 (cron false-drift ゼロ)。
 *  - CX-1: SP slug が変われば hash が変化 (参照差分検知)・SP title/description の変更は fingerprint に
 *    映らない (fields_list projection で drop) → drift は T-E5 の successPages carry 側で検知する責務分界。
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalDefinitionProjection,
  formalooDefinitionFingerprint,
  logicFingerprint,
  type HarnessLogicRule,
} from './index';

/** submit→SP の Formaloo bare-array logic (jump_to_success_page identifier=SP slug + submit)。 */
function bareLogicWithSp(spSlug: string) {
  return [
    {
      type: 'field',
      identifier: 'q1',
      actions: [
        { action: 'jump_to_success_page', args: [{ type: 'field', identifier: spSlug }], when: { operation: 'is_answered', args: [{ type: 'field', value: 'q1' }] } },
        { action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 'q1' }] } },
      ],
    },
  ];
}

const FIELD = { slug: 'q1', type: 'short_text', title: '名前', required: false, position: 0 };
function spField(title: string, description = '') {
  return { slug: 'SP_A', type: 'success_page', title, description, position: 1 };
}

describe('D-2: redirect は logicFingerprint 非関与 (form-meta)', () => {
  it('logicFingerprint は harness logic のみを入力 = redirect 有無で不変 (redirect は logic に無い)', () => {
    const logic: HarnessLogicRule[] = [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: '' },
    ];
    // redirect は HarnessLogicRule の外 → logicFingerprint(logic) は redirect の有無に一切依存しない。
    expect(logicFingerprint(logic)).toBe(logicFingerprint([...logic]));
  });

  it('CI-3: submit→SP の harness logic は SP id 安定なら round-trip で logicFingerprint 不変', () => {
    const logic: HarnessLogicRule[] = [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: 'sp1' },
    ];
    const reloaded: HarnessLogicRule[] = [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: 'sp1' },
    ];
    expect(logicFingerprint(logic)).toBe(logicFingerprint(reloaded)); // slug 永続で再保存しても不変
  });

  it('CX-1: submit target (SP id) が変われば logicFingerprint が変化する (参照差分検知)', () => {
    const a = logicFingerprint([{ id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: 'sp1' }]);
    const b = logicFingerprint([{ id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: 'sp2' }]);
    expect(a).not.toBe(b);
  });
});

describe('D-2: drift fingerprint (raw Formaloo body 射影) の SP 責務分界', () => {
  it('CX-1: success_page 要素は canonicalDefinitionProjection で drop = title/description 変更は fingerprint に映らない', () => {
    const projA = canonicalDefinitionProjection([FIELD, spField('A完了', '旧本文')], bareLogicWithSp('SP_A'));
    const projB = canonicalDefinitionProjection([FIELD, spField('新見出し', '新本文')], bareLogicWithSp('SP_A'));
    // success_page は projection.fields に入らない (通常 field のみ)。
    expect(projA.fields.some((f) => f.type === 'success_page')).toBe(false);
    // title/description が変わっても projection は同一 (fingerprint に映らない = drift は carry 側で検知)。
    expect(JSON.stringify(projA)).toBe(JSON.stringify(projB));
  });

  it('CI-3: SP slug が同じなら drift fingerprint は round-trip で不変', async () => {
    const h1 = await formalooDefinitionFingerprint([FIELD, spField('A完了')], bareLogicWithSp('SP_A'));
    const h2 = await formalooDefinitionFingerprint([FIELD, spField('A完了')], bareLogicWithSp('SP_A'));
    expect(h1).toBe(h2);
  });

  it('CX-1: SP slug (jump_to_success_page identifier) が変われば drift fingerprint が変化する', async () => {
    const h1 = await formalooDefinitionFingerprint([FIELD, spField('A完了')], bareLogicWithSp('SP_A'));
    const h2 = await formalooDefinitionFingerprint([FIELD, spField('A完了')], bareLogicWithSp('SP_B'));
    expect(h1).not.toBe(h2);
  });
});
