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
  type HarnessLogicRule,
  type LogicAction,
} from './formaloo-forms';

const identity = (s: string) => s;

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
