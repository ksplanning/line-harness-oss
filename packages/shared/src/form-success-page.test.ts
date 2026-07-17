/**
 * route-terminal-phase2 (T-E1) — SuccessPageSpec 契約 + normalizeSuccessPages。
 *  - ルート別完了ページ (Phase 2/OD-2) の canonical 型。additive-optional (未設定は definition_json 非搭載)。
 *  - description は plain text 化 (CX-8: HTML markup/制御文字を harness 側で除去 = vendor sanitize 非依存で
 *    将来 renderer 変更に耐える XSS 面クローズ)。id/title 必須 (欠落は drop)。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeSuccessPages,
  sanitizeSuccessPageDescription,
  type SuccessPageSpec,
} from './form-success-page';

describe('sanitizeSuccessPageDescription — plain text 化 (CX-8)', () => {
  it('HTML タグを除去する', () => {
    expect(sanitizeSuccessPageDescription('<a href="x">GO</a>')).toBe('GO');
    expect(sanitizeSuccessPageDescription('<script>alert(1)</script>安全')).toBe('alert(1)安全');
    expect(sanitizeSuccessPageDescription('<meta http-equiv="refresh">飛ぶ')).toBe('飛ぶ');
  });

  it('制御文字を除去し改行は保持する', () => {
    expect(sanitizeSuccessPageDescription('a\x00b\x07c')).toBe('abc');
    expect(sanitizeSuccessPageDescription('1行目\n2行目')).toBe('1行目\n2行目');
  });

  it('通常テキストは変えない', () => {
    expect(sanitizeSuccessPageDescription('ご回答ありがとうございました。')).toBe('ご回答ありがとうございました。');
  });
});

describe('normalizeSuccessPages — whitelist / 必須 / plain text', () => {
  it('id+title を持つ SP を保持し description を plain text 化する', () => {
    const out = normalizeSuccessPages([
      { id: 'sp1', title: 'Aルート完了', description: '<b>ありがとう</b>', slug: 'abc123' },
    ]);
    expect(out).toEqual([{ id: 'sp1', title: 'Aルート完了', description: 'ありがとう', slug: 'abc123' }]);
  });

  it('未知キーを drop する (whitelist)', () => {
    const out = normalizeSuccessPages([{ id: 'sp1', title: 'T', evil: 'x', __proto__: 'y' } as Record<string, unknown>]);
    expect(out).toEqual([{ id: 'sp1', title: 'T' }]);
    expect('evil' in out[0]).toBe(false);
  });

  it('id 欠落 / title 欠落の SP は drop する', () => {
    expect(normalizeSuccessPages([{ title: 'T' }, { id: 'sp2' }, { id: '', title: 'T' }, { id: 'sp3', title: '' }])).toEqual([]);
  });

  it('slug は非空 string のときだけ保持 (未作成 SP は slug なし)', () => {
    expect(normalizeSuccessPages([{ id: 'sp1', title: 'T' }])).toEqual([{ id: 'sp1', title: 'T' }]);
    expect(normalizeSuccessPages([{ id: 'sp1', title: 'T', slug: '' }])).toEqual([{ id: 'sp1', title: 'T' }]);
    expect(normalizeSuccessPages([{ id: 'sp1', title: 'T', slug: 42 } as unknown as SuccessPageSpec])).toEqual([{ id: 'sp1', title: 'T' }]);
  });

  it('description が空/非 string なら key を持たない', () => {
    expect(normalizeSuccessPages([{ id: 'sp1', title: 'T', description: '' }])).toEqual([{ id: 'sp1', title: 'T' }]);
    expect(normalizeSuccessPages([{ id: 'sp1', title: 'T', description: 123 } as unknown as SuccessPageSpec])).toEqual([{ id: 'sp1', title: 'T' }]);
  });

  it('title を trim する', () => {
    expect(normalizeSuccessPages([{ id: 'sp1', title: '  完了  ' }])).toEqual([{ id: 'sp1', title: '完了' }]);
  });

  it('非 array 入力は [] を返す', () => {
    expect(normalizeSuccessPages(null)).toEqual([]);
    expect(normalizeSuccessPages(undefined)).toEqual([]);
    expect(normalizeSuccessPages({} as unknown)).toEqual([]);
    expect(normalizeSuccessPages('x' as unknown)).toEqual([]);
  });

  it('複数 SP の順序を保持する', () => {
    const out = normalizeSuccessPages([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
