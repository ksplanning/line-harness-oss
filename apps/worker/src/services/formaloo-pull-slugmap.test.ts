/**
 * T-B3 (part 1) — pull が fieldSlugById (harness id → Formaloo slug) を additive で返す。
 *   drift auto-apply が field_map の formaloo_field_slug を carry するための素材。route は無視 (後方互換)。
 *   buildPullResult (GET 済 body の純粋変換) を drift-check が同一 body から再利用する経路も併せて検証。
 */
import { describe, it, expect, vi } from 'vitest';
import { pullDefinitionFromFormaloo, buildPullResult } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

function mockClient(body: unknown): FormalooClient {
  return { get: vi.fn(async () => ({ ok: true, status: 200, data: body })) } as unknown as FormalooClient;
}
function detail(fieldsList: unknown[], logic?: unknown): unknown {
  return { data: { form: { slug: 'form_slug', fields_list: fieldsList, logic: logic ?? { rules: [] } } } };
}

const nameField = { slug: 's_name', type: 'short_text', title: '氏名', required: false, position: 0 };
const ageField = { slug: 's_age', type: 'number', title: '年齢', required: false, position: 1 };

describe('pullDefinitionFromFormaloo — fieldSlugById (T-B3)', () => {
  it('resolveId で harness id へ解決された field の id→slug を返す', async () => {
    const resolve = (s: string) => (s === 's_name' ? 'h_name' : s === 's_age' ? 'h_age' : undefined);
    const r = await pullDefinitionFromFormaloo(mockClient(detail([nameField, ageField])), { formalooSlug: 'form_slug', resolveId: resolve });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fieldSlugById).toEqual({ h_name: 's_name', h_age: 's_age' });
  });

  it('未知 slug (resolve undefined) は slug 自身が id → id===slug で map される (新規 field の carry)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail([nameField])), { formalooSlug: 'form_slug', resolveId: () => undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields[0].id).toBe('s_name'); // slug fallback
    expect(r.fieldSlugById).toEqual({ s_name: 's_name' });
  });

  it('subset 外 field (matrix) は fieldSlugById に載らない (harness に反映されないため)', async () => {
    const r = await pullDefinitionFromFormaloo(
      mockClient(detail([nameField, { slug: 's_matrix', type: 'matrix', title: '表', position: 2 }])),
      { formalooSlug: 'form_slug', resolveId: (s) => s },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fieldSlugById).toEqual({ s_name: 's_name' });
    expect(Object.keys(r.fieldSlugById ?? {})).not.toContain('s_matrix');
  });
});

describe('buildPullResult — GET 済 body の純粋変換 (drift-check 再利用経路)', () => {
  it('pullDefinitionFromFormaloo と同一の結果 (同一 body・二重 GET 回避の等価性)', async () => {
    const body = detail([nameField, ageField]);
    const viaGet = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    const direct = buildPullResult(body, (s) => s);
    expect(direct).toEqual(viaGet);
  });

  it('read-shape 不一致は {ok:false} (W1)', () => {
    const r = buildPullResult({ data: { form: { title: 'x' } } }, (s) => s);
    expect(r.ok).toBe(false);
  });

  it('meta section/page_break を pull と drift auto-apply 共通変換の両方で消さず復元する (T-B4)', async () => {
    const body = detail([
      {
        slug: 'meta_section', type: 'meta', sub_type: 'section', title: 'ご案内', description: '本文です',
        required: false, admin_only: false, position: 2,
      },
      {
        slug: 'meta_page', type: 'meta', sub_type: 'page_break', title: '改ページ', description: null,
        required: false, admin_only: false, position: 3,
      },
    ]);
    const expected = [
      { id: 'h_section', type: 'section', label: 'ご案内', required: false, position: 2, config: { text: '本文です' } },
      { id: 'h_page', type: 'page_break', label: '改ページ', required: false, position: 3, config: {} },
    ];
    const resolve = (slug: string) => ({ meta_section: 'h_section', meta_page: 'h_page' })[slug];

    const manualReimport = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: resolve });
    const driftAutoApply = buildPullResult(body, resolve);

    expect(manualReimport.ok).toBe(true);
    expect(driftAutoApply.ok).toBe(true);
    if (!manualReimport.ok || !driftAutoApply.ok) return;
    expect(manualReimport.fields).toEqual(expected);
    expect(driftAutoApply.fields).toEqual(expected);
    expect(driftAutoApply.fieldSlugById).toEqual({ h_section: 'meta_section', h_page: 'meta_page' });
  });
});
