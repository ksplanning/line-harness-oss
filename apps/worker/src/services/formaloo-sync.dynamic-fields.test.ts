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
      const type = (body as { type?: string } | undefined)?.type;
      const slug = type === 'number' ? 'PRICE_SLUG' : type === 'variable' ? 'TOTAL_SLUG' : 'FIELD_SLUG';
      return { ok: true, status: 201, data: { data: { field: { slug } } } } as FormalooResult<T>;
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

const price: HarnessField = {
  id: 'price', type: 'number', label: '単価', required: true, position: 1, config: {},
};
const total: HarnessField = {
  id: 'total', type: 'variable', label: '合計', required: false, position: 0,
  config: { variableSubType: 'formula', formula: '{price}*2', decimalPlaces: 0 },
};

describe('variable formula push slug resolution', () => {
  test('new referenced fields are created first even when formula appears earlier in display order', async () => {
    const { client, calls } = mockClient();
    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null, title: '見積り', fields: [total, price], logic: [],
    });

    expect(result.ok).toBe(true);
    const posts = calls.filter((call) => call.method === 'POST' && call.path === '/v3.0/fields/');
    expect((posts[0].body as { type: string }).type).toBe('number');
    expect(posts[1].body).toMatchObject({
      type: 'variable',
      sub_type: 'formula',
      config: { formula: '{PRICE_SLUG}*2' },
      form: 'FORM',
    });
    expect(result.fieldSlugs).toEqual({ price: 'PRICE_SLUG', total: 'TOTAL_SLUG' });
  });

  test('existing formula PATCH resolves internal ids with existing field slugs', async () => {
    const { client, calls } = mockClient();
    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM', title: '見積り', fields: [total, price], logic: [],
      existingFieldSlugs: { total: 'TOTAL_SLUG', price: 'PRICE_SLUG' },
    });

    expect(result.ok).toBe(true);
    const formulaPatch = calls.find((call) => call.path === '/v3.0/fields/TOTAL_SLUG/');
    expect(formulaPatch?.body).toMatchObject({ config: { formula: '{PRICE_SLUG}*2' } });
  });

  test('an unknown formula reference fails before sending an invalid field payload', async () => {
    const { client, calls } = mockClient();
    const invalid: HarnessField = {
      ...total,
      config: { variableSubType: 'formula', formula: '{missing}*2' },
    };
    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM', title: '見積り', fields: [invalid, price], logic: [],
      existingFieldSlugs: { total: 'TOTAL_SLUG', price: 'PRICE_SLUG' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('formula reference missing');
    expect(calls.some((call) => call.path.startsWith('/v3.0/fields/'))).toBe(false);
  });
});
