/**
 * formaloo-logic-fidelity Batch 1 — push preserve-raw (D-5 push 側 / D-11 field upsert 不可侵)。
 *   - preserveRawLogic (bare array) 渡し → logic は PATCH /v3.0/forms/{slug}/ {logic:<array>} で verbatim 再送
 *   - 未渡し (ハーネス発案 logic) → 従来 PUT {logic:{rules}} (byte 不変 / 既存 formaloo-sync.test.ts 経路)
 *   - preserve 有無いずれでも field upsert (step1-2: probe/PATCH/POST・choice_items 除外) は同一挙動
 * 既存 formaloo-sync.test.ts は無改変 (別ファイルで additive 検証)。
 */
import { describe, test, expect } from 'vitest';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { FormalooResult } from './formaloo-client';
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

type MockResp = FormalooResult;
function mock(handler: (call: { method: string; path: string; body?: unknown }) => MockResp) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const run = (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    return handler(call);
  };
  const client = {
    async get<T>(path: string) { return run('GET', path) as FormalooResult<T>; },
    async post<T>(path: string, body?: unknown) { return run('POST', path, body) as FormalooResult<T>; },
    async put<T>(path: string, body?: unknown) { return run('PUT', path, body) as FormalooResult<T>; },
    async request<T>(method: string, path: string, body?: unknown) { return run(method, path, body) as FormalooResult<T>; },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const textField: HarnessField = { id: 'h1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 30 } };
// R0 実 shape: bare array (AND-compound + numeric gt)。
const rawArray = [
  { type: 'field', identifier: 'FS1', actions: [{ action: 'show', args: [{ type: 'field', identifier: 'FS2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'FS1' }, { type: 'choice', value: 'c1' }] }, { operation: 'gt', args: [{ type: 'field', value: 'FS2' }, { type: 'constant', value: 5 }] }] } }] },
];
const harnessLogic: HarnessLogicRule[] = [
  { id: 'r1', sourceFieldId: 'h1', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'h1' },
];

describe('pushDefinitionToFormaloo — preserve-raw (D-5 push)', () => {
  test('preserveRawLogic あり → logic は PATCH /v3.0/forms/{slug}/ {logic:<bare array>} で verbatim 再送 (PUT 不使用)', async () => {
    const { client, calls } = mock(({ method, path }) => {
      if (method === 'GET') return { ok: true, status: 200, data: {} }; // field probe 200 → PATCH
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'SLUG', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'FS1' },
      preserveRawLogic: rawArray,
    });
    expect(r.ok).toBe(true);
    const logicCall = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/SLUG/');
    expect(logicCall).toBeDefined();
    expect((logicCall!.body as { logic: unknown }).logic).toEqual(rawArray); // 逐語 (欠けゼロ・AND/gt/constant 保持)
    // 旧 PUT {logic:{rules}} 経路は使わない (R0: PUT は full-replace で 400/500)
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/v3.0/forms/SLUG/')).toBe(false);
  });

  test('preserveRawLogic が空配列 [] (Formaloo 側 logic クリア) も PATCH {logic:[]} で再送 (消去を保持)', async () => {
    const { client, calls } = mock(() => ({ ok: true, status: 200, data: {} }));
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'SLUG', title: 't', fields: [], logic: [], preserveRawLogic: [],
    });
    expect(r.ok).toBe(true);
    const logicCall = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/SLUG/');
    expect((logicCall!.body as { logic: unknown[] }).logic).toEqual([]);
  });

  test('preserveRawLogic 無し + ハーネス編集 logic → R0 bare-array PATCH (T-C1 latent-500 是正 / 旧 PUT 廃止)', async () => {
    const { client, calls } = mock(({ method, path }) => {
      if (method === 'POST' && path === '/v3.0/forms/') return { ok: true, status: 201, data: { data: { form: { slug: 'NF' } } } };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: true, status: 201, data: { data: { field: { slug: 'FSx' } } } };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields: [textField], logic: harnessLogic });
    expect(r.ok).toBe(true);
    // 旧 PUT {logic:{rules}} は使わない (R0: 本番 500)
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/v3.0/forms/NF/')).toBe(false);
    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/NF/');
    expect(patch).toBeDefined();
    const arr = (patch!.body as { logic: unknown[] }).logic;
    expect(Array.isArray(arr)).toBe(true); // bare array 形
    expect(arr).toHaveLength(1);
  });

  test('preserve でも field upsert (step1-2) は不可侵: 既存 slug は PATCH /v3.0/fields/{slug}/ + choice_items 除外', async () => {
    const choiceField: HarnessField = { id: 'h2', type: 'choice', label: '性別', required: true, position: 1, config: { choices: ['男', '女'] } };
    const { client, calls } = mock(() => ({ ok: true, status: 200, data: {} }));
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'SLUG', title: 't', fields: [choiceField], logic: [], existingFieldSlugs: { h2: 'sl2' },
      preserveRawLogic: rawArray,
    });
    expect(r.ok).toBe(true);
    const fieldPatch = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/fields/sl2/');
    expect(fieldPatch).toBeDefined();
    expect((fieldPatch!.body as Record<string, unknown>).choice_items).toBeUndefined(); // choice_items 除外 (B6 不変)
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false); // 重複作成しない
  });

  test('複製用 raw template は新 field/choice slug へ解決してから複合 logic を欠けなく送る', async () => {
    const choiceField: HarnessField = {
      id: 'choice-copy',
      type: 'choice',
      label: '参加プラン',
      required: true,
      position: 0,
      config: { choices: ['昼', '夜'] },
    };
    const targetField: HarnessField = {
      id: 'target-copy',
      type: 'text',
      label: '氏名',
      required: true,
      position: 1,
      config: {},
    };
    const rawLogicTemplate = [{
      type: 'field',
      identifier: 'choice-copy',
      actions: [{
        action: 'show',
        args: [{ type: 'field', identifier: 'target-copy' }],
        when: {
          operation: 'and',
          args: [
            {
              operation: 'is',
              args: [
                { type: 'field', value: 'choice-copy' },
                { type: 'choice', value: '夜', __harnessChoiceFieldId: 'choice-copy' },
              ],
            },
            {
              operation: 'is_answered',
              args: [{ type: 'field', value: 'target-copy' }],
            },
          ],
        },
      }],
    }];
    const { client, calls } = mock(({ method, path, body }) => {
      if (method === 'POST' && path === '/v3.0/forms/') {
        return { ok: true, status: 201, data: { data: { form: { slug: 'FORM_NEW' } } } };
      }
      if (method === 'POST' && path === '/v3.0/fields/') {
        const title = (body as { title?: string })?.title;
        return {
          ok: true,
          status: 201,
          data: { data: { field: { slug: title === '参加プラン' ? 'CHOICE_NEW' : 'TARGET_NEW' } } },
        };
      }
      if (method === 'GET' && path === '/v3.0/fields/CHOICE_NEW/') {
        return {
          ok: true,
          status: 200,
          data: {
            data: {
              field: {
                choice_items: [
                  { title: '昼', slug: 'DAY_NEW' },
                  { title: '夜', slug: 'NIGHT_NEW' },
                ],
              },
            },
          },
        };
      }
      return { ok: true, status: 200, data: {} };
    });

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null,
      title: '複製フォーム',
      fields: [choiceField, targetField],
      logic: [],
      rawLogicTemplate,
    });

    expect(result.ok).toBe(true);
    const logicCall = calls.find(
      (call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM_NEW/',
    );
    expect((logicCall?.body as { logic: unknown[] }).logic).toEqual([{
      type: 'field',
      identifier: 'CHOICE_NEW',
      actions: [{
        action: 'show',
        args: [{ type: 'field', identifier: 'TARGET_NEW' }],
        when: {
          operation: 'and',
          args: [
            {
              operation: 'is',
              args: [
                { type: 'field', value: 'CHOICE_NEW' },
                { type: 'choice', value: 'NIGHT_NEW' },
              ],
            },
            {
              operation: 'is_answered',
              args: [{ type: 'field', value: 'TARGET_NEW' }],
            },
          ],
        },
      }],
    }]);
    expect(result.resolvedRawLogic).toEqual(
      (logicCall?.body as { logic: unknown[] }).logic,
    );
  });

  test('legacy bare-array の field キーを新 field slug へ解決して送る', async () => {
    const sourceField: HarnessField = {
      id: 'legacy-source',
      type: 'text',
      label: '氏名',
      required: true,
      position: 0,
      config: {},
    };
    const targetField: HarnessField = {
      id: 'legacy-target',
      type: 'text',
      label: '詳細',
      required: false,
      position: 1,
      config: {},
    };
    const { client, calls } = mock(() => ({ ok: true, status: 200, data: {} }));

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM_NEW',
      title: '複製フォーム',
      fields: [sourceField, targetField],
      logic: [],
      existingFieldSlugs: {
        'legacy-source': 'SOURCE_NEW',
        'legacy-target': 'TARGET_NEW',
      },
      rawLogicTemplate: [{
        identifier: 'raw_logic_copy',
        conditions: [
          { field: 'legacy-source', operator: 'equals', value: '山田' },
        ],
        actions: [
          { type: 'show', field: 'legacy-target' },
        ],
      }],
    });

    expect(result.ok).toBe(true);
    const logicCall = calls.find(
      (call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM_NEW/',
    );
    expect((logicCall?.body as { logic: unknown[] }).logic).toEqual([{
      identifier: 'raw_logic_copy',
      conditions: [
        { field: 'SOURCE_NEW', operator: 'equals', value: '山田' },
      ],
      actions: [
        { type: 'show', field: 'TARGET_NEW' },
      ],
    }]);
  });

  test('複製用 raw template に未解決 provider 参照があれば元 slug を送らず fail-closed にする', async () => {
    const { client, calls } = mock(() => ({ ok: true, status: 200, data: {} }));

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM_NEW',
      title: '複製フォーム',
      fields: [],
      logic: [],
      rawLogicTemplate: [{
        type: 'field',
        identifier: 'SOURCE_PROVIDER_FIELD',
        actions: [],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('raw logic field reference unresolved');
    expect(calls.some(
      (call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM_NEW/',
    )).toBe(false);
  });

  test('複製用 raw template の choice title が provider 側で重複したら logic を送らず fail-closed', async () => {
    const choiceField: HarnessField = {
      id: 'choice-copy',
      type: 'choice',
      label: '参加プラン',
      required: true,
      position: 0,
      config: { choices: ['夜'] },
    };
    const targetField: HarnessField = {
      id: 'target-copy',
      type: 'text',
      label: '氏名',
      required: true,
      position: 1,
      config: {},
    };
    const { client, calls } = mock(({ method, path }) => {
      if (method === 'GET' && path === '/v3.0/fields/CHOICE_NEW/') {
        return {
          ok: true,
          status: 200,
          data: {
            data: {
              field: {
                choice_items: [
                  { title: '夜', slug: 'NIGHT_A' },
                  { title: '夜', slug: 'NIGHT_B' },
                ],
              },
            },
          },
        };
      }
      return { ok: true, status: 200, data: {} };
    });

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FORM_NEW',
      title: '複製フォーム',
      fields: [choiceField, targetField],
      logic: [],
      existingFieldSlugs: {
        'choice-copy': 'CHOICE_NEW',
        'target-copy': 'TARGET_NEW',
      },
      rawLogicTemplate: [{
        type: 'field',
        identifier: 'choice-copy',
        actions: [{
          action: 'show',
          args: [{ type: 'field', identifier: 'target-copy' }],
          when: {
            operation: 'is',
            args: [
              { type: 'field', value: 'choice-copy' },
              { type: 'choice', value: '夜', __harnessChoiceFieldId: 'choice-copy' },
            ],
          },
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('raw logic choice title duplicate: choice-copy/夜');
    expect(calls.some(
      (call) => call.method === 'PATCH' && call.path === '/v3.0/forms/FORM_NEW/',
    )).toBe(false);
  });
});
