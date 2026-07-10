/**
 * T-B2 (F-2) — push-sync 配線: harness 定義 → Formaloo API payload マッピングを client 経由で送る。
 *   - field は toFormalooFieldPayload (short_text/max_length 等) で送る
 *   - logic は Formaloo field slug ベースに解決して送る
 *   - fail-soft: どこかで失敗したら {ok:false} を返す (throw しない / N-6)
 * (実 Formaloo への push→pull 一致 = N-8 は browser-evaluator/live で E2E 確認。ここは wiring を固定。)
 */
import { describe, test, expect } from 'vitest';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { FormalooResult } from './formaloo-client';
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

function mockClient(script: {
  post?: Array<() => FormalooResult>;
  put?: Array<() => FormalooResult>;
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'POST', path, body });
      const next = script.post?.shift();
      return (next ? next() : { ok: true, status: 200, data: {} }) as FormalooResult<T>;
    },
    async put<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'PUT', path, body });
      const next = script.put?.shift();
      return (next ? next() : { ok: true, status: 200, data: {} }) as FormalooResult<T>;
    },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const fields: HarnessField[] = [
  { id: 'h1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 30 } },
  { id: 'h2', type: 'choice', label: '性別', required: true, position: 1, config: { choices: ['男', '女'] } },
];
const logic: HarnessLogicRule[] = [
  { id: 'r1', sourceFieldId: 'h2', operator: 'equals', value: '男', action: 'show', targetFieldId: 'h1' },
];

describe('pushDefinitionToFormaloo — 新規 form', () => {
  test('form 作成 → field を mapped payload で push → logic を slug ベースで push', async () => {
    const { client, calls } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { form: { slug: 'FORMSLUG', full_form_address: 'https://forms.formaloo.net/FORMSLUG' } } } }),
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS1' } } } }),
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS2' } } } }),
      ],
      put: [() => ({ ok: true, status: 200, data: {} })],
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 'テスト', fields, logic });
    expect(r.ok).toBe(true);
    expect(r.formalooSlug).toBe('FORMSLUG');
    expect(r.fieldSlugs).toEqual({ h1: 'FS1', h2: 'FS2' });
    expect(r.publicAddress).toBe('https://forms.formaloo.net/FORMSLUG');

    // form 作成呼び出し
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v3.0/forms/', body: { title: 'テスト' } });
    // field 作成は top-level /v3.0/fields/ へ POST し、form slug は URL でなく body で紐づく。
    // 旧実装 /v3.0/forms/{slug}/fields/ は本番 Formaloo API に存在せず HTTP 404 だった (本番 404 回帰ガード)。
    expect(calls[1].path).toBe('/v3.0/fields/');
    expect(calls[1].body).toMatchObject({ form: 'FORMSLUG', type: 'short_text', title: '名前', max_length: 30, required: true });
    expect(calls[2].path).toBe('/v3.0/fields/');
    // choice の選択肢は Formaloo writeOnly `choice_items` ([{title}]) で送る (live 実証 2026-07-10)。
    // 旧 `choices: string[]` は実 API に無視され選択肢が落ちていた (silent data loss / latent defect 回帰ガード)。
    expect(calls[2].body).toMatchObject({ form: 'FORMSLUG', type: 'choice', title: '性別', choice_items: [{ title: '男' }, { title: '女' }] });
    expect((calls[2].body as Record<string, unknown>).choices).toBeUndefined();
    // logic は Formaloo slug ベース (harness id でなく FS1/FS2)
    const putCall = calls.find((c) => c.method === 'PUT')!;
    const body = putCall.body as { logic: { rules: Array<{ conditions: Array<{ field: string }>; actions: Array<{ field: string }> }> } };
    expect(body.logic.rules[0].conditions[0].field).toBe('FS2');
    expect(body.logic.rules[0].actions[0].field).toBe('FS1');
  });
});

describe('pushDefinitionToFormaloo — fail-soft (N-6)', () => {
  test('form 作成失敗 → {ok:false}', async () => {
    const { client } = mockClient({ post: [() => ({ ok: false, status: 500, error: 'boom' })] });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields, logic });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('form create failed');
  });
  test('field push 失敗 → {ok:false, formalooSlug 付き} (部分失敗 = out_of_sync 判定材料 / N-13)', async () => {
    const { client } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { form: { slug: 'S' } } } }),
        () => ({ ok: false, status: 400, error: 'bad field' }),
      ],
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields, logic });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('S');
    expect(r.error).toContain('field push failed');
  });
  test('既存 slug なら form 作成をスキップして field から', async () => {
    const { client, calls } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS1' } } } }),
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS2' } } } }),
      ],
      put: [() => ({ ok: true, status: 200, data: {} })],
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'EXISTING', title: 't', fields, logic });
    expect(r.ok).toBe(true);
    expect(r.formalooSlug).toBe('EXISTING');
    expect(calls[0].path).toBe('/v3.0/fields/'); // form 作成なし・field は top-level endpoint へ
    expect(calls[0].body).toMatchObject({ form: 'EXISTING', type: 'short_text' }); // 既存 slug を body で紐づけ
  });
});
