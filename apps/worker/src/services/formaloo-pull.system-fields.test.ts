import { describe, expect, test } from 'vitest';
import { buildPullResult } from './formaloo-pull.js';

// =============================================================================
// fr-id-capture-fix / T-C4: pull が予約 friend system field (alias fr_id/fr_name) を harness 定義へ
//   取り込まない (逆流防止)。type=hidden は fromFormalooField が既に drop するが、alias キー除外を
//   独立に検証するため subset 型 (short_text) + 予約 alias でも混入しないことを assert する。
// =============================================================================
const resolveId = (slug: string) => slug;

function body(fieldsList: unknown[]) {
  return { data: { form: { fields_list: fieldsList } } };
}

describe('buildPullResult system-field exclusion (T-C4)', () => {
  test('subset 型(short_text)でも alias=fr_id/fr_name は harness fields に混入しない', () => {
    const res = buildPullResult(
      body([
        { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
        { slug: 'h1', type: 'short_text', title: 'sys id', alias: 'fr_id', position: 1 },
        { slug: 'h2', type: 'short_text', title: 'sys name', alias: 'fr_name', position: 2 },
      ]),
      resolveId,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 通常 field s1 のみ・system alias 2 件は除外
    expect(res.fields.map((f) => f.id)).toEqual(['s1']);
    expect(res.fields.some((f) => f.id === 'h1' || f.id === 'h2')).toBe(false);
    // fieldSlugById にも system field slug は載らない
    expect(res.fieldSlugById.h1).toBeUndefined();
    expect(res.fieldSlugById.h2).toBeUndefined();
  });

  test('type=hidden の予約 field も除外 (type filter と alias filter の二重防御)', () => {
    const res = buildPullResult(
      body([
        { slug: 's1', type: 'short_text', title: '名前', position: 0, required: false },
        { slug: 'h1', type: 'hidden', title: 'sys id', alias: 'fr_id', position: 1 },
      ]),
      resolveId,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.id)).toEqual(['s1']);
  });

  test('system field 無しのフォームは従来どおり全 subset field を取り込む (byte 不変 / 後方互換)', () => {
    const res = buildPullResult(
      body([
        { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
        { slug: 's2', type: 'email', title: 'メール', position: 1, required: false },
      ]),
      resolveId,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.id)).toEqual(['s1', 's2']);
  });
});
