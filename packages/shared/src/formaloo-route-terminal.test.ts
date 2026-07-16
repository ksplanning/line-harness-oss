// =============================================================================
// route-terminal-submit — ルート末尾送信 (submit) の push / pull / roundtrip /
//   countWeakened / lint 純関数テスト (TDD 先行 / spike-s1-results.md 実測正形)。
// 設計正本: .plans/2026-07-17-route-terminal-submit/{spec,plan,tasks}.md
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  toFormalooRawLogic,
  fromFormalooRawLogic,
  fromFormalooField,
  isExpandableTerminalItem,
  isExpandableMultiJumpItem,
  countWeakenedFormalooRules,
  computeRouteTerminalWarnings,
  generateSubmitWhen,
  logicFingerprint,
  type HarnessField,
  type HarnessLogicRule,
} from './formaloo-forms';

// identity resolver: harness id === Formaloo slug (テスト用)。
const idSlug = (id: string): string => id;

function field(id: string, type: HarnessField['type'], position: number, required = false, extra: Partial<HarnessField> = {}): HarnessField {
  return { id, type, label: id, required, position, config: {}, ...extra };
}

function submitRule(id: string, host: string, target = ''): HarnessLogicRule {
  // submit rule の canonical placeholder: operator=equals / value='' / terminalTrigger='on_answered'。
  return { id, sourceFieldId: host, operator: 'equals', value: '', action: 'submit', targetFieldId: target, terminalTrigger: 'on_answered' };
}
function jumpRule(id: string, src: string, value: string, pageTarget: string): HarnessLogicRule {
  return { id, sourceFieldId: src, operator: 'equals', value, action: 'jump', targetFieldId: pageTarget };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('C1 — submit push + canonical trigger (T-A1)', () => {
  it('generateSubmitWhen は is_answered 自己参照 when を決定的に生成する', () => {
    expect(generateSubmitWhen('OguGQdsk')).toEqual({
      operation: 'is_answered',
      args: [{ type: 'field', value: 'OguGQdsk' }],
    });
    // 同一 host は同一 byte
    expect(JSON.stringify(generateSubmitWhen('h'))).toBe(JSON.stringify(generateSubmitWhen('h')));
  });

  it('standalone submit rule (target 空) を drop せず {action:submit, args:[]} + is_answered when で生成', () => {
    const rules = [submitRule('r1', 'tail')];
    const out = toFormalooRawLogic(rules, idSlug);
    expect(out).toEqual([
      {
        type: 'field',
        identifier: 'tail',
        actions: [
          { action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 'tail' }] } },
        ],
      },
    ]);
  });

  it('submit host slug = when field value (自己参照)', () => {
    const out = toFormalooRawLogic([submitRule('r1', 'a9zN56oU')], idSlug) as any[];
    const item = out[0];
    expect(item.identifier).toBe('a9zN56oU');
    expect(item.actions[0].when.args[0].value).toBe('a9zN56oU');
  });

  it('同一意味の submit rule 2 つは同一 logicFingerprint (operator/value は placeholder 固定)', () => {
    const a = submitRule('r1', 'tail');
    const b = submitRule('r1', 'tail');
    expect(logicFingerprint([a])).toBe(logicFingerprint([b]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C2 — push 混在順序 + 往復恒等 (T-A2)', () => {
  it('同一 source の jump + submit を 1 item・total order = jump → submit', () => {
    const rules = [
      submitRule('r1', 'q1'),
      jumpRule('r2', 'q1', 'go', 'pageB'),
    ];
    const out = toFormalooRawLogic(rules, idSlug) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].identifier).toBe('q1');
    // 逆順で渡しても total order は jump 先・submit 後
    expect(out[0].actions.map((a: any) => a.action)).toEqual(['jump', 'submit']);
  });

  it('同一 source の jump + submit(SP target) → total order = jump → jump_to_success_page → submit', () => {
    const rules = [
      jumpRule('r1', 'q1', 'go', 'pageB'),
      submitRule('r2', 'q1', 'sp1'),
    ];
    const out = toFormalooRawLogic(rules, idSlug) as any[];
    expect(out[0].actions.map((a: any) => a.action)).toEqual(['jump', 'jump_to_success_page', 'submit']);
    // jsp は SP slug を identifier に載せる
    const jsp = out[0].actions.find((a: any) => a.action === 'jump_to_success_page');
    expect(jsp.args).toEqual([{ type: 'field', identifier: 'sp1' }]);
    // jsp と submit は同一 when (is_answered 自己参照)
    const submit = out[0].actions.find((a: any) => a.action === 'submit');
    expect(jsp.when).toEqual(submit.when);
    expect(submit.when).toEqual(generateSubmitWhen('q1'));
  });

  it.each([2, 3, 5])('N=%i ルート末尾 submit の push→pull 往復恒等', (n) => {
    const rules: HarnessLogicRule[] = [];
    for (let i = 0; i < n; i++) rules.push(submitRule(`r${i + 1}`, `tail${i}`));
    const raw = toFormalooRawLogic(rules, idSlug);
    const back = fromFormalooRawLogic(raw, idSlug);
    expect(back).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(back[i].sourceFieldId).toBe(`tail${i}`);
      expect(back[i].action).toBe('submit');
      expect(back[i].targetFieldId).toBe('');
      expect(back[i].terminalTrigger).toBe('on_answered');
    }
  });

  it('jump + submit 混在 (同一 source) の往復で action 順序・両 action 保持', () => {
    const rules = [
      jumpRule('r1', 'q1', 'A', 'pageA'),
      submitRule('r2', 'q1', 'sp1'),
    ];
    const raw = toFormalooRawLogic(rules, idSlug);
    const back = fromFormalooRawLogic(raw, idSlug);
    const jump = back.find((r) => r.action === 'jump');
    const submit = back.find((r) => r.action === 'submit');
    expect(jump?.targetFieldId).toBe('pageA');
    expect(jump?.value).toBe('A');
    expect(submit?.targetFieldId).toBe('sp1');
    expect(submit?.terminalTrigger).toBe('on_answered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C3 — pull 展開 isExpandableTerminalItem (T-A3)', () => {
  const submitItem = {
    type: 'field', identifier: 'tail',
    actions: [{ action: 'submit', args: [], when: generateSubmitWhen('tail') }],
  };
  const pairItem = {
    type: 'field', identifier: 'tail',
    actions: [
      { action: 'jump_to_success_page', args: [{ type: 'field', identifier: 'sp1' }], when: generateSubmitWhen('tail') },
      { action: 'submit', args: [], when: generateSubmitWhen('tail') },
    ],
  };
  const pureJumpItem = {
    type: 'field', identifier: 'q1',
    actions: [
      { action: 'jump', args: [{ type: 'field', identifier: 'pA' }], when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { type: 'choice', value: 'A' }] } },
      { action: 'jump', args: [{ type: 'field', identifier: 'pB' }], when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { type: 'choice', value: 'B' }] } },
    ],
  };
  const standaloneJspItem = {
    type: 'field', identifier: 'tail',
    actions: [{ action: 'jump_to_success_page', args: [{ type: 'field', identifier: 'sp1' }], when: generateSubmitWhen('tail') }],
  };
  const alwaysSubmitItem = {
    type: 'field', identifier: 'tail',
    actions: [{ action: 'submit', args: [], when: { operation: 'always', args: [] } }],
  };

  it('isExpandableTerminalItem は submit item / pair item に true', () => {
    expect(isExpandableTerminalItem(submitItem)).toBe(true);
    expect(isExpandableTerminalItem(pairItem)).toBe(true);
  });
  it('isExpandableTerminalItem は pure-jump item に false (multi-jump 経路に委譲)', () => {
    expect(isExpandableTerminalItem(pureJumpItem)).toBe(false);
    expect(isExpandableMultiJumpItem(pureJumpItem)).toBe(true);
  });
  it('standalone jump_to_success_page (submit 無) は非展開 (false)', () => {
    expect(isExpandableTerminalItem(standaloneJspItem)).toBe(false);
  });
  it('always(on_reach) submit は封印 = 非展開 (false)', () => {
    expect(isExpandableTerminalItem(alwaysSubmitItem)).toBe(false);
  });

  it('standalone submit → target 空 rule で drop しない + terminalTrigger on_answered', () => {
    const back = fromFormalooRawLogic([submitItem], idSlug);
    expect(back).toEqual([
      { id: 'r1', sourceFieldId: 'tail', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' },
    ]);
  });
  it('jsp+submit 隣接ペア (同一 when) → 1 submit rule(target=SP)', () => {
    const back = fromFormalooRawLogic([pairItem], idSlug);
    expect(back).toHaveLength(1);
    expect(back[0].action).toBe('submit');
    expect(back[0].targetFieldId).toBe('sp1');
    expect(back[0].terminalTrigger).toBe('on_answered');
  });
  it('always submit item は展開せず raw 保持 (弱化射影・raw 温存)', () => {
    const back = fromFormalooRawLogic([alwaysSubmitItem], idSlug);
    // 展開されない → submit rule として第一級化しない・raw を保持
    expect(back[0]?.raw).toBeDefined();
  });
  it('pure-jump 展開は本変更前後で不変 (byte-identity 回帰): jump rule N 本へ', () => {
    const back = fromFormalooRawLogic([pureJumpItem], idSlug);
    expect(back).toEqual([
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'pA' },
      { id: 'r2', sourceFieldId: 'q1', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'pB' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C4 — countWeakenedFormalooRules terminal 除外 (T-A4)', () => {
  it('submit / 隣接ペア item は弱化 0', () => {
    const items = [
      { type: 'field', identifier: 't1', actions: [{ action: 'submit', args: [], when: generateSubmitWhen('t1') }] },
      { type: 'field', identifier: 't2', actions: [
        { action: 'jump_to_success_page', args: [{ type: 'field', identifier: 'sp' }], when: generateSubmitWhen('t2') },
        { action: 'submit', args: [], when: generateSubmitWhen('t2') },
      ] },
    ];
    expect(countWeakenedFormalooRules(items)).toBe(0);
  });
  it('standalone jump_to_success_page は弱化計数 (mid-form no-op を隠さない)', () => {
    const items = [{ type: 'field', identifier: 't1', actions: [{ action: 'jump_to_success_page', args: [{ type: 'field', identifier: 'sp' }], when: generateSubmitWhen('t1') }] }];
    expect(countWeakenedFormalooRules(items)).toBe(1);
  });
  it('always(on_reach) submit は弱化計数 (封印警告 surface)', () => {
    const items = [{ type: 'field', identifier: 't1', actions: [{ action: 'submit', args: [], when: { operation: 'always', args: [] } }] }];
    expect(countWeakenedFormalooRules(items)).toBe(1);
  });
  it('AND/OR compound は従来どおり弱化計数 (回帰)', () => {
    const items = [{ type: 'field', identifier: 'f1', actions: [{ action: 'show', args: [{ type: 'field', identifier: 'f2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'f1' }, { type: 'choice', value: 'c' }] }] } }] }];
    expect(countWeakenedFormalooRules(items)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C5 — computeRouteTerminalWarnings (T-A5)', () => {
  // A/B/C 分岐フォーム skeleton: q1(choice) / pbA A1 A2 / pbB B1 B2 / pbC C1 C2
  function abcFields(opts: { requiredA2?: boolean } = {}): HarnessField[] {
    return [
      field('q1', 'choice', 0),
      field('pbA', 'page_break', 1),
      field('A1', 'text', 2),
      field('A2', 'text', 3, opts.requiredA2 ?? false),
      field('pbB', 'page_break', 4),
      field('B1', 'text', 5),
      field('B2', 'text', 6),
      field('pbC', 'page_break', 7),
      field('C1', 'text', 8),
      field('C2', 'text', 9),
    ];
  }
  const abcJumps: HarnessLogicRule[] = [
    jumpRule('j1', 'q1', 'A', 'pbA'),
    jumpRule('j2', 'q1', 'B', 'pbB'),
    jumpRule('j3', 'q1', 'C', 'pbC'),
  ];

  it('純 show/hide フォームは空配列 (誤警告 0)', () => {
    const fields = abcFields();
    const logic: HarnessLogicRule[] = [
      { id: 's1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'A1' },
      { id: 's2', sourceFieldId: 'q1', operator: 'equals', value: 'B', action: 'hide', targetFieldId: 'B1' },
    ];
    expect(computeRouteTerminalWarnings(fields, logic, 'simple')).toEqual([]);
  });

  it('(a) 末尾未閉鎖ルート → なだれ込み UX 警告', () => {
    // A/B は submit で閉じず、jump のみ → A/B 区間末尾がなだれ込む
    const w = computeRouteTerminalWarnings(abcFields(), abcJumps, 'multi_step');
    expect(w.some((m) => m.includes('なだれ込み'))).toBe(true);
  });

  it('全ルートを submit で閉じたフォームは (a) 警告なし', () => {
    const logic = [
      ...abcJumps,
      submitRule('sa', 'A2'),
      submitRule('sb', 'B2'),
      // C2 は最終 field = 通常 Submit で閉じる (submit 不要)
    ];
    const w = computeRouteTerminalWarnings(abcFields(), logic, 'multi_step');
    expect(w.some((m) => m.includes('なだれ込み'))).toBe(false);
  });

  it('(b) 恒常スキップされ得る区間の required → 送信不能警告', () => {
    // A2 を required に。B/C ルートは A 区間をスキップ → A2 未回答で最終 Submit がブロック
    const w = computeRouteTerminalWarnings(abcFields({ requiredA2: true }), abcJumps, 'multi_step');
    expect(w.some((m) => m.includes('必須') && m.includes('送信'))).toBe(true);
  });

  it('(d) submit host が区間の最終 field でない → データ損失警告', () => {
    // submit を A1 に置く (A 区間の最終は A2) → A2 が落ちる
    const logic = [...abcJumps, submitRule('sa', 'A1'), submitRule('sb', 'B2')];
    const w = computeRouteTerminalWarnings(abcFields(), logic, 'multi_step');
    expect(w.some((m) => m.includes('データ損失'))).toBe(true);
  });

  it('(d) submit host が区間の最終 field なら データ損失警告なし', () => {
    const logic = [...abcJumps, submitRule('sa', 'A2'), submitRule('sb', 'B2')];
    const w = computeRouteTerminalWarnings(abcFields(), logic, 'multi_step');
    expect(w.some((m) => m.includes('データ損失'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T-C4b — fromFormalooField は success_page type を安全に null-drop (Phase1 crash 防御)', () => {
  it('type=success_page 要素は null (harness field 化しない・pull が crash しない)', () => {
    const spElement = { type: 'success_page', slug: 'sp1', title: 'THANKS', description: 'done', is_default: false, position: 11 };
    expect(fromFormalooField(spElement)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('S-3 — 後方互換 (submit 未使用フォームは射影不変)', () => {
  it('show/hide/jump/skip の push は submit 追加前後で不変', () => {
    const fields = [field('q1', 'text', 0), field('t1', 'text', 1), field('pbA', 'page_break', 2)];
    const rules: HarnessLogicRule[] = [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'x', action: 'show', targetFieldId: 't1' },
      { id: 'r2', sourceFieldId: 'q1', operator: 'equals', value: 'y', action: 'jump', targetFieldId: 'pbA' },
    ];
    const out = toFormalooRawLogic(rules, idSlug, (id) => fields.find((f) => f.id === id));
    expect(out).toEqual([
      { type: 'field', identifier: 'q1', actions: [
        { action: 'show', args: [{ type: 'field', identifier: 't1' }], when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { type: 'constant', value: 'x' }] } },
        { action: 'jump', args: [{ type: 'field', identifier: 'pbA' }], when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { type: 'constant', value: 'y' }] } },
      ] },
    ]);
  });
});
