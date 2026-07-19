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
  mapFormalooListRowToUpsert,
  pullFriendReconcileInputs,
  friendLinkSecret,
  FREE_VALUE_FIELD_TYPES,
  type EditFieldMeta,
} from './formaloo-row-edit.js';
import { signFriendToken } from './formaloo-friend-token.js';

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

// =============================================================================
// line-reentry-prefill-fix (Layer A / C1) — reconcile 写像が署名 fr_id を verify して friend_id を
//   fail-closed 復元する。webhook 未配線でも本人 row が friend_id を持ち getFriendLatestSubmission が引ける。
//   最重要 = 他人の回答を prefill しない (verify 成功時のみ復元 / 弾M F-H1 継承)。
// =============================================================================

const FR_SECRET = 'reconcile_frtok_secret_v1'; // gitleaks:allow (test fixture HMAC key・実 secret でない)
const FORM_H = { id: 'form_h', formaloo_slug: 'GMOxoMtK' };

describe('T-A2/T-A3 mapFormalooListRowToUpsert — 署名 fr_id を verify して friend_id を fail-closed 復元', () => {
  test('T-A2: rendered_data 配列形 [{slug,alias,value}] の valid fr_id → friend_id 復元', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = { slug: 'ROW1', created_at: '2026-07-18T00:00:00+09:00', data: { q1: 'v' }, rendered_data: [{ slug: 'x1', alias: 'fr_id', value: token }] };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBe('frA');
  });

  test('T-A2: rendered_data object 形 {fr_id: token} の valid fr_id → 復元', async () => {
    const token = await signFriendToken('frB', FR_SECRET);
    const row = { slug: 'ROW2', data: { q1: 'v' }, rendered_data: { fr_id: token } };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBe('frB');
  });

  test('T-A2: rendered_data 無しでも data[fr_id] (field slug=fr_id) の valid fr_id → 復元', async () => {
    const token = await signFriendToken('frC', FR_SECRET);
    const row = { slug: 'ROW3', data: { fr_id: token, q1: 'v' } };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBe('frC');
  });

  test('T-A1/D-1: fr_id 無し行 → friend_id=null (byte 不変・後方互換)', async () => {
    const row = { slug: 'ROW4', data: { q1: 'v' } };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBeNull();
  });

  test('T-A3: secret 未供給 (opts 無し / undefined) → friend_id=null (fail-closed / verify 不能)', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = { slug: 'ROW5', data: {}, rendered_data: [{ alias: 'fr_id', value: token }] };
    expect((await mapFormalooListRowToUpsert(row, FORM_H))?.friendId).toBeNull();
    expect((await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: undefined }))?.friendId).toBeNull();
    expect((await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: '' }))?.friendId).toBeNull();
  });

  test('T-A3: 改ざん token → friend_id=null (他人紐付け=PII を絶対起こさない)', async () => {
    const token = (await signFriendToken('frA', FR_SECRET))!;
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    const row = { slug: 'ROW6', data: {}, rendered_data: [{ alias: 'fr_id', value: tampered }] };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBeNull();
  });

  test('T-A3: 別 secret で署名された token → friend_id=null', async () => {
    const token = await signFriendToken('frA', 'OTHER_secret_zzz');
    const row = { slug: 'ROW7', data: {}, rendered_data: [{ alias: 'fr_id', value: token }] };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBeNull();
  });

  test('D-3/CI-5: verify 失敗行の friendId は null (upsert COALESCE で既存 friend_id を NULL 上書きしない契約の入力側)', async () => {
    const row = { slug: 'ROW8', data: { q1: 'v' } };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input?.friendId).toBeNull();
  });

  test('slug 欠落 row → null (addressable でない)', async () => {
    expect(await mapFormalooListRowToUpsert({ data: {} }, FORM_H, { friendTokenSecret: FR_SECRET })).toBeNull();
  });

  test('answers/id/rowSlug/submittedAt は byte 不変 (friend_id 追加のみ additive)', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = { slug: 'ROWX', created_at: '2026-07-18T01:00:00+09:00', data: { q1: 'a', q2: 'b' }, rendered_data: [{ alias: 'fr_id', value: token }] };
    const input = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(input).toMatchObject({
      id: 'ROWX', formId: 'form_h', formalooSlug: 'GMOxoMtK',
      answersJson: JSON.stringify({ q1: 'a', q2: 'b' }), submittedAt: '2026-07-18T01:00:00+09:00',
      rowSlug: 'ROWX', friendId: 'frA', verified: false,
    });
  });
});

describe('T-A6 pullFriendReconcileInputs — bounded targeted pull → friend_id 復元 inputs', () => {
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

  test('直近 rows を pull し valid fr_id 行の friend_id を復元した inputs を返す', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const client = clientReturning({ 1: { data: { rows: [{ slug: 'R1', data: { q: 'v' }, rendered_data: [{ alias: 'fr_id', value: token }] }] } } });
    const inputs = await pullFriendReconcileInputs(client, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].friendId).toBe('frA');
    expect(inputs[0].id).toBe('R1');
  });

  test('targeted pull も form mapping を verified metadata intent へ載せる', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const client = clientReturning({
      1: { data: { rows: [{ slug: 'R_PAY', created_at: '2026-07-19T12:00:00Z', data: { BjEp0J2J: '済' }, rendered_data: [{ alias: 'fr_id', value: token }] }] } },
    });
    const inputs = await pullFriendReconcileInputs(client, {
      ...FORM_H,
      friend_metadata_mappings_json: JSON.stringify([{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }]),
    }, { friendTokenSecret: FR_SECRET });
    expect(inputs[0].verifiedFriendMetadataSync).toEqual({
      friendId: 'frA',
      updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '済' }],
    });
  });

  test('非2xx はループ終了 (fail-safe・空配列)', async () => {
    const client = { get: vi.fn(async () => ({ ok: false, status: 500, error: 'x' }) as const) };
    expect(await pullFriendReconcileInputs(client, FORM_H, { friendTokenSecret: FR_SECRET })).toEqual([]);
  });

  test('formaloo_slug null → 空配列 (pull を一切呼ばない)', async () => {
    const client = { get: vi.fn(async () => ({ ok: true, status: 200, data: {} }) as const) };
    expect(await pullFriendReconcileInputs(client, { id: 'f', formaloo_slug: null }, { friendTokenSecret: FR_SECRET })).toEqual([]);
    expect(client.get).not.toHaveBeenCalled();
  });

  test('secret 未供給 → 行は返すが friendId=null (fail-closed)', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const client = clientReturning({ 1: { data: { rows: [{ slug: 'R1', data: {}, rendered_data: [{ alias: 'fr_id', value: token }] }] } } });
    const inputs = await pullFriendReconcileInputs(client, FORM_H);
    expect(inputs[0].friendId).toBeNull();
  });

  test('maxPages を bounded に (hot path 保護 / CI-4): 既定 2 ページで停止', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const client = clientReturning({
      1: { data: { rows: [{ slug: 'R1', data: {}, rendered_data: [{ alias: 'fr_id', value: token }] }] } },
      2: { data: { rows: [{ slug: 'R2', data: {} }] } },
      3: { data: { rows: [{ slug: 'R3', data: {} }] } },
    });
    const inputs = await pullFriendReconcileInputs(client, FORM_H, { friendTokenSecret: FR_SECRET });
    expect(inputs.map((i) => i.id)).toEqual(['R1', 'R2']); // page 3 は走査しない
  });
});

describe('D-6 friendLinkSecret — friend_id 復元 kill-switch (additive rollback)', () => {
  test('flag 未設定 → secret を返す (復元 ON = 既定)', () => {
    expect(friendLinkSecret({ FORMALOO_FRIEND_TOKEN_SECRET: 'sek' })).toBe('sek');
  });
  test("flag='true' → null (friend_id 復元だけ停止・reconcile 充填は継続)", () => {
    expect(friendLinkSecret({ FORMALOO_FRIEND_TOKEN_SECRET: 'sek', FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: 'true' })).toBeNull();
  });
  test("flag='false'/其他 → secret を返す (既定 ON)", () => {
    expect(friendLinkSecret({ FORMALOO_FRIEND_TOKEN_SECRET: 'sek', FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: 'false' })).toBe('sek');
    expect(friendLinkSecret({ FORMALOO_FRIEND_TOKEN_SECRET: 'sek', FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: '1' })).toBe('sek');
  });
  test('secret 未設定 → null (fail-closed)', () => {
    expect(friendLinkSecret({})).toBeNull();
    expect(friendLinkSecret({ FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: 'true' })).toBeNull();
  });
});

describe('row-status-friend-sync — verified row metadata intent', () => {
  const mappedForm = {
    ...FORM_H,
    friend_metadata_mappings_json: JSON.stringify([
      { formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' },
      { formalooFieldKey: 'payment_alias', friendMetadataKey: '入金メモ' },
    ]),
  };

  test('署名 fr_id 検証成功時だけ slug/alias の row 値を sync intent にする', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = {
      slug: 'ROW_PAY',
      created_at: '2026-07-19T12:00:00Z',
      data: { BjEp0J2J: '済' },
      rendered_data: [
        { alias: 'fr_id', value: token },
        { alias: 'payment_alias', value: 'カード決済済み' },
      ],
    };
    const input = await mapFormalooListRowToUpsert(row, mappedForm, { friendTokenSecret: FR_SECRET });
    expect(input?.verifiedFriendMetadataSync).toEqual({
      friendId: 'frA',
      updates: [
        { formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '済' },
        { formalooFieldKey: 'payment_alias', friendMetadataKey: '入金メモ', value: 'カード決済済み' },
      ],
    });
  });

  test('D-3: matrix/repeating の raw JSON を保ったまま fr_id と scalar status metadata を処理する', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const matrixValue = {
      item_1: { satisfied: true, note: '満足' },
      item_2: { satisfied: false, note: null },
    };
    const repeatingValue = [
      { participant: 'A', age: 20 },
      { participant: 'B', age: 21 },
    ];
    const structuralMappedForm = {
      ...FORM_H,
      friend_metadata_mappings_json: JSON.stringify([
        { formalooFieldKey: 'status_slug', friendMetadataKey: '申込状態' },
        { formalooFieldKey: 'matrix_slug', friendMetadataKey: '行列回答' },
        { formalooFieldKey: 'repeating_slug', friendMetadataKey: '繰返し回答' },
      ]),
    };
    const answers = {
      status_slug: '受付済み',
      matrix_slug: matrixValue,
      repeating_slug: repeatingValue,
    };

    const input = await mapFormalooListRowToUpsert({
      slug: 'ROW_STRUCTURAL',
      created_at: '2026-07-20T10:00:00Z',
      data: answers,
      rendered_data: [{ alias: 'fr_id', value: token }],
    }, structuralMappedForm, { friendTokenSecret: FR_SECRET });

    expect(JSON.parse(input!.answersJson)).toEqual(answers);
    expect(input!.friendId).toBe('frA');
    // metadata は scalar の status だけを反映し、object/array を `[object Object]` 化しない。
    expect(input!.verifiedFriendMetadataSync).toEqual({
      friendId: 'frA',
      updates: [{ formalooFieldKey: 'status_slug', friendMetadataKey: '申込状態', value: '受付済み' }],
    });
  });

  test('改ざん token / secret 未供給は intent を返さず fail-closed', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const tampered = `${token}x`;
    const row = { slug: 'ROW_BAD', data: { BjEp0J2J: '済' }, rendered_data: [{ alias: 'fr_id', value: tampered }] };
    const invalid = await mapFormalooListRowToUpsert(row, mappedForm, { friendTokenSecret: FR_SECRET });
    const noSecret = await mapFormalooListRowToUpsert(row, mappedForm);
    expect(invalid?.friendId).toBeNull();
    expect(invalid?.verifiedFriendMetadataSync).toBeUndefined();
    expect(noSecret?.verifiedFriendMetadataSync).toBeUndefined();
  });

  test('mapping 未設定 / source 値欠落は既存 upsert のままで何もしない', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = { slug: 'ROW_EMPTY', data: {}, rendered_data: [{ alias: 'fr_id', value: token }] };
    const noMapping = await mapFormalooListRowToUpsert(row, FORM_H, { friendTokenSecret: FR_SECRET });
    const noValue = await mapFormalooListRowToUpsert(row, mappedForm, { friendTokenSecret: FR_SECRET });
    expect(noMapping?.verifiedFriendMetadataSync).toBeUndefined();
    expect(noValue?.verifiedFriendMetadataSync).toBeUndefined();
  });

  test('値を空文字にした時も slug/alias mapping の clear intent を返す', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const row = {
      slug: 'ROW_CLEAR',
      created_at: '2026-07-19T12:00:00Z',
      data: { BjEp0J2J: '' },
      rendered_data: [
        { alias: 'fr_id', value: token },
        { alias: 'payment_alias', value: '' },
      ],
    };
    const input = await mapFormalooListRowToUpsert(row, mappedForm, { friendTokenSecret: FR_SECRET });
    expect(input?.verifiedFriendMetadataSync?.updates).toEqual([
      { formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '' },
      { formalooFieldKey: 'payment_alias', friendMetadataKey: '入金メモ', value: '' },
    ]);
  });

  test('alias の number/boolean も個人情報用の文字列にする', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    const input = await mapFormalooListRowToUpsert({
      slug: 'ROW_SCALAR',
      created_at: '2026-07-19T12:00:00Z',
      data: {},
      rendered_data: [
        { alias: 'fr_id', value: token },
        { alias: 'payment_alias', value: 1 },
      ],
    }, mappedForm, { friendTokenSecret: FR_SECRET });
    expect(input?.verifiedFriendMetadataSync?.updates).toContainEqual({
      formalooFieldKey: 'payment_alias', friendMetadataKey: '入金メモ', value: '1',
    });
  });

  test('created_at 欠落/不正 row は friend_id を復元しても metadata intent を作らない', async () => {
    const token = await signFriendToken('frA', FR_SECRET);
    for (const created_at of [undefined, 'not-a-date']) {
      const input = await mapFormalooListRowToUpsert({
        slug: `ROW_${created_at ?? 'MISSING'}`,
        ...(created_at === undefined ? {} : { created_at }),
        data: { BjEp0J2J: '未' },
        rendered_data: [{ alias: 'fr_id', value: token }],
      }, mappedForm, { friendTokenSecret: FR_SECRET });
      expect(input?.friendId).toBe('frA');
      expect(input?.verifiedFriendMetadataSync).toBeUndefined();
    }
  });
});
