/**
 * form-route-branching worker — T-C2 (form_type pull/persist/差分 push)。
 * spike T-A0: top-level `form_type` は 'simple'|'multi_step' の 2 値のみ。差分時のみ PATCH (勝手に変えない)。
 */
import { describe, test, expect } from 'vitest';
import { extractFormType, buildPullResult } from './formaloo-pull';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { FormalooResult } from './formaloo-client';
import type { HarnessField } from '@line-crm/shared';

function mock() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const run = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { ok: true, status: 200, data: {} } as FormalooResult;
  };
  const client = {
    async post<T>(p: string, b?: unknown) { return run('POST', p, b) as FormalooResult<T>; },
    async put<T>(p: string, b?: unknown) { return run('PUT', p, b) as FormalooResult<T>; },
    async request<T>(m: string, p: string, b?: unknown) { return run(m, p, b) as FormalooResult<T>; },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const textField: HarnessField = { id: 'h1', type: 'text', label: '名', required: false, position: 0, config: {} };

describe('T-C2 — extractFormType (pull)', () => {
  test("form_type='multi_step' を formType へ復元", () => {
    expect(extractFormType({ data: { form: { fields_list: [], form_type: 'multi_step' } } })).toBe('multi_step');
  });
  test("form_type='simple' を復元", () => {
    expect(extractFormType({ data: { form: { fields_list: [], form_type: 'simple' } } })).toBe('simple');
  });
  test('未知値/欠落は undefined (後方互換 = drift 誤検知しない)', () => {
    expect(extractFormType({ data: { form: { fields_list: [], form_type: 'weird' } } })).toBeUndefined();
    expect(extractFormType({ data: { form: { fields_list: [] } } })).toBeUndefined();
  });
});

describe('T-C2 — buildPullResult は formType を反映 (未設定は載せない)', () => {
  test('multi_step フォーム → pull.formType=multi_step', () => {
    const body = { data: { form: { fields_list: [], form_type: 'multi_step' } } };
    const r = buildPullResult(body, (s) => s);
    expect(r.ok && r.formType).toBe('multi_step');
  });
  test('form_type 無しフォーム → formType キー非存在 (byte 一致)', () => {
    const body = { data: { form: { fields_list: [] } } };
    const r = buildPullResult(body, (s) => s);
    expect(r.ok).toBe(true);
    expect(r.ok && 'formType' in r).toBe(false);
  });
});

describe('T-C2 — push は form_type を baseline 差分時のみ PATCH', () => {
  test('formType が prevFormType から変化 → PATCH {form_type}', async () => {
    const { client, calls } = mock();
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'S', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'FS1' },
      formType: 'multi_step', prevFormType: 'simple',
    });
    expect(r.ok).toBe(true);
    const ft = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/S/' && (c.body as any).form_type !== undefined);
    expect(ft).toBeDefined();
    expect((ft!.body as any).form_type).toBe('multi_step');
  });

  test('formType が未変化 (prev と同一) → form_type PATCH を送らない (勝手に変えない)', async () => {
    const { client, calls } = mock();
    await pushDefinitionToFormaloo(client, {
      formalooSlug: 'S', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'FS1' },
      formType: 'simple', prevFormType: 'simple',
    });
    expect(calls.some((c) => (c.body as any)?.form_type !== undefined)).toBe(false);
  });

  test('formType 未渡し (design だけの save 等) → form_type PATCH を送らない (後方互換)', async () => {
    const { client, calls } = mock();
    await pushDefinitionToFormaloo(client, {
      formalooSlug: 'S', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'FS1' },
    });
    expect(calls.some((c) => (c.body as any)?.form_type !== undefined)).toBe(false);
  });

  test('formType 指定 + prevFormType 未指定 (新規に multi_step) → PATCH 送る', async () => {
    const { client, calls } = mock();
    await pushDefinitionToFormaloo(client, {
      formalooSlug: 'S', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'FS1' },
      formType: 'multi_step',
    });
    expect(calls.some((c) => (c.body as any)?.form_type === 'multi_step')).toBe(true);
  });
});
