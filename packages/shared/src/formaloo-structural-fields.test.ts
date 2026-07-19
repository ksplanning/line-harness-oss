import { describe, expect, test } from 'vitest';
import {
  fromFormalooField,
  toFormalooFieldPayload,
  validateHarnessField,
  type HarnessField,
} from './formaloo-forms';

function validate(input: unknown): HarnessField {
  const result = validateHarnessField(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.field;
}

describe('matrix field OpenAPI contract', () => {
  const remoteShape = {
    slug: 'MATRIX_SLUG',
    type: 'matrix',
    title: '満足度',
    required: true,
    position: 2,
    description: '各項目を選んでください',
    choice_items: {
      quality: { title: '良い', slug: 'CHOICE_GOOD', image: 'data:image/png;base64,AAA' },
      neutral: { title: '普通' },
      provider_extension: { presentation: { badge: true }, order: 3 },
      legacy_literal: '未型付けの選択肢',
    },
    bulk_choices: { source: '良い\n普通' },
    choice_groups: [
      { ref_id: 'ROW_REF', slug: 'ROW_SERVICE', title: '接客', json_key: 'service' },
      { title: '速度' },
    ],
    config: { layout: 'compact' },
    shuffle_choices: true,
  };

  test('pull whitelists row/column identifiers and push emits the same structural shape', () => {
    const field = fromFormalooField(remoteShape, () => 'matrix_id');
    expect(field).toEqual({
      id: 'matrix_id',
      type: 'matrix',
      label: '満足度',
      required: true,
      position: 2,
      config: {
        description: '各項目を選んでください',
        matrixChoiceItems: remoteShape.choice_items,
        matrixBulkChoices: remoteShape.bulk_choices,
        matrixChoiceGroups: [
          { refId: 'ROW_REF', slug: 'ROW_SERVICE', title: '接客', jsonKey: 'service' },
          { title: '速度' },
        ],
        formalooConfig: { layout: 'compact' },
        shuffleChoices: true,
      },
    });

    expect(toFormalooFieldPayload(field!)).toEqual({
      type: 'matrix',
      title: '満足度',
      required: true,
      position: 2,
      description: '各項目を選んでください',
      choice_items: remoteShape.choice_items,
      bulk_choices: remoteShape.bulk_choices,
      choice_groups: remoteShape.choice_groups,
      config: { layout: 'compact' },
      shuffle_choices: true,
    });
  });

  test('requires a non-empty JSON object of columns and at least one titled row', () => {
    const base = { id: 'm', type: 'matrix', label: '表', required: false, position: 0 };
    for (const config of [
      {},
      { matrixChoiceItems: [], matrixChoiceGroups: [{ title: '行' }] },
      { matrixChoiceItems: {}, matrixChoiceGroups: [{ title: '行' }] },
      { matrixChoiceItems: { c1: { title: '列' } }, matrixChoiceGroups: [] },
      { matrixChoiceItems: { c1: { title: '' } }, matrixChoiceGroups: [{ title: '行' }] },
      { matrixChoiceItems: { c1: undefined }, matrixChoiceGroups: [{ title: '行' }] },
    ]) {
      expect(validateHarnessField({ ...base, config }).ok).toBe(false);
    }
  });

  test('validation strips unknown modeled properties while preserving documented additionalProperties JSON', () => {
    const field = validate({
      id: 'm', type: 'matrix', label: '表', required: false, position: 0, evil: true,
      config: {
        matrixChoiceItems: { c1: { title: 'はい', slug: 'C1', provider_hint: { mode: 'compact' } } },
        matrixChoiceGroups: [{ refId: 'R', slug: 'ROW', title: '質問', jsonKey: 'question', injected: true }],
        injected: true,
      },
    });
    expect(field.config).toEqual({
      matrixChoiceItems: { c1: { title: 'はい', slug: 'C1', provider_hint: { mode: 'compact' } } },
      matrixChoiceGroups: [{ refId: 'R', slug: 'ROW', title: '質問', jsonKey: 'question' }],
    });
  });
});

describe('repeating_section field OpenAPI contract', () => {
  test('push resolves column field ids to slugs and pull maps them back', () => {
    const field = validate({
      id: 'attendees', type: 'repeating_section', label: '参加者', required: false, position: 3,
      config: {
        repeatingColumns: [
          { columnField: 'name_id', slug: 'GROUP_NAME', title: '氏名' },
          { columnField: 'email_id', title: 'メール' },
        ],
        minRows: 1,
        maxRows: 5,
        hasOtherChoice: false,
        shuffleChoices: true,
        formalooConfig: { addButtonLabel: '参加者を追加' },
      },
    });
    const slugs: Record<string, string> = { name_id: 'NAME_SLUG', email_id: 'EMAIL_SLUG' };
    expect(toFormalooFieldPayload(field, (id) => slugs[id])).toEqual({
      type: 'repeating_section',
      title: '参加者',
      required: false,
      position: 3,
      column_groups: [
        { column_field: 'NAME_SLUG', slug: 'GROUP_NAME', title: '氏名' },
        { column_field: 'EMAIL_SLUG', title: 'メール' },
      ],
      min_rows: 1,
      max_rows: 5,
      has_other_choice: false,
      shuffle_choices: true,
      config: { addButtonLabel: '参加者を追加' },
    });

    expect(fromFormalooField({
      slug: 'REPEAT_SLUG', type: 'repeating_section', title: '参加者', required: false, position: 3,
      column_groups: [
        { column_field: 'NAME_SLUG', slug: 'GROUP_NAME', title: '氏名' },
        { column_field: 'EMAIL_SLUG', title: 'メール' },
      ],
      min_rows: 1, max_rows: 5, has_other_choice: false, shuffle_choices: true,
      config: { addButtonLabel: '参加者を追加' },
    }, (slug) => ({ REPEAT_SLUG: 'attendees', NAME_SLUG: 'name_id', EMAIL_SLUG: 'email_id' })[slug])).toEqual(field);
  });

  test('rejects invalid columns, non-integer bounds, OpenAPI overflow, and min > max', () => {
    const base = { id: 'r', type: 'repeating_section', label: '明細', required: false, position: 0 };
    for (const config of [
      {},
      { repeatingColumns: [] },
      { repeatingColumns: [{ columnField: '', title: '氏名' }] },
      { repeatingColumns: [{ columnField: 'name', title: '' }] },
      { repeatingColumns: [{ columnField: 'name', title: '氏名', slug: 42 }] },
      { repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 1.5 },
      { repeatingColumns: [{ columnField: 'name', title: '氏名' }], maxRows: 32768 },
      { repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 5, maxRows: 2 },
    ]) {
      expect(validateHarnessField({ ...base, config }).ok).toBe(false);
    }
  });
});
