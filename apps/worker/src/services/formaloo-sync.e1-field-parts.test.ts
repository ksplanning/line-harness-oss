import { describe, expect, test } from 'vitest';
import type { FormalooResult } from './formaloo-client';
import type { FormalooClient } from './formaloo-client';
import { buildPullResult } from './formaloo-pull';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { HarnessField } from '@line-crm/shared';

const fields: HarnessField[] = [
  { id: 'h_yes_no', type: 'yes_no', label: '確認', required: true, position: 0, config: { description: 'はいかいいえで回答' } },
  { id: 'h_time', type: 'time', label: '希望時刻', required: false, position: 1, config: {} },
  { id: 'h_website', type: 'website', label: 'ホームページ', required: false, position: 2, config: {} },
  { id: 'h_city', type: 'city', label: '市区町村', required: true, position: 3, config: {} },
];

describe('treasure E1 field parts — push実形とGET read-back', () => {
  test('4型をgeneric endpointへexact enumでPOSTし、GET read-back形をpullできる', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let fieldNumber = 0;
    const client = {
      async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
        calls.push({ method: 'POST', path, body });
        if (path === '/v3.0/forms/') {
          return {
            ok: true,
            status: 201,
            data: { data: { form: { slug: 'E1FORM', full_form_address: 'https://example.invalid/e1' } } },
          } as FormalooResult<T>;
        }
        fieldNumber += 1;
        return {
          ok: true,
          status: 201,
          data: { data: { field: { slug: `REMOTE_${fieldNumber}` } } },
        } as FormalooResult<T>;
      },
      async request<T>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
        calls.push({ method, path, body });
        return { ok: true, status: 200, data: {} } as FormalooResult<T>;
      },
    } as unknown as FormalooClient;

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null,
      title: 'E1 scratch contract',
      fields,
      logic: [],
    });
    expect(result).toMatchObject({
      ok: true,
      formalooSlug: 'E1FORM',
      fieldSlugs: {
        h_yes_no: 'REMOTE_1',
        h_time: 'REMOTE_2',
        h_website: 'REMOTE_3',
        h_city: 'REMOTE_4',
      },
    });

    const fieldPosts = calls.filter((call) => call.method === 'POST' && call.path === '/v3.0/fields/');
    expect(fieldPosts.map((call) => call.body)).toEqual([
      { form: 'E1FORM', type: 'yes_no', title: '確認', required: true, position: 0, description: 'はいかいいえで回答' },
      { form: 'E1FORM', type: 'time', title: '希望時刻', required: false, position: 1 },
      { form: 'E1FORM', type: 'website', title: 'ホームページ', required: false, position: 2 },
      { form: 'E1FORM', type: 'city', title: '市区町村', required: true, position: 3 },
    ]);

    // Batch 0 の個別 GET と同じ wrapper 内 field shapeを再現し、soft-200で無視された
    // 誤キーが無いことを read-back→pull の往復で動詞化する。
    const remoteToHarness = new Map(Object.entries(result.fieldSlugs ?? {}).map(([id, slug]) => [slug, id]));
    const readBackFields = fieldPosts.map((call, index) => ({
      ...(call.body as Record<string, unknown>),
      slug: `REMOTE_${index + 1}`,
      config: {},
      invisible: false,
      admin_only: false,
      read_only: false,
    }));
    const pulled = buildPullResult(
      { data: { form: { fields_list: readBackFields, logic: [] } } },
      (slug) => remoteToHarness.get(slug),
    );
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.fields).toEqual(fields);
  });
});
