/**
 * formaloo-logic-fidelity Batch 1 — pull preserve additive (D-6)。
 *   - PullResult に rawLogic (bare array 逐語) + logicFingerprint が載る
 *   - warnings が「表示簡略化・データ保持」意味へ是正 (旧「簡略化されました=消失」から)
 *   - 表示射影 (r.logic) は Batch 1 では表示不変 (実 bare array は忠実射影しない = Batch 2)
 * 既存 formaloo-pull.test.ts は無改変 (別ファイルで additive 検証)。
 */
import { describe, it, expect, vi } from 'vitest';
import { pullDefinitionFromFormaloo, extractRawLogic } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

function mockClient(body: unknown): FormalooClient {
  return { get: vi.fn(async () => ({ ok: true, status: 200, data: body })) } as unknown as FormalooClient;
}
function detail(fieldsList: unknown[], logic?: unknown): unknown {
  return { data: { form: { slug: 'form_slug', fields_list: fieldsList, logic } } };
}

const fields = [
  { slug: 's_a', type: 'short_text', title: 'A', required: false, position: 0 },
  { slug: 's_b', type: 'short_text', title: 'B', required: false, position: 1 },
];

// R0 実 shape: bare array of `{type, identifier, actions:[{action,args,when}]}` (AND-compound 1 件)。
const compoundItem = {
  type: 'field',
  identifier: 's_a',
  actions: [
    {
      action: 'show',
      args: [{ type: 'field', identifier: 's_b' }],
      when: {
        operation: 'and',
        args: [
          { operation: 'is', args: [{ type: 'field', value: 's_a' }, { type: 'choice', value: 'x' }] },
          { operation: 'is', args: [{ type: 'field', value: 's_b' }, { type: 'choice', value: 'y' }] },
        ],
      },
    },
  ],
};
const rawArray = [compoundItem];

describe('extractRawLogic — bare array 逐語抽出', () => {
  it('.data.form.logic の bare array を返す / object({rules}) や欠落は null', () => {
    expect(extractRawLogic(detail([], rawArray))).toEqual(rawArray);
    expect(extractRawLogic(detail([], { rules: [] }))).toBeNull(); // legacy synthetic object は null
    expect(extractRawLogic(detail([], null))).toBeNull(); // never-touched form
    expect(extractRawLogic({ data: { form: {} } })).toBeNull();
  });
});

describe('pullDefinitionFromFormaloo — preserve additive (D-6)', () => {
  it('rawLogic を bare array 逐語で返し、logicFingerprint (string) を付ける', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail(fields, rawArray)), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawLogic).toEqual(rawArray); // 逐語保持 (欠けゼロ)
    expect(typeof r.logicFingerprint).toBe('string');
  });

  it('warnings は「表示簡略化・データ保持」へ是正 (複合ロジックルール anchor 維持 + 保持されます)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail(fields, rawArray)), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    expect(r.warnings![0]).toContain('複合ロジックルール'); // 既存 note マージ構造の anchor 不変
    expect(r.warnings![0]).toContain('保持されます'); // 是正: 消失でなく保持
    expect(r.warnings![0]).not.toContain('簡略化されました'); // 旧「消失」文言は使わない
  });

  it('Batch 1 は表示不変: 実 bare array の忠実表示射影はしない (r.logic は空)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail(fields, rawArray)), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logic).toEqual([]); // Batch 2 で実 item 木から忠実射影 (Batch 1 は preserve のみ)
  });

  it('null logic (never-touched) は rawLogic 未載 + warnings 無し + fingerprint は空配列 hash', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail(fields, null)), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawLogic).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect(r.logicFingerprint).toBe('[]');
  });

  it('legacy synthetic {rules} 経路でも warnings 是正文言 (後方互換 / 既存 detail 形)', async () => {
    const synthetic = { rules: [{ conditions: [{ field: 's_a', operator: 'equals', value: '1' }, { field: 's_b', operator: 'equals', value: '2' }], actions: [{ type: 'show', field: 's_b' }] }] };
    const r = await pullDefinitionFromFormaloo(mockClient(detail(fields, synthetic)), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings![0]).toContain('保持されます');
    expect(r.rawLogic).toBeUndefined(); // object({rules}) は bare array でない → preserve 対象外
  });
});
