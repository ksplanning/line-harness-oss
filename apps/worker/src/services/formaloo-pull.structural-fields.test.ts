import { describe, expect, test, vi } from 'vitest';
import { toFormalooFieldPayload } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';
import { pullDefinitionFromFormaloo } from './formaloo-pull';

function client(fields: unknown[]): FormalooClient {
  return {
    get: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { data: { form: { fields_list: fields, logic: { rules: [] } } } },
    })),
  } as unknown as FormalooClient;
}

describe('structural fields pull integration', () => {
  test('matrix/repeating survive form detail pull with id/slug maps and re-emit symmetrically', async () => {
    const fields = [
      { slug: 'NAME_SLUG', type: 'short_text', title: '氏名', required: true, position: 0 },
      {
        slug: 'MATRIX_SLUG', type: 'matrix', title: '満足度', required: true, position: 1,
        choice_items: { good: { title: '良い', slug: 'GOOD' }, bad: { title: '悪い' } },
        choice_groups: [{ ref_id: 'ROW_REF', slug: 'ROW', title: '接客', json_key: 'service' }],
        shuffle_choices: true,
      },
      {
        slug: 'REPEAT_SLUG', type: 'repeating_section', title: '参加者', required: false, position: 2,
        column_groups: [{ column_field: 'NAME_SLUG', slug: 'GROUP_NAME', title: '氏名' }],
        min_rows: 1, max_rows: 4,
      },
    ];
    const ids: Record<string, string> = {
      NAME_SLUG: 'name_id', MATRIX_SLUG: 'matrix_id', REPEAT_SLUG: 'repeat_id',
    };
    const result = await pullDefinitionFromFormaloo(client(fields), {
      formalooSlug: 'FORM',
      resolveId: (slug) => ids[slug],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.map((field) => [field.id, field.type])).toEqual([
      ['name_id', 'text'], ['matrix_id', 'matrix'], ['repeat_id', 'repeating_section'],
    ]);
    expect(result.fieldSlugById).toEqual({
      name_id: 'NAME_SLUG', matrix_id: 'MATRIX_SLUG', repeat_id: 'REPEAT_SLUG',
    });
    expect(result.fields[2].config.repeatingColumns).toEqual([
      { columnField: 'name_id', slug: 'GROUP_NAME', title: '氏名' },
    ]);

    const slugById = result.fieldSlugById ?? {};
    expect(toFormalooFieldPayload(result.fields[1])).toMatchObject({
      choice_items: fields[1].choice_items,
      choice_groups: fields[1].choice_groups,
      shuffle_choices: true,
    });
    expect(toFormalooFieldPayload(result.fields[2], (id) => slugById[id])).toMatchObject({
      column_groups: fields[2].column_groups,
      min_rows: 1,
      max_rows: 4,
    });
  });
});
