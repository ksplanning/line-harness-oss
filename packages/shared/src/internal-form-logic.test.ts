import { describe, expect, test } from 'vitest';
import type { HarnessField, HarnessLogicRule } from './formaloo-forms.js';
import {
  INTERNAL_FORM_CHANNEL_SOURCE_ID,
  evaluateInternalFormLogic,
  nextInternalFormFieldId,
} from './internal-form-logic.js';

const fields: HarnessField[] = [
  { id: 'route', type: 'choice', label: 'コース', required: true, position: 0, config: { choices: ['A', 'B', 'C'] } },
  { id: 'page-a', type: 'page_break', label: 'A', required: false, position: 1, config: {} },
  { id: 'a-name', type: 'text', label: 'Aのお名前', required: true, position: 2, config: {} },
  { id: 'page-b', type: 'page_break', label: 'B', required: false, position: 3, config: {} },
  { id: 'b-name', type: 'text', label: 'Bのお名前', required: true, position: 4, config: {} },
  { id: 'page-c', type: 'page_break', label: 'C', required: false, position: 5, config: {} },
  { id: 'c-name', type: 'text', label: 'Cのお名前', required: true, position: 6, config: {} },
];

const abcLogic: HarnessLogicRule[] = [
  { id: 'jump-a', sourceFieldId: 'route', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'page-a' },
  { id: 'jump-b', sourceFieldId: 'route', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'page-b' },
  { id: 'jump-c', sourceFieldId: 'route', operator: 'equals', value: 'C', action: 'jump', targetFieldId: 'page-c' },
  { id: 'submit-a', sourceFieldId: 'a-name', operator: 'equals', value: '', action: 'submit', targetFieldId: 'done-a', terminalTrigger: 'on_answered' },
  { id: 'submit-b', sourceFieldId: 'b-name', operator: 'equals', value: '', action: 'submit', targetFieldId: 'done-b', terminalTrigger: 'on_answered' },
  { id: 'submit-c', sourceFieldId: 'c-name', operator: 'equals', value: '', action: 'submit', targetFieldId: 'done-c', terminalTrigger: 'on_answered' },
];

describe('evaluateInternalFormLogic', () => {
  test('一覧形式でも回答に応じて ABC の対象セクションだけを同一ページに出す', () => {
    expect(evaluateInternalFormLogic(fields, abcLogic, {}, 'web').visibleFieldIds).toEqual(['route']);

    const state = evaluateInternalFormLogic(fields, abcLogic, { route: 'B' }, 'web');
    expect(state.visibleFieldIds).toEqual(['route', 'page-b', 'b-name']);
    expect(state.hiddenFieldIds).toEqual(['page-a', 'a-name', 'page-c', 'c-name']);
  });

  test('multi-step は同じ評価結果から jump 先とルート別完了ページを決める', () => {
    const jumped = evaluateInternalFormLogic(fields, abcLogic, { route: 'B' }, 'line');
    expect(jumped.activeJumpBySource.route).toBe('page-b');
    expect(nextInternalFormFieldId(fields, jumped, 'route')).toBe('page-b');
    expect(nextInternalFormFieldId(fields, jumped, 'page-b')).toBe('b-name');

    const completed = evaluateInternalFormLogic(fields, abcLogic, { route: 'B', 'b-name': '佐藤' }, 'line');
    expect(completed.completionSourceId).toBe('b-name');
    expect(completed.completionPageId).toBe('done-b');
    expect(nextInternalFormFieldId(fields, completed, 'b-name')).toBeNull();
  });

  test('show/hide は未回答から回答後へ動的に切り替わる', () => {
    const conditionalFields: HarnessField[] = [
      { id: 'kind', type: 'choice', label: '種別', required: true, position: 0, config: { choices: ['法人', '個人'] } },
      { id: 'company', type: 'text', label: '会社名', required: true, position: 1, config: {} },
      { id: 'nickname', type: 'text', label: '呼び名', required: false, position: 2, config: {} },
    ];
    const logic: HarnessLogicRule[] = [
      { id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'company' },
      { id: 'hide-nickname', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'hide', targetFieldId: 'nickname' },
    ];

    expect(evaluateInternalFormLogic(conditionalFields, logic, {}, 'web').visibleFieldIds).toEqual(['kind', 'nickname']);
    expect(evaluateInternalFormLogic(conditionalFields, logic, { kind: '法人' }, 'web').visibleFieldIds).toEqual(['kind', 'company']);
  });

  test('経由チャネルを条件ソースにして LINE と直リンクの表示を分ける', () => {
    const channelFields: HarnessField[] = [
      { id: 'name', type: 'text', label: '名前', required: true, position: 0, config: {} },
      { id: 'email', type: 'email', label: 'メール', required: true, position: 1, config: {} },
    ];
    const logic: HarnessLogicRule[] = [
      { id: 'web-email', sourceFieldId: INTERNAL_FORM_CHANNEL_SOURCE_ID, operator: 'equals', value: 'web', action: 'show', targetFieldId: 'email' },
    ];

    expect(evaluateInternalFormLogic(channelFields, logic, {}, 'line').visibleFieldIds).toEqual(['name']);
    expect(evaluateInternalFormLogic(channelFields, logic, {}, 'web').visibleFieldIds).toEqual(['name', 'email']);
  });

  test('既存の not_equals と compound AND 条件を評価する', () => {
    const compoundFields: HarnessField[] = [
      { id: 'kind', type: 'choice', label: '種別', required: true, position: 0, config: { choices: ['法人', '個人'] } },
      { id: 'region', type: 'choice', label: '地域', required: true, position: 1, config: { choices: ['東', '西'] } },
      { id: 'detail', type: 'text', label: '詳細', required: false, position: 2, config: {} },
    ];
    const logic: HarnessLogicRule[] = [{
      id: 'compound', sourceFieldId: 'kind', operator: 'not_equals', value: '個人', action: 'show', targetFieldId: 'detail',
      conditions: [
        { sourceFieldId: 'kind', operator: 'is', value: '法人' },
        { sourceFieldId: 'region', operator: 'is_not', value: '西' },
      ],
      conditionJoin: 'and',
    }];

    expect(evaluateInternalFormLogic(compoundFields, logic, { kind: '法人', region: '東' }, 'web').visibleFieldIds).toContain('detail');
    expect(evaluateInternalFormLogic(compoundFields, logic, { kind: '法人', region: '西' }, 'web').visibleFieldIds).not.toContain('detail');
  });
});
