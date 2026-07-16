/**
 * form-route-branching (A/B/C ルート分岐 jump + form_type 切替) — shared TDD。
 * T-B1: LogicAction 'jump' additive + pull 射影 skip→jump。
 * T-B2: toFormalooRawLogic — R0 bare-array 生成 (args 混在型) + choice_slug 解決 (spike T-A0 実測)。
 * T-B3: FormDisplayType モデル + jump preserve 往復不変 (preserve 経路 不可侵)。
 *
 * spike T-A0 (使い捨てフォーム live 実測 / 正本 sidecar):
 *   - hosted 発火: choice source 比較は {type:'choice', value:<choice_slug>} のみ発火。
 *     {type:'constant', value:<title>} は API 200 だが hosted 不発。→ choice source は choice_slug 生成必須。
 *   - args 混在型: actions[].args=[{type:'field',identifier}] / when.args=[{type:'field',value},{type,value}]。
 */
import { describe, test, expect } from 'vitest';
import {
  fromFormalooRawLogic,
  toFormalooRawLogic,
  fromFormalooField,
  validateHarnessField,
  serializeRawLogicForPush,
  semanticLogicEqual,
  type HarnessField,
  type HarnessFormDefinition,
  type HarnessLogicRule,
  type LogicAction,
  type FormDisplayType,
} from './formaloo-forms';

const identity = (s: string) => s;
const slugId = (id: string) => id; // harness id == Formaloo slug の簡易 map

// 単一 jump item を作るヘルパ (R0 bare-array 形)。
function jumpItem(srcSlug: string, tgtSlug: string, verb: string, whenVal: unknown) {
  return {
    type: 'field',
    identifier: srcSlug,
    actions: [
      {
        action: verb,
        args: [{ type: 'field', identifier: tgtSlug }],
        when: { operation: 'is', args: [{ type: 'field', value: srcSlug }, whenVal] },
      },
    ],
  };
}

describe('T-B1 — pull 射影 skip→jump (LogicAction additive)', () => {
  test("jump item を fromFormalooRawLogic が action='jump' に射影する", () => {
    const rules = fromFormalooRawLogic(
      [jumpItem('src', 'pageC', 'jump', { type: 'choice', value: 'C1' })],
      identity,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('jump');
    expect(rules[0].sourceFieldId).toBe('src');
    expect(rules[0].targetFieldId).toBe('pageC');
  });

  test("jump_to_success_page も 'jump' に射影される", () => {
    const rules = fromFormalooRawLogic(
      [jumpItem('src', 'tgt', 'jump_to_success_page', { type: 'constant', value: 'x' })],
      identity,
    );
    expect(rules[0].action).toBe('jump');
  });

  test("show/hide 射影は無改変 (回帰)", () => {
    const show = fromFormalooRawLogic([jumpItem('s', 't', 'show', { type: 'choice', value: 'a' })], identity);
    const hide = fromFormalooRawLogic([jumpItem('s', 't', 'hide', { type: 'choice', value: 'a' })], identity);
    expect(show[0].action).toBe('show');
    expect(hide[0].action).toBe('hide');
  });

  test("LogicAction 型が 'jump' を受理する (tsc)", () => {
    const a: LogicAction = 'jump';
    const b: LogicAction = 'skip'; // レガシー互換で残置
    expect([a, b]).toEqual(['jump', 'skip']);
  });

  test("レガシー 'skip' 射影は残置 (後方互換・未知動詞は 'show')", () => {
    const legacy = fromFormalooRawLogic([jumpItem('s', 't', 'skip', { type: 'choice', value: 'a' })], identity);
    expect(legacy[0].action).toBe('skip');
    const unknown = fromFormalooRawLogic([jumpItem('s', 't', 'set', { type: 'constant', value: '1' })], identity);
    // set は未モデル動詞 → flat では 'show' に落ちる (compound additive 側で verb 保持)
    const _r: HarnessLogicRule = unknown[0];
    expect(_r.action).toBe('show');
  });
});

// ── T-B2 helpers ──
const choiceField = (id: string, items: { title: string; slug: string }[]): HarnessField => ({
  id, type: 'choice', label: 'Q', required: true, position: 1, config: { choices: items.map((i) => i.title), choiceItems: items },
});
const textField = (id: string): HarnessField => ({ id, type: 'text', label: 'T', required: false, position: 1, config: {} });
const rule = (over: Partial<HarnessLogicRule>): HarnessLogicRule => ({
  id: 'r1', sourceFieldId: 'src', operator: 'equals', value: 'C', action: 'show', targetFieldId: 'tgt', ...over,
});

describe('T-B2 — toFormalooRawLogic (R0 bare-array / args 混在型 / choice_slug)', () => {
  test('show/hide/jump 各々で actions[].args=identifier / when.args=value (取り違え 400 の番人)', () => {
    for (const action of ['show', 'hide', 'jump'] as LogicAction[]) {
      const out = toFormalooRawLogic([rule({ action })], slugId) as any[];
      expect(out).toHaveLength(1);
      const item = out[0];
      expect(item).toMatchObject({ type: 'field', identifier: 'src' });
      const act = item.actions[0];
      expect(act.action).toBe(action);
      // actions[].args は identifier キー (取り違え禁止)
      expect(act.args).toEqual([{ type: 'field', identifier: 'tgt' }]);
      // when.args は value キー (取り違え禁止)
      expect(act.when.args[0]).toEqual({ type: 'field', value: 'src' });
      expect(act.when.args[1]).toHaveProperty('value');
      expect(act.when.args[1]).not.toHaveProperty('identifier');
    }
  });

  test("operator: equals→'is' / not_equals→'is_not'", () => {
    const isOut = toFormalooRawLogic([rule({ operator: 'equals' })], slugId) as any[];
    const notOut = toFormalooRawLogic([rule({ operator: 'not_equals' })], slugId) as any[];
    expect(isOut[0].actions[0].when.operation).toBe('is');
    expect(notOut[0].actions[0].when.operation).toBe('is_not');
  });

  test("レガシー 'skip' action は Formaloo 'jump' に動詞変換される", () => {
    const out = toFormalooRawLogic([rule({ action: 'skip' })], slugId) as any[];
    expect(out[0].actions[0].action).toBe('jump');
  });

  test('choice source: rule.value(title) を choice_slug へ写像し {type:choice,value:slug} 生成 (hosted 発火)', () => {
    const src = choiceField('src', [{ title: 'A', slug: 'slugA' }, { title: 'C', slug: 'slugC' }]);
    const fieldById = (id: string) => (id === 'src' ? src : undefined);
    const out = toFormalooRawLogic([rule({ action: 'jump', value: 'C' })], slugId, fieldById) as any[];
    expect(out[0].actions[0].when.args[1]).toEqual({ type: 'choice', value: 'slugC' });
  });

  test('choice source: rule.value が既に slug の時もそのまま choice で通す (pull 由来往復)', () => {
    const src = choiceField('src', [{ title: 'C', slug: 'slugC' }]);
    const out = toFormalooRawLogic([rule({ value: 'slugC' })], slugId, (id) => (id === 'src' ? src : undefined)) as any[];
    expect(out[0].actions[0].when.args[1]).toEqual({ type: 'choice', value: 'slugC' });
  });

  test('非 choice source (text): {type:constant,value} を生成', () => {
    const out = toFormalooRawLogic([rule({ value: 'はい' })], slugId, (id) => (id === 'src' ? textField('src') : undefined)) as any[];
    expect(out[0].actions[0].when.args[1]).toEqual({ type: 'constant', value: 'はい' });
  });

  test('choice source だが slug 未解決 (choiceItems 無 = case-b) → constant 近似で構造保持', () => {
    const newChoice: HarnessField = { id: 'src', type: 'choice', label: 'Q', required: true, position: 1, config: { choices: ['C'] } };
    const out = toFormalooRawLogic([rule({ value: 'C' })], slugId, (id) => (id === 'src' ? newChoice : undefined)) as any[];
    expect(out[0].actions[0].when.args[1]).toEqual({ type: 'constant', value: 'C' });
  });

  test('fieldById 未指定 (worker が渡さない時) は全 constant にフォールバック', () => {
    const out = toFormalooRawLogic([rule({ value: 'C' })], slugId) as any[];
    expect(out[0].actions[0].when.args[1]).toEqual({ type: 'constant', value: 'C' });
  });

  test('孤立参照 (src/tgt slug 未解決) の rule は drop', () => {
    const out = toFormalooRawLogic([rule({ targetFieldId: 'missing' })], (id) => (id === 'missing' ? undefined : id)) as any[];
    expect(out).toHaveLength(0);
  });
});

describe('T-B2 — fromFormalooField が choice_item slug を choiceItems に additive 保持', () => {
  test('pull 完全形 (全 item に slug) → choiceItems=title+slug / choices=title は不変', () => {
    const f = fromFormalooField({
      slug: 'q1', type: 'choice', title: 'ルート', required: true, position: 1,
      choice_items: [
        { title: 'A', slug: 'sA', position: 1, is_other_choice: false },
        { title: 'B', slug: 'sB', position: 2, is_other_choice: false },
      ],
    }, identity);
    expect(f!.config.choices).toEqual(['A', 'B']);
    expect(f!.config.choiceItems).toEqual([{ title: 'A', slug: 'sA' }, { title: 'B', slug: 'sB' }]);
  });

  test('push 由来 [{title}] (slug 無し) → choiceItems 非設定 (後方互換)', () => {
    const f = fromFormalooField({ slug: 's', type: 'choice', title: 'x', choice_items: [{ title: 'A' }, { title: 'B' }] });
    expect(f!.config.choices).toEqual(['A', 'B']);
    expect(f!.config.choiceItems).toBeUndefined();
  });

  test('validateHarnessField は choiceItems を whitelist で通す ({title,slug}[])', () => {
    const r = validateHarnessField({ id: 'f', type: 'choice', label: 'x', config: { choices: ['A'], choiceItems: [{ title: 'A', slug: 'sA' }] } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.field.config.choiceItems).toEqual([{ title: 'A', slug: 'sA' }]);
  });

  test('validateHarnessField は不正 choiceItems を reject', () => {
    const r = validateHarnessField({ id: 'f', type: 'choice', label: 'x', config: { choiceItems: [{ title: 'A' }] } });
    expect(r.ok).toBe(false);
  });
});

describe('T-B3 — FormDisplayType モデル + jump preserve 往復不変 (preserve 経路 不可侵)', () => {
  test('FormDisplayType は simple/multi_step の 2 値 (tsc) + HarnessFormDefinition.formType additive', () => {
    const s: FormDisplayType = 'simple';
    const m: FormDisplayType = 'multi_step';
    expect([s, m]).toEqual(['simple', 'multi_step']);
    const def: HarnessFormDefinition = { fields: [], logic: [] };
    expect(def.formType).toBeUndefined(); // additive optional = 後方互換
    const def2: HarnessFormDefinition = { fields: [], logic: [], formType: 'multi_step' };
    expect(def2.formType).toBe('multi_step');
  });

  test('jump を含む rawLogic の serializeRawLogicForPush 出力が入力と逐語一致 (preserve 不可侵)', () => {
    const rawWithJump = [
      {
        type: 'field', identifier: 'q1',
        actions: [
          { action: 'jump', args: [{ type: 'field', identifier: 'pageC' }],
            when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { type: 'choice', value: 'slugC' }] } },
        ],
      },
      {
        type: 'field', identifier: 'q1',
        actions: [
          { action: 'jump_to_success_page', args: [{ type: 'field', identifier: 'end' }],
            when: { operation: 'is_not', args: [{ type: 'field', value: 'q1' }, { type: 'constant', value: 'A' }] } },
        ],
      },
    ];
    const resent = serializeRawLogicForPush(rawWithJump);
    expect(resent).not.toBeNull();
    // 逐語一致 (変換せず再送 = jump/未モデル構造を欠けなく保持)
    expect(resent).toEqual(rawWithJump);
    expect(semanticLogicEqual(resent, rawWithJump)).toBe(true);
    // jump 動詞が保持されている (射影で 'skip' に丸められていない)
    expect((resent as any[])[0].actions[0].action).toBe('jump');
    expect((resent as any[])[1].actions[0].action).toBe('jump_to_success_page');
  });
});
