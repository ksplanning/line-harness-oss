import { describe, expect, test } from 'vitest';
import { buildPullResult } from './formaloo-pull';

const LIVE_GET_FIELDS = [
  { slug: 'remote-yes-no', type: 'yes_no', title: '確認', description: 'はい・いいえで答えます', required: true, position: 0, config: {}, invisible: false, admin_only: false, read_only: false },
  { slug: 'remote-time', type: 'time', title: '時刻', required: false, position: 1, config: {}, invisible: false, admin_only: false, read_only: false },
  { slug: 'remote-website', type: 'website', title: 'URL', required: false, position: 2, config: {}, invisible: false, admin_only: false, read_only: false },
  { slug: 'remote-city', type: 'city', title: '市区町村', required: true, position: 3, config: {}, invisible: false, admin_only: false, read_only: false },
];

describe('treasure E1 field parts — pull read-back', () => {
  test('scratch GETで実測した4型とserver defaultsをdropせず正しいHarness型へ戻す', () => {
    const idBySlug = new Map(LIVE_GET_FIELDS.map((field) => [field.slug, `h-${field.type}`]));
    const result = buildPullResult(
      { data: { form: { fields_list: LIVE_GET_FIELDS, logic: [] } } },
      (slug) => idBySlug.get(slug),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.map(({ id, type, label, required, position, config }) => ({ id, type, label, required, position, config }))).toEqual([
      { id: 'h-yes_no', type: 'yes_no', label: '確認', required: true, position: 0, config: { description: 'はい・いいえで答えます' } },
      { id: 'h-time', type: 'time', label: '時刻', required: false, position: 1, config: {} },
      { id: 'h-website', type: 'website', label: 'URL', required: false, position: 2, config: {} },
      { id: 'h-city', type: 'city', label: '市区町村', required: true, position: 3, config: {} },
    ]);
    expect(result.fieldSlugById).toEqual({
      'h-yes_no': 'remote-yes-no',
      'h-time': 'remote-time',
      'h-website': 'remote-website',
      'h-city': 'remote-city',
    });
  });

  test('soft-200で誤enumが残ったread-backは対応型として取り込まない', () => {
    const result = buildPullResult(
      { data: { form: { fields_list: [{ ...LIVE_GET_FIELDS[0], type: 'yesno' }], logic: [] } } },
      (slug) => slug,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual([]);
    expect(result.fieldSlugById).toEqual({});
  });
});
