/**
 * form-post-edit (弾M / T-B1) — 純関数: flat slug-keyed PATCH body 生成 / row_slug 3 経路解決 / required 検証。
 *   soft-200 回避の要 = **flat top-level field-slug map** (`{data:{}}` で包まない・slug-keyed・free-value 限定)。
 */
import { describe, expect, test, vi } from 'vitest';
import {
  buildFlatRowPatchBody,
  isEditableFieldType,
  findEmptyRequired,
  resolveRowSlug,
  makeRowsListRowSlugResolver,
  FREE_VALUE_FIELD_TYPES,
  type EditFieldMeta,
} from './formaloo-row-edit.js';

const fields: EditFieldMeta[] = [
  { id: 'q_name', slug: 'aynYrQa7', fieldType: 'text', required: true },
  { id: 'q_note', slug: 'rUuBus3q', fieldType: 'textarea', required: false },
  { id: 'q_age', slug: 'ageSlug1', fieldType: 'number', required: false },
  { id: 'q_pick', slug: 'pickSlug', fieldType: 'choice', required: false },
  { id: 'q_file', slug: 'fileSlug', fieldType: 'file', required: false },
];

describe('T-B1 buildFlatRowPatchBody — flat top-level slug-keyed / free-value 限定', () => {
  test('slug-keyed answers を flat top-level map で返す (data ラッパで包まない)', () => {
    const body = buildFlatRowPatchBody({ aynYrQa7: '田中→山田', rUuBus3q: 'メモ' }, fields);
    expect(body).toEqual({ aynYrQa7: '田中→山田', rUuBus3q: 'メモ' });
    // soft-200 回避: data ラッパ厳禁
    expect('data' in body).toBe(false);
  });

  test('harness field id キーは slug に変換する (S-1 結論: id/label→slug fallback)', () => {
    const body = buildFlatRowPatchBody({ q_name: '花子', q_age: '30' }, fields);
    expect(body).toEqual({ aynYrQa7: '花子', ageSlug1: '30' });
  });

  test('choice/dropdown/multiple_select/file は body に含めない (label 送信の silent 無視を防ぐ)', () => {
    const body = buildFlatRowPatchBody({ aynYrQa7: 'ok', pickSlug: 'choiceLabel', fileSlug: 'x.pdf' }, fields);
    expect(body).toEqual({ aynYrQa7: 'ok' });
    expect('pickSlug' in body).toBe(false);
    expect('fileSlug' in body).toBe(false);
  });

  test('未知 field-slug は除外する', () => {
    const body = buildFlatRowPatchBody({ aynYrQa7: 'ok', nonexistent: 'zz' }, fields);
    expect(body).toEqual({ aynYrQa7: 'ok' });
  });

  test('free-value 型集合は text/textarea/number/email/phone/date のみ', () => {
    expect([...FREE_VALUE_FIELD_TYPES].sort()).toEqual(['date', 'email', 'number', 'phone', 'text', 'textarea']);
    expect(isEditableFieldType('text')).toBe(true);
    expect(isEditableFieldType('choice')).toBe(false);
    expect(isEditableFieldType('file')).toBe(false);
  });
});

describe('T-B1 findEmptyRequired — 必須空値の拒否', () => {
  test('必須 slug が空文字なら missing に含む', () => {
    const missing = findEmptyRequired({ aynYrQa7: '' }, new Set(['aynYrQa7']));
    expect(missing).toEqual(['aynYrQa7']);
  });
  test('必須 slug に値があれば missing 空', () => {
    expect(findEmptyRequired({ aynYrQa7: '山田' }, new Set(['aynYrQa7']))).toEqual([]);
  });
  test('body に無い必須 slug は対象外 (部分更新 = 触らない項目は既存保持)', () => {
    expect(findEmptyRequired({ rUuBus3q: 'メモ' }, new Set(['aynYrQa7']))).toEqual([]);
  });
  test('空白のみ / null / 空配列も空扱い', () => {
    expect(findEmptyRequired({ a: '   ', b: null, c: [] }, new Set(['a', 'b', 'c'])).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('T-B1 resolveRowSlug — 3 経路', () => {
  test('(a) stored formaloo_row_slug present → 即返す (fetcher 呼ばない)', async () => {
    const fetcher = vi.fn(async () => 'SHOULD_NOT_CALL');
    const slug = await resolveRowSlug({ id: 'sub1', formaloo_row_slug: 'STORED_SLUG' }, fetcher);
    expect(slug).toBe('STORED_SLUG');
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('(b) NULL → rows-list resolver (submit_code=id) で解決', async () => {
    const fetcher = vi.fn(async (submitCode: string) => (submitCode === 'sub2' ? 'RESOLVED_SLUG' : null));
    const slug = await resolveRowSlug({ id: 'sub2', formaloo_row_slug: null }, fetcher);
    expect(slug).toBe('RESOLVED_SLUG');
    expect(fetcher).toHaveBeenCalledWith('sub2');
  });
  test('(c) 照合不能 → null', async () => {
    const fetcher = vi.fn(async () => null);
    expect(await resolveRowSlug({ id: 'sub3', formaloo_row_slug: null }, fetcher)).toBeNull();
  });
});

describe('T-B1 makeRowsListRowSlugResolver — rows-list submit_code 照合 (bounded)', () => {
  function clientReturning(pages: Record<number, unknown>) {
    return {
      get: vi.fn(async (path: string) => {
        const m = path.match(/[?&]page=(\d+)/);
        const page = m ? Number(m[1]) : 1;
        const data = pages[page];
        if (data === undefined) return { ok: true, status: 200, data: { data: { rows: [] } } } as const;
        return { ok: true, status: 200, data } as const;
      }),
    };
  }

  test('submit_code 一致 row の slug を返す (data.data.rows 形)', async () => {
    const client = clientReturning({
      1: { data: { rows: [{ slug: 'ROWX', submit_code: 'wantcode' }, { slug: 'ROWY', submit_code: 'other' }] } },
    });
    const resolver = makeRowsListRowSlugResolver(client, 'form_abc');
    expect(await resolver('wantcode')).toBe('ROWX');
  });

  test('複数ページを bounded に走査 (maxPages 上限) して見つけたら止まる', async () => {
    const client = clientReturning({
      1: { data: { rows: [{ slug: 'A', submit_code: 'p1' }] } },
      2: { data: { rows: [{ slug: 'B', submit_code: 'target' }] } },
    });
    const resolver = makeRowsListRowSlugResolver(client, 'form_abc', { maxPages: 3, pageSize: 1 });
    expect(await resolver('target')).toBe('B');
  });

  test('maxPages を超えたら null (無限走査しない)', async () => {
    const client = clientReturning({
      1: { data: { rows: [{ slug: 'A', submit_code: 'p1' }] } },
      2: { data: { rows: [{ slug: 'B', submit_code: 'p2' }] } },
      3: { data: { rows: [{ slug: 'C', submit_code: 'deep' }] } },
    });
    const resolver = makeRowsListRowSlugResolver(client, 'form_abc', { maxPages: 2, pageSize: 1 });
    expect(await resolver('deep')).toBeNull();
  });

  test('非 2xx / 空 rows は null (fail-safe)', async () => {
    const client = { get: vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }) as const) };
    const resolver = makeRowsListRowSlugResolver(client, 'form_abc');
    expect(await resolver('any')).toBeNull();
  });
});
