/**
 * T-B2 (F-2) — harness フォーム定義 ↔ Formaloo field/logic マッピングの round-trip 検証。
 *   - field 種別は N-13 MVP subset のみ (matrix/repeating_section 等は弾く / M-21 明示 reject)
 *   - logic (条件分岐 R1) は harness rule ↔ Formaloo logic object を双方向変換し round-trip 一致 (N-8)
 *   - serialize whitelist: 未知プロパティは往復で漏れない (M-8)
 */
import { describe, test, expect } from 'vitest';
import {
  DECORATION_FIELD_TYPES,
  FORMALOO_FIELD_TYPES,
  HARNESS_TO_FORMALOO_TYPE,
  FORMALOO_TO_HARNESS_TYPE,
  isDecorationType,
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

  test('装飾型は additive に定義し、meta の逆引きは input 型マップへ混入させない (T-B2)', () => {
    expect(DECORATION_FIELD_TYPES).toEqual(['section', 'page_break']);
    expect(HARNESS_TO_FORMALOO_TYPE.section).toBe('meta');
    expect(HARNESS_TO_FORMALOO_TYPE.page_break).toBe('meta');
    expect(FORMALOO_TO_HARNESS_TYPE.meta).toBeUndefined();
    expect(isDecorationType('section')).toBe(true);
    expect(isDecorationType('page_break')).toBe(true);
    expect(isDecorationType('text')).toBe(false);
    expect(isDecorationType('video')).toBe(false);
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

  test('section は config.text を保持し、page_break も受理する (T-B1)', () => {
    const section = validateHarnessField({
      id: 'decoration-section',
      type: 'section',
      label: '見出し',
      required: false,
      position: 1,
      config: { text: '本文' },
    });
    expect(section).toEqual({
      ok: true,
      field: {
        id: 'decoration-section',
        type: 'section',
        label: '見出し',
        required: false,
        position: 1,
        config: { text: '本文' },
      },
    });

    const pageBreak = validateHarnessField({
      id: 'decoration-page-break',
      type: 'page_break',
      label: '改ページ',
      required: false,
      position: 2,
      config: {},
    });
    expect(pageBreak.ok).toBe(true);
  });

  test('装飾 field の required=true は false に正規化する (T-B1)', () => {
    for (const type of ['section', 'page_break'] as const) {
      const result = validateHarnessField({
        id: `decoration-${type}`,
        type,
        label: '装飾',
        required: true,
        position: 0,
        config: type === 'section' ? { text: '本文' } : {},
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.field.required).toBe(false);
    }
  });

  test('config.text は文字列だけを受理し、未知型は引き続き拒否する (T-B1 / M-21)', () => {
    expect(validateHarnessField({
      id: 'bad-section',
      type: 'section',
      label: '見出し',
      required: false,
      position: 0,
      config: { text: 123 },
    }).ok).toBe(false);
    expect(validateHarnessField({
      id: 'unknown',
      type: 'video',
      label: '動画',
      required: false,
      position: 0,
      config: {},
    }).ok).toBe(false);
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

  test('section / page_break を Formaloo meta + sub_type payload に変換する (T-B2)', () => {
    const section: HarnessField = {
      id: 'section-1',
      type: 'section',
      label: 'ご案内',
      required: false,
      position: 4,
      config: { text: '回答前にお読みください' },
    };
    expect(toFormalooFieldPayload(section)).toEqual(expect.objectContaining({
      type: 'meta',
      sub_type: 'section',
      title: 'ご案内',
      description: '回答前にお読みください',
      position: 4,
    }));

    const pageBreak: HarnessField = {
      id: 'page-break-1',
      type: 'page_break',
      label: '改ページ',
      required: false,
      position: 5,
      config: {},
    };
    expect(toFormalooFieldPayload(pageBreak)).toEqual(expect.objectContaining({
      type: 'meta',
      sub_type: 'page_break',
      position: 5,
    }));
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
    // form-route-branching: pull は choice_item.slug を choiceItems に additive 保持する (choices=title は不変)。
    expect(back!.config.choices).toEqual(original.config.choices);
    expect(back!.config.choiceItems).toEqual([
      { title: '旅行', slug: 's0' }, { title: '料理', slug: 's1' }, { title: '音楽', slug: 's2' },
    ]);
    // choiceItems 以外は完全一致 (id/type/label/required/position)
    expect({ ...back, config: { choices: back!.config.choices } }).toEqual(original);
  });

  test('meta section/page_break を sub_type に従って復元し、未知 sub_type は捨てる (T-B4)', () => {
    expect(fromFormalooField({
      slug: 'FS_SECTION',
      type: 'meta',
      sub_type: 'section',
      title: '注意事項',
      description: '必ず確認してください',
      required: true,
      position: 6,
      admin_only: false,
    }, (slug) => (slug === 'FS_SECTION' ? 'section-id' : undefined))).toEqual({
      id: 'section-id',
      type: 'section',
      label: '注意事項',
      required: false,
      position: 6,
      config: { text: '必ず確認してください' },
    });

    expect(fromFormalooField({
      slug: 'FS_PAGE_BREAK',
      type: 'meta',
      sub_type: 'page_break',
      title: '改ページ',
      description: null,
      position: 7,
    })).toEqual({
      id: 'FS_PAGE_BREAK',
      type: 'page_break',
      label: '改ページ',
      required: false,
      position: 7,
      config: {},
    });

    expect(fromFormalooField({
      slug: 'FS_VIDEO',
      type: 'meta',
      sub_type: 'video',
      title: '動画',
      position: 8,
    })).toBeNull();
  });

  test('装飾 field は push→pull で sub_type/title/description を保つ (T-B8)', () => {
    const originals: HarnessField[] = [
      {
        id: 'section-id',
        type: 'section',
        label: 'このフォームについて',
        required: false,
        position: 2,
        config: { text: '説明本文' },
      },
      {
        id: 'page-break-id',
        type: 'page_break',
        label: '',
        required: false,
        position: 3,
        config: {},
      },
    ];

    for (const original of originals) {
      const pushed = toFormalooFieldPayload(original);
      const asRead = {
        slug: `FS_${original.id}`,
        ...pushed,
      };
      expect(fromFormalooField(asRead, () => original.id)).toEqual(original);
    }
  });
});

describe('formaloo-forms — 入力項目の補足説明 description (field-help-charlimit T-A1)', () => {
  test('validateHarnessField は config.description(string) を保持する (全入力型)', () => {
    for (const type of ['text', 'textarea', 'number', 'email', 'phone', 'date'] as const) {
      const r = validateHarnessField({ id: 'f1', type, label: 'x', required: false, position: 0, config: { description: '例: 日中つながる番号' } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.field.config.description).toBe('例: 日中つながる番号');
    }
  });
  test('validateHarnessField は非 string の description を reject する (M-21)', () => {
    expect(validateHarnessField({ id: 'f1', type: 'text', label: 'x', required: false, position: 0, config: { description: 123 } } as unknown).ok).toBe(false);
  });
  test('toFormalooFieldPayload は入力型の description を payload.description に載せる', () => {
    const field: HarnessField = { id: 'f1', type: 'text', label: '電話', required: false, position: 0, config: { description: '例: 日中つながる番号' } };
    const p = toFormalooFieldPayload(field);
    expect(p.type).toBe('short_text');
    expect(p.description).toBe('例: 日中つながる番号');
  });
  test('section 経路の description は config.text のまま不変 (入力項目の description と混同しない)', () => {
    const section: HarnessField = { id: 's1', type: 'section', label: '見出し', required: false, position: 1, config: { text: '本文だけ' } };
    const p = toFormalooFieldPayload(section);
    expect(p).toEqual({ type: 'meta', sub_type: 'section', title: '見出し', description: '本文だけ', position: 1 });
  });
  test('fromFormalooField は入力型の description を config.description に復元する', () => {
    const f = fromFormalooField({ slug: 's', type: 'short_text', title: '電話', required: false, position: 0, description: '例: 日中つながる番号' });
    expect(f!.type).toBe('text');
    expect(f!.config.description).toBe('例: 日中つながる番号');
  });
  test('round-trip: harness field(description) → push → read 形 → pull で description 一致', () => {
    const original: HarnessField = { id: 'h1', type: 'textarea', label: 'ご要望', required: false, position: 2, config: { description: '200 文字以内でご記入ください', maxLength: 200 } };
    const pushed = toFormalooFieldPayload(original);
    const asRead = { slug: 'FS_H1', type: pushed.type, title: pushed.title, required: pushed.required, position: pushed.position, description: pushed.description, max_length: pushed.max_length };
    const back = fromFormalooField(asRead, () => 'h1');
    expect(back).toEqual(original);
  });
  test('S-2 後方互換: description 未設定 field は payload/pull に description を持たない', () => {
    const field: HarnessField = { id: 'f1', type: 'text', label: '名前', required: false, position: 0, config: {} };
    const p = toFormalooFieldPayload(field);
    expect('description' in p).toBe(false);
    const back = fromFormalooField({ slug: 's', type: 'short_text', title: '名前', required: false, position: 0 });
    expect('description' in (back!.config)).toBe(false);
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
