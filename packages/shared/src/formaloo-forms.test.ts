/**
 * T-B2 (F-2) — harness フォーム定義 ↔ Formaloo field/logic マッピングの round-trip 検証。
 *   - field 種別は N-13 MVP subset のみ (matrix/repeating_section 等は弾く / M-21 明示 reject)
 *   - logic (条件分岐 R1) は harness rule ↔ Formaloo logic object を双方向変換し round-trip 一致 (N-8)
 *   - serialize whitelist: 未知プロパティは往復で漏れない (M-8)
 */
import { describe, test, expect } from 'vitest';
import {
  FORMALOO_FIELD_TYPES,
  HARNESS_TO_FORMALOO_TYPE,
  FORMALOO_TO_HARNESS_TYPE,
  toFormalooFieldPayload,
  toFormalooLogic,
  fromFormalooLogic,
  validateHarnessField,
  type HarnessField,
  type HarnessLogicRule,
} from './formaloo-forms';

describe('formaloo-forms — field 種別 MVP subset (N-13)', () => {
  test('MVP subset は 10 種 (matrix/repeating_section 等は含まない)', () => {
    expect([...FORMALOO_FIELD_TYPES].sort()).toEqual(
      ['text', 'textarea', 'choice', 'dropdown', 'multiple_select', 'number', 'email', 'phone', 'date', 'file'].sort(),
    );
    expect(FORMALOO_FIELD_TYPES).not.toContain('matrix');
    expect(FORMALOO_FIELD_TYPES).not.toContain('repeating_section');
  });

  test('harness→Formaloo 種別マップ (text→short_text / textarea→long_text)', () => {
    expect(HARNESS_TO_FORMALOO_TYPE.text).toBe('short_text');
    expect(HARNESS_TO_FORMALOO_TYPE.textarea).toBe('long_text');
    expect(HARNESS_TO_FORMALOO_TYPE.choice).toBe('choice');
    // 双方向で bijective
    for (const t of FORMALOO_FIELD_TYPES) {
      expect(FORMALOO_TO_HARNESS_TYPE[HARNESS_TO_FORMALOO_TYPE[t]]).toBe(t);
    }
  });
});

describe('formaloo-forms — validateHarnessField (M-21 明示 reject)', () => {
  test('MVP subset の有効 field は通す', () => {
    const r = validateHarnessField({ id: 'f1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 20 } });
    expect(r.ok).toBe(true);
  });
  test('subset 外の field 種別 (matrix) は弾く', () => {
    const r = validateHarnessField({ id: 'f1', type: 'matrix', label: 'x', required: false, position: 0, config: {} });
    expect(r.ok).toBe(false);
  });
  test('未知プロパティは剥がす (whitelist / M-8)', () => {
    const r = validateHarnessField({ id: 'f1', type: 'text', label: 'x', required: false, position: 0, config: { maxLength: 5, evil: 'x' }, injected: true } as unknown);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.field as unknown as Record<string, unknown>).injected).toBeUndefined();
      expect((r.field.config as unknown as Record<string, unknown>).evil).toBeUndefined();
    }
  });
  test('maxLength 非数値は弾く', () => {
    const r = validateHarnessField({ id: 'f1', type: 'text', label: 'x', required: false, position: 0, config: { maxLength: 'abc' } } as unknown);
    expect(r.ok).toBe(false);
  });
});

describe('formaloo-forms — toFormalooFieldPayload', () => {
  test('text の max_length を Formaloo field payload に載せる (R2 実機 max_length=255 実証)', () => {
    const field: HarnessField = { id: 'f1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 30 } };
    const p = toFormalooFieldPayload(field);
    expect(p.type).toBe('short_text');
    expect(p.title).toBe('名前');
    expect(p.required).toBe(true);
    expect(p.max_length).toBe(30);
    expect(p.position).toBe(0);
  });
  test('file の allow_multiple_files + 許可拡張子', () => {
    const field: HarnessField = { id: 'f2', type: 'file', label: '添付', required: false, position: 1, config: { allowMultipleFiles: true, allowedExtensions: ['pdf', 'png'] } };
    const p = toFormalooFieldPayload(field);
    expect(p.type).toBe('file');
    expect(p.allow_multiple_files).toBe(true);
    expect(p.allowed_extensions).toEqual(['pdf', 'png']);
  });
  test('choice の選択肢を Formaloo choices へ', () => {
    const field: HarnessField = { id: 'f3', type: 'choice', label: '性別', required: true, position: 2, config: { choices: ['男', '女', 'その他'] } };
    const p = toFormalooFieldPayload(field);
    expect(p.type).toBe('choice');
    expect(p.choices).toEqual(['男', '女', 'その他']);
  });
});

describe('formaloo-forms — logic 条件分岐 round-trip (R1 / N-8)', () => {
  const rules: HarnessLogicRule[] = [
    { id: 'r1', sourceFieldId: 'f1', operator: 'equals', value: 'はい', action: 'show', targetFieldId: 'f2' },
    { id: 'r2', sourceFieldId: 'f1', operator: 'not_equals', value: 'いいえ', action: 'skip', targetFieldId: 'f3' },
  ];
  // harness field id ↔ Formaloo field slug の bijective map
  const idToSlug: Record<string, string> = { f1: 'slugA', f2: 'slugB', f3: 'slugC' };
  const slugToId: Record<string, string> = { slugA: 'f1', slugB: 'f2', slugC: 'f3' };

  test('toFormalooLogic は Formaloo slug ベースの logic object を作る', () => {
    const obj = toFormalooLogic(rules, (id) => idToSlug[id]);
    expect(Array.isArray(obj.rules)).toBe(true);
    expect(obj.rules[0].conditions[0].field).toBe('slugA'); // harness id でなく Formaloo slug
    expect(obj.rules[0].actions[0].field).toBe('slugB');
    expect(obj.rules[0].actions[0].type).toBe('show');
  });

  test('round-trip: fromFormalooLogic(toFormalooLogic(rules)) === rules (N-8)', () => {
    const obj = toFormalooLogic(rules, (id) => idToSlug[id]);
    const back = fromFormalooLogic(obj, (slug) => slugToId[slug]);
    expect(back).toEqual(rules);
  });

  test('Formaloo logic object の未知プロパティは round-trip で剥がれる (M-8 whitelist)', () => {
    const obj = toFormalooLogic(rules, (id) => idToSlug[id]) as unknown as Record<string, unknown>;
    (obj.rules as Array<Record<string, unknown>>)[0].injected = 'evil';
    const back = fromFormalooLogic(obj as never, (slug) => slugToId[slug]);
    expect(back).toEqual(rules);
    expect((back[0] as unknown as Record<string, unknown>).injected).toBeUndefined();
  });

  test('resolve できない field を含む rule は捨てる (孤立参照防止 / N-11)', () => {
    const obj = toFormalooLogic(rules, (id) => idToSlug[id]);
    // slugC の逆引きを消す = f3 が解決できない
    const back = fromFormalooLogic(obj, (slug) => (slug === 'slugC' ? undefined : slugToId[slug]));
    expect(back.map((r) => r.id)).toEqual(['r1']); // r2 (f3 参照) は落ちる
  });
});
