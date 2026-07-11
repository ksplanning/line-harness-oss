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
  fromFormalooField,
  toFormalooLogic,
  fromFormalooLogic,
  countWeakenedFormalooRules,
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
  // 🚨 latent defect 回帰ガード: 実 Formaloo API は choice 系選択肢を writeOnly `choice_items`
  // ([{title}] 形式) で受ける (live 実証 2026-07-10)。旧実装の `choices: string[]` は API に無視され
  // 選択肢が Formaloo 側で落ちていた (silent data loss)。以後 `choices` キーを送ってはならない。
  test('choice の選択肢は Formaloo choice_items ([{title}]) で送る (choices キーは送らない / latent defect)', () => {
    const field: HarnessField = { id: 'f3', type: 'choice', label: '性別', required: true, position: 2, config: { choices: ['男', '女', 'その他'] } };
    const p = toFormalooFieldPayload(field);
    expect(p.type).toBe('choice');
    expect(p.choice_items).toEqual([{ title: '男' }, { title: '女' }, { title: 'その他' }]);
    expect(p.choices).toBeUndefined(); // 旧 shape は二度と送らない
  });
  test('dropdown / multiple_select も choice_items で送る', () => {
    for (const type of ['dropdown', 'multiple_select'] as const) {
      const field: HarnessField = { id: 'f', type, label: 'x', required: false, position: 0, config: { choices: ['A', 'B'] } };
      const p = toFormalooFieldPayload(field);
      expect(p.type).toBe(type);
      expect(p.choice_items).toEqual([{ title: 'A' }, { title: 'B' }]);
      expect(p.choices).toBeUndefined();
    }
  });
});

describe('formaloo-forms — fromFormalooField (builder pull / N-8 選択肢読み戻し)', () => {
  // Formaloo form detail の fields_list 要素 (read-shape) を模した最小オブジェクト。
  // choice_items は read 時に slug/position/is_other_choice 等を持つ (live 実証 2026-07-10)。
  const readChoiceField = {
    slug: 'FS_CHOICE',
    type: 'choice',
    title: '好きな色',
    required: true,
    position: 3,
    // わざと position を昇順でなく与える → position 昇順に整列されること
    choice_items: [
      { slug: 'c2', title: '青', position: 2, is_other_choice: false },
      { slug: 'c1', title: '赤', position: 1, is_other_choice: false },
      { slug: 'c3', title: '緑', position: 3, is_other_choice: false },
      // has_other_choice の「その他」自由記述は選択肢ではない → 除外される
      { slug: 'cOther', title: 'その他', position: 4, is_other_choice: true },
    ],
  };

  test('choice field を harness field に再構成し選択肢を position 昇順で復元 (is_other_choice は除外)', () => {
    const f = fromFormalooField(readChoiceField);
    expect(f).not.toBeNull();
    expect(f!.type).toBe('choice');
    expect(f!.label).toBe('好きな色');
    expect(f!.required).toBe(true);
    expect(f!.position).toBe(3);
    expect(f!.config.choices).toEqual(['赤', '青', '緑']); // position 昇順 / その他(is_other_choice)は落ちる
  });

  test('resolveId で Formaloo slug → harness id を解決 (無ければ slug をそのまま id に)', () => {
    expect(fromFormalooField(readChoiceField, (slug) => (slug === 'FS_CHOICE' ? 'h9' : undefined))!.id).toBe('h9');
    expect(fromFormalooField(readChoiceField)!.id).toBe('FS_CHOICE'); // resolver 無し = slug fallback
  });

  test('未対応 type (matrix 等) は null (MVP subset のみ / M-21)', () => {
    expect(fromFormalooField({ slug: 'x', type: 'matrix', title: 'm' })).toBeNull();
    expect(fromFormalooField(null)).toBeNull();
    expect(fromFormalooField('nope' as unknown)).toBeNull();
  });

  test('text field は max_length を復元 (choices は付かない)', () => {
    const f = fromFormalooField({ slug: 's', type: 'short_text', title: '名前', required: false, position: 0, max_length: 50 });
    expect(f!.type).toBe('text');
    expect(f!.config.maxLength).toBe(50);
    expect(f!.config.choices).toBeUndefined();
  });

  test('未知プロパティは無視 (whitelist / M-8)', () => {
    const f = fromFormalooField({ slug: 's', type: 'choice', title: 'x', evil: 'inject', choice_items: [{ title: 'A', injected: 'x' }] } as unknown);
    expect((f as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(f!.config.choices).toEqual(['A']);
  });

  test('round-trip: harness field → push payload → (Formaloo read 形を模す) → fromFormalooField で choices 一致 (N-8)', () => {
    const original: HarnessField = { id: 'h1', type: 'multiple_select', label: '興味', required: false, position: 1, config: { choices: ['旅行', '料理', '音楽'] } };
    const pushed = toFormalooFieldPayload(original);
    // push は choice_items:[{title}]。Formaloo が read 時に slug/position/is_other_choice を付与する形を模す。
    const asRead = {
      slug: 'FS_H1',
      type: pushed.type,
      title: pushed.title,
      required: pushed.required,
      position: pushed.position,
      choice_items: (pushed.choice_items as Array<{ title: string }>).map((it, i) => ({
        slug: `s${i}`,
        title: it.title,
        position: i + 1,
        is_other_choice: false,
      })),
    };
    const back = fromFormalooField(asRead, () => 'h1');
    expect(back).toEqual(original); // id/type/label/required/position/config.choices まで完全一致
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

describe('formaloo-forms — countWeakenedFormalooRules (pull-fidelity 弱化検知 / additive)', () => {
  const single = { conditions: [{ field: 'a', operator: 'equals', value: '1' }], actions: [{ type: 'show', field: 'c' }] };
  const multiCond = { conditions: [{ field: 'a', operator: 'equals', value: '1' }, { field: 'b', operator: 'equals', value: '2' }], actions: [{ type: 'show', field: 'c' }] };
  const multiAct = { conditions: [{ field: 'a', operator: 'equals', value: '1' }], actions: [{ type: 'show', field: 'c' }, { type: 'hide', field: 'd' }] };

  test('複条件 (conditions.length>1) rule を 1 と数える', () => {
    expect(countWeakenedFormalooRules({ rules: [multiCond] } as never)).toBe(1);
  });
  test('複アクション (actions.length>1) rule を 1 と数える', () => {
    expect(countWeakenedFormalooRules({ rules: [multiAct] } as never)).toBe(1);
  });
  test('単一条件・単一アクションの rule は 0', () => {
    expect(countWeakenedFormalooRules({ rules: [single] } as never)).toBe(0);
  });
  test('rules 非配列 / 空 / null は 0 (fail-soft)', () => {
    expect(countWeakenedFormalooRules({ rules: 'nope' } as never)).toBe(0);
    expect(countWeakenedFormalooRules({} as never)).toBe(0);
    expect(countWeakenedFormalooRules(null as never)).toBe(0);
  });
  test('混在 rule 群で弱化のみ数える (単一 0 + 複条件 1 + 複アクション 1 = 2)', () => {
    expect(countWeakenedFormalooRules({ rules: [single, multiCond, multiAct] } as never)).toBe(2);
  });
});

describe('formaloo-forms — fromFormalooLogic の index-0 弱化挙動は無改変 (回帰 / byte-unchanged)', () => {
  test('複合ロジックは conditions[0]/actions[0] のみ取り込み残りを捨てる (検知は別関数・変換は不変)', () => {
    const obj = { rules: [
      { conditions: [{ field: 'A', operator: 'equals', value: 'x' }, { field: 'B', operator: 'equals', value: 'y' }],
        actions: [{ type: 'show', field: 'C' }, { type: 'hide', field: 'D' }] },
    ] };
    const back = fromFormalooLogic(obj as never, (s) => ({ A: 'a', B: 'b', C: 'c', D: 'd' } as Record<string, string>)[s]);
    expect(back).toHaveLength(1);
    expect(back[0].sourceFieldId).toBe('a'); // conditions[0]
    expect(back[0].targetFieldId).toBe('c'); // actions[0]
    expect(back[0].action).toBe('show'); // actions[0].type
  });
});
