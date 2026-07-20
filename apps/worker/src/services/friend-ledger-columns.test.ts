import { describe, expect, test } from 'vitest';
import {
  FRIEND_LEDGER_IDENTITY_HEADERS,
  buildFriendLedgerColumns,
  mergeFriendProjectionIntoRow,
  projectFriendLedgerRow,
  resolveFriendLedgerHeaders,
} from './friend-ledger-columns.js';
import * as ledgerColumns from './friend-ledger-columns.js';

const mappings = [
  { fieldId: 'field_paid', header: '入金確認' },
  { fieldId: 'field_note', header: '担当メモ' },
];

describe('friend ledger column block', () => {
  test('builds the reusable friend block with immutable identity columns first', () => {
    expect(FRIEND_LEDGER_IDENTITY_HEADERS).toEqual(['表示名', 'userId', '登録日']);
    expect(buildFriendLedgerColumns(mappings)).toEqual([
      { key: 'identity:displayName', header: '表示名', kind: 'identity', readOnly: true },
      { key: 'identity:lineUserId', header: 'userId', kind: 'identity', readOnly: true },
      { key: 'identity:registeredAt', header: '登録日', kind: 'identity', readOnly: true },
      { key: 'field:field_paid', header: '入金確認', kind: 'custom', readOnly: false },
      { key: 'field:field_note', header: '担当メモ', kind: 'custom', readOnly: false },
    ]);
  });

  test('resolves by exact heading after company columns are inserted or reordered', () => {
    const columns = buildFriendLedgerColumns(mappings);
    const resolved = resolveFriendLedgerHeaders(
      ['自社担当', '担当メモ', 'userId', '表示名', '登録日', '入金確認'],
      columns,
    );

    expect(resolved.indexByKey).toEqual({
      'identity:displayName': 3,
      'identity:lineUserId': 2,
      'identity:registeredAt': 4,
      'field:field_paid': 5,
      'field:field_note': 1,
    });
    expect(resolved.warnings).toEqual([]);
  });

  test('warns and refuses ambiguous, renamed, or identity-colliding headings', () => {
    const columns = buildFriendLedgerColumns([
      { fieldId: 'bad', header: '表示名' },
      { fieldId: 'paid', header: '入金確認' },
    ]);
    const resolved = resolveFriendLedgerHeaders(
      ['表示名', 'userId', '登録日', '入金済み', '表示名'],
      columns,
    );

    expect(resolved.indexByKey['field:paid']).toBeUndefined();
    expect(resolved.indexByKey['identity:displayName']).toBeUndefined();
    expect(resolved.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_header', header: '表示名' }),
      expect.objectContaining({ code: 'missing_header', header: '入金確認' }),
      expect.objectContaining({ code: 'configured_header_collision', header: '表示名' }),
    ]));
  });

  test('projects selected metadata only and preserves every company-owned cell', () => {
    const columns = buildFriendLedgerColumns(mappings);
    const headers = ['自社担当', '担当メモ', 'userId', '表示名', '登録日', '入金確認'];
    const resolved = resolveFriendLedgerHeaders(headers, columns);
    const projection = projectFriendLedgerRow({
      id: 'friend-1',
      lineUserId: 'U123',
      displayName: 'あやこ',
      registeredAt: '2026-07-21T10:00:00+09:00',
      metadata: { 入金確認: '済', 担当メモ: '佐藤', 未選択: '漏らさない' },
    }, mappings);

    expect(mergeFriendProjectionIntoRow(
      ['営業部', '旧担当', 'U123', '旧名', '旧日付', '未'],
      projection,
      columns,
      resolved,
    )).toEqual(['営業部', '佐藤', 'U123', 'あやこ', '2026-07-21T10:00:00+09:00', '済']);
    expect(Object.keys(projection)).not.toContain('未選択');
  });
});

describe('form answer column block', () => {
  test('places form-built answer headings after the friend block and projects complex answers', () => {
    const answerApi = ledgerColumns as typeof ledgerColumns & {
      buildFormAnswerColumns?: (
        formId: string,
        fields: { fieldId: string; header: string }[],
      ) => ReturnType<typeof buildFriendLedgerColumns>;
      projectFormAnswerRow?: (
        formId: string,
        fields: { fieldId: string; header: string }[],
        answers: Record<string, unknown>,
      ) => Record<string, string>;
    };

    expect(answerApi.buildFormAnswerColumns).toBeTypeOf('function');
    expect(answerApi.projectFormAnswerRow).toBeTypeOf('function');
    if (!answerApi.buildFormAnswerColumns || !answerApi.projectFormAnswerRow) return;

    const fields = [
      { fieldId: 'name', header: 'お名前' },
      { fieldId: 'choices', header: '希望内容' },
    ];
    const columns = [
      ...buildFriendLedgerColumns(mappings),
      ...answerApi.buildFormAnswerColumns('form-entry', fields),
    ];

    expect(columns.map((column) => column.header)).toEqual([
      '表示名', 'userId', '登録日', '入金確認', '担当メモ', 'お名前', '希望内容',
    ]);
    expect(columns.slice(-2)).toEqual([
      { key: 'answer:form-entry:name', header: 'お名前', kind: 'answer', readOnly: false },
      { key: 'answer:form-entry:choices', header: '希望内容', kind: 'answer', readOnly: false },
    ]);
    expect(answerApi.projectFormAnswerRow('form-entry', fields, {
      name: '山田花子',
      choices: ['資料', '相談'],
      ignored: '列にしない',
    })).toEqual({
      'answer:form-entry:name': '山田花子',
      'answer:form-entry:choices': '["資料","相談"]',
    });
  });

  test('treats an answer label colliding with a friend heading as ambiguous', () => {
    const answerApi = ledgerColumns as typeof ledgerColumns & {
      buildFormAnswerColumns?: (
        formId: string,
        fields: { fieldId: string; header: string }[],
      ) => ReturnType<typeof buildFriendLedgerColumns>;
    };

    expect(answerApi.buildFormAnswerColumns).toBeTypeOf('function');
    if (!answerApi.buildFormAnswerColumns) return;
    const columns = [
      ...buildFriendLedgerColumns(mappings),
      ...answerApi.buildFormAnswerColumns('form-entry', [{ fieldId: 'name', header: '表示名' }]),
    ];
    const resolved = resolveFriendLedgerHeaders(
      ['表示名', 'userId', '登録日', '入金確認', '担当メモ'],
      columns,
    );

    expect(resolved.indexByKey['identity:displayName']).toBeUndefined();
    expect(resolved.indexByKey['answer:form-entry:name']).toBeUndefined();
    expect(resolved.warnings).toContainEqual({ code: 'configured_header_collision', header: '表示名' });
  });

  test('reflects explicit answer read-only policy in generated columns', () => {
    const columns = ledgerColumns.buildFormAnswerColumns('form-entry', [
      { fieldId: 'name', header: 'お名前', type: 'text' },
      { fieldId: 'formula', header: '合計', type: 'formula', readOnly: true },
      { fieldId: 'file', header: '添付', type: 'file', readOnly: true },
      { fieldId: 'signature', header: '署名', type: 'signature', readOnly: true },
      { fieldId: 'matrix', header: '行列', type: 'matrix', readOnly: true },
      { fieldId: 'rows', header: '明細', type: 'repeating_section', readOnly: true },
    ]);

    expect(columns.map(({ key, readOnly }) => ({ key, readOnly }))).toEqual([
      { key: 'answer:form-entry:name', readOnly: false },
      { key: 'answer:form-entry:formula', readOnly: true },
      { key: 'answer:form-entry:file', readOnly: true },
      { key: 'answer:form-entry:signature', readOnly: true },
      { key: 'answer:form-entry:matrix', readOnly: true },
      { key: 'answer:form-entry:rows', readOnly: true },
    ]);
  });

  test('parses editable sheet cells without changing the stored answer type', () => {
    const parse = (ledgerColumns as typeof ledgerColumns & {
      parseFormAnswerSheetValue?: (
        field: { fieldId: string; header: string; type?: string; readOnly?: boolean },
        observed: string,
        current: unknown,
      ) => { ok: true; value: unknown } | { ok: false; reason: string };
    }).parseFormAnswerSheetValue;

    expect(parse).toBeTypeOf('function');
    if (!parse) return;
    expect(parse({ fieldId: 'n', header: '数', type: 'number' }, ' -1.25e2 ', 1))
      .toEqual({ ok: true, value: -125 });
    expect(parse({ fieldId: 'n', header: '数', type: 'number' }, 'Infinity', 1))
      .toEqual({ ok: false, reason: 'invalid_number' });
    expect(parse({ fieldId: 'b', header: '可否', type: 'yes_no' }, ' TrUe ', false))
      .toEqual({ ok: true, value: true });
    expect(parse({ fieldId: 'b', header: '可否', type: 'yes_no' }, 'FALSE', true))
      .toEqual({ ok: true, value: false });
    expect(parse({ fieldId: 'b', header: '可否', type: 'yes_no' }, 'はい', true))
      .toEqual({ ok: false, reason: 'invalid_boolean' });
    expect(parse({ fieldId: 'a', header: '複数' }, '["A",2]', ['old']))
      .toEqual({ ok: true, value: ['A', 2] });
    expect(parse({ fieldId: 'a', header: '複数' }, '{"value":1}', ['old']))
      .toEqual({ ok: false, reason: 'container_type_mismatch' });
    expect(parse({ fieldId: 'a', header: '複数', type: 'multiple_select' }, '["A"]', undefined))
      .toEqual({ ok: true, value: ['A'] });
    expect(parse({ fieldId: 'a', header: '複数', type: 'multiple_select' }, 'A', undefined))
      .toEqual({ ok: false, reason: 'invalid_json' });
    expect(parse({ fieldId: 'o', header: '行列' }, '{"row":"A"}', { row: 'old' }))
      .toEqual({ ok: true, value: { row: 'A' } });
    expect(parse({ fieldId: 'o', header: '行列' }, '["A"]', { row: 'old' }))
      .toEqual({ ok: false, reason: 'container_type_mismatch' });
    expect(parse({ fieldId: 'o', header: '行列' }, '{broken', { row: 'old' }))
      .toEqual({ ok: false, reason: 'invalid_json' });
    expect(parse({ fieldId: 's', header: '文字', type: 'text' }, ' 001 ', 'old'))
      .toEqual({ ok: true, value: ' 001 ' });
    expect(parse({ fieldId: 'r', header: '署名', type: 'signature', readOnly: true }, 'tampered', 'data:image/png;base64,secret'))
      .toEqual({ ok: false, reason: 'read_only' });
    expect(parse({ fieldId: 'long', header: '長文', type: 'textarea' }, 'tampered', 'private'.repeat(10_000)))
      .toEqual({ ok: false, reason: 'read_only' });
  });

  test('projects signatures and files as bounded non-sensitive summaries', () => {
    const fields = [
      { fieldId: 'signature', header: '署名', type: 'signature', readOnly: true },
      { fieldId: 'file', header: '添付', type: 'file', readOnly: true },
      { fieldId: 'matrix', header: '行列', type: 'matrix', readOnly: true },
      { fieldId: 'long', header: '長文', type: 'textarea' },
    ];
    const projection = ledgerColumns.projectFormAnswerRow('form-entry', fields, {
      signature: `data:image/png;base64,${'private'.repeat(100_000)}`,
      file: [
        { key: 'private/r2-key-1', name: '秘密資料.pdf' },
        { key: 'private/r2-key-2', name: '個人情報.csv' },
      ],
      matrix: { '質問1': '回答A' },
      long: 'private'.repeat(10_000),
    });

    expect(projection).toEqual({
      'answer:form-entry:signature': '[署名あり]',
      'answer:form-entry:file': '[添付ファイル 2件]',
      'answer:form-entry:matrix': '{"質問1":"回答A"}',
      'answer:form-entry:long': expect.stringMatching(/^\[回答が長いため省略（\d+文字）\]$/),
    });
    expect(projection['answer:form-entry:signature'].length).toBeLessThan(50_000);
    expect(projection['answer:form-entry:file']).not.toContain('private');
    expect(projection['answer:form-entry:file']).not.toContain('秘密資料.pdf');
    expect(projection['answer:form-entry:long'].length).toBeLessThan(50_000);
    expect(projection['answer:form-entry:long']).not.toContain('private');
  });
});
