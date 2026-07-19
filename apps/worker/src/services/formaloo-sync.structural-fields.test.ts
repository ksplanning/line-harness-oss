import { describe, expect, test } from 'vitest';
import type { HarnessField } from '@line-crm/shared';
import type { FormalooResult } from './formaloo-client';
import { pushDefinitionToFormaloo } from './formaloo-sync';

function mockClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'POST', path, body });
      if (path === '/v3.0/forms/') {
        return { ok: true, status: 201, data: { data: { form: { slug: 'FORM', full_form_address: 'https://forms.example.test/f/FORM' } } } } as FormalooResult<T>;
      }
      if (path === '/v3.0/fields/matrix/') {
        return { ok: true, status: 201, data: { slug: 'MATRIX_SLUG' } } as FormalooResult<T>;
      }
      if (path === '/v3.0/fields/repeating_section/') {
        return { ok: true, status: 201, data: { data: { field: { slug: 'REPEAT_SLUG' } } } } as FormalooResult<T>;
      }
      return { ok: true, status: 201, data: { data: { field: { slug: 'NAME_SLUG' } } } } as FormalooResult<T>;
    },
    async request<T>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method, path, body });
      return { ok: true, status: 200, data: {} } as FormalooResult<T>;
    },
    async put<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'PUT', path, body });
      return { ok: true, status: 200, data: {} } as FormalooResult<T>;
    },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const nameField = {
  id: 'name', type: 'text', label: '氏名', required: true, position: 0, config: {},
} as HarnessField;
const matrixField = {
  id: 'matrix', type: 'matrix', label: '満足度', required: true, position: 1,
  config: {
    matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
    matrixChoiceGroups: [{ title: '接客' }, { title: '速度' }],
  },
} as HarnessField;
const repeatingField = {
  id: 'repeat', type: 'repeating_section', label: '参加者', required: false, position: 2,
  config: { repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 1, maxRows: 3 },
} as HarnessField;

describe('structural field transport', () => {
  test('POST uses the OpenAPI-specific create endpoints and resolves repeating column slugs', async () => {
    const { client, calls } = mockClient();
    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null, title: '申込', fields: [repeatingField, matrixField, nameField], logic: [],
    });

    expect(result.ok).toBe(true);
    const posts = calls.filter((call) => call.method === 'POST' && call.path !== '/v3.0/forms/');
    expect(posts.map((call) => call.path)).toEqual([
      '/v3.0/fields/matrix/',
      '/v3.0/fields/',
      '/v3.0/fields/repeating_section/',
    ]);
    expect(posts[0].body).toEqual({
      form: 'FORM', title: '満足度', required: true, position: 1,
      bulk_choices: ['良い', '悪い'],
      choice_groups: [{ title: '接客' }, { title: '速度' }],
    });
    expect(posts[0].body).not.toHaveProperty('choice_items');
    expect(posts[2].body).toEqual({
      form: 'FORM', title: '参加者', required: false, position: 2,
      column_groups: [{ column_field: 'NAME_SLUG', title: '氏名' }], min_rows: 1, max_rows: 3,
    });
    expect(result.fieldSlugs).toEqual({ name: 'NAME_SLUG', matrix: 'MATRIX_SLUG', repeat: 'REPEAT_SLUG' });
  });

  test('matrix PATCH uses bulk_choices while every PATCH omits choice_items', async () => {
    const { client, calls } = mockClient();
    const choice = {
      id: 'choice', type: 'choice', label: '選択', required: false, position: 0, config: { choices: ['A', 'B'] },
    } as HarnessField;
    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM', title: '申込', fields: [choice, matrixField], logic: [],
      existingFieldSlugs: { choice: 'CHOICE_SLUG', matrix: 'MATRIX_SLUG' },
    });

    expect(result.ok).toBe(true);
    const choicePatch = calls.find((call) => call.path === '/v3.0/fields/CHOICE_SLUG/');
    const matrixPatch = calls.find((call) => call.path === '/v3.0/fields/MATRIX_SLUG/');
    expect(choicePatch?.body).not.toHaveProperty('choice_items');
    expect(matrixPatch?.body).toMatchObject({
      type: 'matrix',
      bulk_choices: ['良い', '悪い'],
    });
    expect(matrixPatch?.body).not.toHaveProperty('choice_items');
  });
});
