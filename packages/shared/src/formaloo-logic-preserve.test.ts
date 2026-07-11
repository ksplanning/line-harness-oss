/**
 * formaloo-logic-fidelity Batch 1 (preserve-only) — shared 変換の RED→GREEN。
 *   D-1: HarnessLogicRule additive 型 (conditions?/conditionJoin?/actions?/raw?) + Condition/ActionRef export
 *   D-2: fromFormalooLogic(bare array) が compound のみ additive 付与・single は付けない (R2 一意固定)
 *   D-5: preserve 往復不変 = R0 fixture の canonical logic を verbatim 再送して semantic deep-equal (欠けゼロ)
 * 素材 = Batch 0 spike fixture (実 Formaloo GET response / redacted・secret-scan 0)。
 */
import { describe, test, expect } from 'vitest';
import {
  fromFormalooLogic,
  fromFormalooRawLogic,
  isCompoundRawLogicItem,
  countWeakenedFormalooRules,
  semanticLogicEqual,
  serializeRawLogicForPush,
  logicFingerprint,
  type HarnessLogicRule,
  type HarnessLogicCondition,
  type HarnessLogicActionRef,
} from './formaloo-forms';
import matrix from './__fixtures__/formaloo-logic-compound-matrix.json';
import roundtrip from './__fixtures__/formaloo-logic-compound-roundtrip.json';

// R0 canonical logic array = Formaloo GET `.data.form.logic` (bare array of items)。
const canonicalLogic = matrix.getLogic as unknown[];
const sentLogic = matrix.sent as unknown[];
const identity = (s: string) => s;

describe('D-1 — HarnessLogicRule additive 型 (後方互換 = single は additive 無しで有効)', () => {
  test('既存 6 フィールドのみの single rule が有効 (additive は optional)', () => {
    const single: HarnessLogicRule = { id: 'r1', sourceFieldId: 'a', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'b' };
    expect(single.conditions).toBeUndefined();
    expect(single.actions).toBeUndefined();
    expect(single.raw).toBeUndefined();
  });
  test('additive フィールド (conditions/conditionJoin/actions/raw) を持つ compound rule が型付けできる', () => {
    const cond: HarnessLogicCondition = { sourceFieldId: 'a', operator: 'gt', value: '5' };
    const act: HarnessLogicActionRef = { action: 'jump', targetFieldId: 'c' };
    const compound: HarnessLogicRule = {
      id: 'r1', sourceFieldId: 'a', operator: 'equals', value: '5', action: 'skip', targetFieldId: 'c',
      conditions: [cond], conditionJoin: 'and', actions: [act], raw: { any: 'thing' },
    };
    expect(compound.conditions).toHaveLength(1);
    expect(compound.conditionJoin).toBe('and');
    expect(compound.actions?.[0].action).toBe('jump');
    expect(compound.raw).toEqual({ any: 'thing' });
  });
});

describe('D-2 — fromFormalooLogic(bare array) = compound のみ additive 付与', () => {
  test('R0 fixture の 4 item を射影し、全て compound として additive を付与', () => {
    const rules = fromFormalooLogic(canonicalLogic, identity);
    expect(rules).toHaveLength(4);
    // item0: AND 2 条件 / show fRUnHPed
    expect(rules[0].conditionJoin).toBe('and');
    expect(rules[0].conditions).toHaveLength(2);
    expect(rules[0].conditions![0]).toEqual({ sourceFieldId: 'rvmJCJui', operator: 'is', value: '4HBthMW8' });
    expect(rules[0].conditions![1]).toEqual({ sourceFieldId: 'OJEABEJS', operator: 'is', value: 'QEsPFzwG' });
    expect(rules[0].actions).toEqual([{ action: 'show', targetFieldId: 'fRUnHPed' }]);
    expect(rules[0].raw).toEqual(canonicalLogic[0]); // 逐語断片を保持
    // flat 弱化 (builder が描画する 6 フィールドは従来型)
    expect(rules[0].sourceFieldId).toBe('rvmJCJui');
    expect(rules[0].operator).toBe('equals'); // is → equals (flat)
    expect(rules[0].action).toBe('show');
    expect(rules[0].targetFieldId).toBe('fRUnHPed');
    // item1: OR
    expect(rules[1].conditionJoin).toBe('or');
    expect(rules[1].actions).toEqual([{ action: 'hide', targetFieldId: 'onzscQWn' }]);
    // item2: 複数アクション
    expect(rules[2].actions).toEqual([
      { action: 'show', targetFieldId: 'onzscQWn' },
      { action: 'hide', targetFieldId: 'fRUnHPed' },
    ]);
    // item3: numeric gt (未モデル operator) → compound 扱いで additive に gt を保持
    expect(rules[3].conditions).toEqual([{ sourceFieldId: 'kB6HfSoC', operator: 'gt', value: '5' }]);
    expect(rules[3].conditionJoin).toBeUndefined(); // 単一 leaf は join 無し
    expect(rules[3].raw).toEqual(canonicalLogic[3]);
  });

  test('single simple item (is + 単一 action) には additive を付与しない (R2 一意固定)', () => {
    const singleItem = [
      {
        type: 'field',
        identifier: 'src',
        actions: [
          { action: 'show', args: [{ type: 'field', identifier: 'tgt' }], when: { operation: 'is', args: [{ type: 'field', value: 'src' }, { type: 'choice', value: 'C1' }] } },
        ],
      },
    ];
    const rules = fromFormalooRawLogic(singleItem, identity);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ id: 'r1', sourceFieldId: 'src', operator: 'equals', value: 'C1', action: 'show', targetFieldId: 'tgt' });
    expect(rules[0].conditions).toBeUndefined();
    expect(rules[0].conditionJoin).toBeUndefined();
    expect(rules[0].actions).toBeUndefined();
    expect(rules[0].raw).toBeUndefined();
  });

  test('isCompoundRawLogicItem / countWeakenedFormalooRules(bare array) は 4 件全てを弱化と数える', () => {
    expect(canonicalLogic.every((it) => isCompoundRawLogicItem(it))).toBe(true);
    expect(countWeakenedFormalooRules(canonicalLogic)).toBe(4);
  });

  test('resolveFieldId で slug→harness id 解決 (未解決は slug fallback)', () => {
    const rules = fromFormalooLogic(canonicalLogic, (s) => (s === 'rvmJCJui' ? 'h_src' : undefined));
    expect(rules[0].sourceFieldId).toBe('h_src');
    expect(rules[0].targetFieldId).toBe('fRUnHPed'); // 未解決 → slug fallback
  });
});

describe('D-5 — preserve 往復不変 (semantic deep-equal / 欠けゼロ)', () => {
  test('Formaloo は object key 順のみ変える (sent と GET canonical が semantic deep-equal)', () => {
    expect(semanticLogicEqual(sentLogic, canonicalLogic)).toBe(true);
  });

  test('R0 round-trip fixture: PATCH→GET→rePATCH→GET が semantic deep-equal (spike 実測 true)', () => {
    expect(roundtrip.semanticEqual).toBe(true);
    expect(semanticLogicEqual(roundtrip.canonical1, roundtrip.canonical2)).toBe(true);
  });

  test('serializeRawLogicForPush(canonical) を再送すると元 canonical と semantic deep-equal (AND/OR/複数action/gt 保持)', () => {
    const resent = serializeRawLogicForPush(canonicalLogic);
    expect(resent).not.toBeNull();
    expect(semanticLogicEqual(resent, canonicalLogic)).toBe(true);
    // 欠けゼロ spot-check: 未モデル構造 (and/or 結合・constant・複数アクション) が逐語保持されている
    const arr = resent as any[];
    expect(arr[0].actions[0].when.operation).toBe('and');
    expect(arr[1].actions[0].when.operation).toBe('or');
    expect(arr[2].actions).toHaveLength(2);
    expect(arr[3].actions[0].when.args[1]).toEqual({ type: 'constant', value: 5 });
  });

  test('非配列 rawLogic は preserve 不成立 (null)', () => {
    expect(serializeRawLogicForPush({ rules: [] })).toBeNull();
    expect(serializeRawLogicForPush(null)).toBeNull();
    expect(serializeRawLogicForPush(undefined)).toBeNull();
  });

  test('logicFingerprint: 未編集 (射影が同一) は一致・編集は不一致', () => {
    const projected = fromFormalooLogic(canonicalLogic, identity);
    expect(logicFingerprint(projected)).toBe(logicFingerprint(fromFormalooLogic(canonicalLogic, identity)));
    const edited = [...projected];
    edited[0] = { ...edited[0], value: 'CHANGED' };
    expect(logicFingerprint(edited)).not.toBe(logicFingerprint(projected));
    // key 順が違っても fingerprint は同一 (canonical)
    const reordered: HarnessLogicRule = { targetFieldId: projected[0].targetFieldId, action: projected[0].action, value: projected[0].value, operator: projected[0].operator, sourceFieldId: projected[0].sourceFieldId, id: projected[0].id, conditions: projected[0].conditions, conditionJoin: projected[0].conditionJoin, actions: projected[0].actions, raw: projected[0].raw };
    expect(logicFingerprint([reordered, ...projected.slice(1)])).toBe(logicFingerprint(projected));
  });
});
