import { describe, expect, test } from 'vitest';
import {
  canonicalDefinitionProjection,
  formalooDefinitionFingerprint,
  stableStringify,
} from './formaloo-fingerprint';

const matrix = (rowTitle = '接客') => ({
  slug: 'MATRIX', type: 'matrix', title: '満足度', required: true, position: 1,
  choice_items: { good: { title: '良い', slug: 'GOOD' }, bad: { title: '悪い' } },
  choice_groups: [{ ref_id: 'ROW_REF', slug: 'ROW', title: rowTitle, json_key: 'service' }],
  config: { layout: 'compact' }, shuffle_choices: false,
});

const repeating = (maxRows = 4) => ({
  slug: 'REPEAT', type: 'repeating_section', title: '参加者', required: false, position: 2,
  column_groups: [{ column_field: 'NAME', slug: 'CG_NAME', title: '氏名' }],
  min_rows: 1, max_rows: maxRows, has_other_choice: false, shuffle_choices: false,
  config: { addButtonLabel: '追加' },
});

describe('structural field fingerprint projection', () => {
  test('projects only the keys consumed by matrix/repeating pull', () => {
    expect(canonicalDefinitionProjection([matrix(), repeating()], []).fields).toEqual([
      {
        slug: 'MATRIX', type: 'matrix', title: '満足度', required: true, position: 1,
        matrixChoiceItems: { good: { title: '良い', slug: 'GOOD' }, bad: { title: '悪い' } },
        matrixChoiceGroups: [{ refId: 'ROW_REF', slug: 'ROW', title: '接客', jsonKey: 'service' }],
        formalooConfig: { layout: 'compact' },
      },
      {
        slug: 'REPEAT', type: 'repeating_section', title: '参加者', required: false, position: 2,
        repeatingColumns: [{ columnField: 'NAME', slug: 'CG_NAME', title: '氏名' }],
        minRows: 1, maxRows: 4, formalooConfig: { addButtonLabel: '追加' },
      },
    ]);
  });

  test('row/column/bounds changes alter the fingerprint', async () => {
    expect(await formalooDefinitionFingerprint([matrix('接客')], [])).not.toBe(
      await formalooDefinitionFingerprint([matrix('速度')], []),
    );
    expect(await formalooDefinitionFingerprint([repeating(4)], [])).not.toBe(
      await formalooDefinitionFingerprint([repeating(5)], []),
    );
  });

  test('false API defaults are omitted while true values remain meaningful', () => {
    const defaults = canonicalDefinitionProjection([matrix(), repeating()], []).fields as unknown as Array<Record<string, unknown>>;
    expect(defaults[0]).not.toHaveProperty('shuffleChoices');
    expect(defaults[1]).not.toHaveProperty('shuffleChoices');
    expect(defaults[1]).not.toHaveProperty('hasOtherChoice');

    const enabled = canonicalDefinitionProjection([
      { ...matrix(), shuffle_choices: true },
      { ...repeating(), has_other_choice: true, shuffle_choices: true },
    ], []).fields as unknown as Array<Record<string, unknown>>;
    expect(enabled[0].shuffleChoices).toBe(true);
    expect(enabled[1]).toMatchObject({ hasOtherChoice: true, shuffleChoices: true });
  });

  test('legacy form projection stays byte-identical when structural keys are absent', () => {
    const projection = canonicalDefinitionProjection([
      { slug: 'NAME', type: 'short_text', title: '名前', required: true, position: 0, max_length: 30 },
    ], []);
    expect(stableStringify(projection)).toBe(
      '{"fields":[{"max_length":30,"position":0,"required":true,"slug":"NAME","title":"名前","type":"short_text"}],"logic":[]}',
    );
  });
});
