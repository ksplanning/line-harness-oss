import { describe, expect, test } from 'vitest';
import type { HarnessField, HarnessFieldType } from '@line-crm/shared';
import {
  JAPAN_PREFECTURES,
  evaluateInternalFormAvailability,
  evaluateInternalFormula,
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalFormField,
} from './internal-form-runtime.js';

function field(
  id: string,
  type: HarnessFieldType,
  config: HarnessField['config'] = {},
  over: Partial<HarnessField> = {},
): HarnessField {
  return {
    id,
    type,
    label: id,
    required: false,
    position: 0,
    config,
    ...over,
  };
}

function parse(fields: HarnessField[], extra: Record<string, unknown> = {}) {
  return parseInternalFormDefinition(JSON.stringify({ fields, logic: [], ...extra }));
}

const optionalNumber = field('amount', 'number') as InternalFormField;

describe('parseInternalFormDefinition W2 field contract', () => {
  test('accepts every internal renderer field except choice_fetch and preserves form copy/type', () => {
    const fields: HarnessField[] = [
      field('text', 'text', { placeholder: 'お名前', minLength: 1, maxLength: 20 }),
      field('textarea', 'textarea', { placeholder: '詳しく', minLength: 2, maxLength: 200 }),
      field('number', 'number'),
      field('email', 'email'),
      field('phone', 'phone'),
      field('date', 'date'),
      field('choice', 'choice', { choices: ['A', 'B'], defaultValue: 'B' }),
      field('dropdown', 'dropdown', { choices: ['A', 'B'], defaultValue: 'A' }),
      field('multiple', 'multiple_select', { choices: ['A', 'B'], defaultValues: ['A'] }),
      field('file', 'file', { allowedExtensions: ['pdf'], maxSizeKb: 2048 }),
      field('rating', 'rating', { ratingSubType: 'star' }),
      field('signature', 'signature'),
      field('variable', 'variable', { variableSubType: 'formula', formula: '{number}*2', decimalPlaces: 1 }),
      field('matrix', 'matrix', {
        matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
        matrixChoiceGroups: [{ title: '接客' }, { title: '価格' }],
      }),
      field('repeat', 'repeating_section', {
        repeatingColumns: [{ columnField: 'text', title: '氏名' }],
        minRows: 1,
        maxRows: 3,
      }),
      field('yes_no', 'yes_no'),
      field('time', 'time'),
      field('website', 'website'),
      field('city', 'city'),
      field('datetime', 'datetime'),
      field('country', 'country'),
      field('postal_code', 'postal_code'),
      field('prefecture', 'prefecture'),
      field('address_city', 'address_city'),
      field('address_street', 'address_street'),
      field('address_building', 'address_building'),
      field('address', 'address' as HarnessFieldType),
      field('section', 'section', { text: '説明' }),
      field('page_break', 'page_break'),
      field('video', 'video', { videoUrl: 'https://www.youtube.com/watch?v=abc' }),
      field('image', 'image', { imageUrl: 'https://example.test/image.png' }),
    ].map((item, position) => ({ ...item, position }));

    const result = parse(fields, {
      formType: 'multi_step',
      formCopy: { buttonText: '申し込む', successMessage: '完了' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.fields.map((item) => item.type)).toEqual(fields.map((item) => item.type));
    expect(result.definition.formType).toBe('multi_step');
    expect(result.definition.buttonText).toBe('申し込む');
    expect(result.definition.successMessage).toBe('完了');
    expect(result.definition.fields[0].config.placeholder).toBe('お名前');
  });

  test('keeps branching and choice_fetch outside the internal renderer', () => {
    expect(parseInternalFormDefinition(JSON.stringify({
      fields: [field('text', 'text')],
      logic: [{ id: 'rule' }],
    }))).toMatchObject({ ok: false, error: expect.stringMatching(/分岐/) });

    expect(parse([
      field('remote', 'choice_fetch', { choicesSource: 'https://example.test/choices' }),
    ])).toMatchObject({ ok: false, error: expect.stringMatching(/未対応/) });

    expect(parseInternalFormDefinition(JSON.stringify({
      fields: [field('text', 'text')],
      logic: { unexpected: true },
    }))).toMatchObject({ ok: false, error: expect.stringMatching(/分岐/) });
  });

  test.each([
    [{ minLength: -1 }, /文字数/],
    [{ minLength: 1.5 }, /文字数/],
    [{ maxLength: 0 }, /文字数/],
    [{ minLength: 5, maxLength: 4 }, /文字数/],
  ])('rejects invalid text length config %j', (config, message) => {
    expect(parse([field('text', 'text', config)])).toMatchObject({ ok: false, error: expect.stringMatching(message) });
  });

  test('rejects defaults outside their choices and duplicate multiple defaults', () => {
    expect(parse([field('choice', 'choice', { choices: ['A'], defaultValue: 'B' })]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/既定/) });
    expect(parse([field('multiple', 'multiple_select', { choices: ['A'], defaultValues: ['A', 'A'] })]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/既定/) });
  });

  test('rejects ambiguous matrix titles and invalid repeating references', () => {
    expect(parse([field('matrix', 'matrix', {
      matrixChoiceItems: { a: { title: '同じ' }, b: { title: '同じ' } },
      matrixChoiceGroups: [{ title: '行' }],
    })])).toMatchObject({ ok: false, error: expect.stringMatching(/行列/) });

    expect(parse([field('matrix', 'matrix', {
      matrixChoiceItems: { a: { title: '列' } },
      matrixChoiceGroups: [{ title: '同じ' }, { title: '同じ' }],
    })])).toMatchObject({ ok: false, error: expect.stringMatching(/行列/) });

    expect(parse([field('matrix', 'matrix', {
      matrixChoiceItems: { a: { title: '列' }, malformed: '列名なし' },
      matrixChoiceGroups: [{ title: '行' }],
    })])).toMatchObject({ ok: false, error: expect.stringMatching(/行列/) });

    expect(parse([field('repeat', 'repeating_section', {
      repeatingColumns: [{ columnField: 'missing', title: '氏名' }],
    })])).toMatchObject({ ok: false, error: expect.stringMatching(/繰り返し/) });
  });

  test('rejects missing, cyclic, and syntactically unsafe formula definitions', () => {
    expect(parse([field('total', 'variable', { variableSubType: 'formula', formula: '{missing}+1' })]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/参照/) });

    expect(parse([
      field('a', 'variable', { variableSubType: 'formula', formula: '{b}+1' }),
      field('b', 'variable', { variableSubType: 'formula', formula: '{a}+1' }),
    ])).toMatchObject({ ok: false, error: expect.stringMatching(/循環/) });

    expect(parse([field('bad', 'variable', { variableSubType: 'formula', formula: 'globalThis.alert(1)' })]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/計算式/) });
  });
});

describe('validateInternalFormAnswers number and length grammar', () => {
  test('keeps untrusted field ids in a null-prototype answer map', () => {
    const result = validateInternalFormAnswers([
      field('__proto__', 'text') as InternalFormField,
    ], { a_0: '回答' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.answers)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.answers, '__proto__')).toBe(true);
    expect(result.answers.__proto__).toBe('回答');
  });

  test.each([
    '0x10',
    '0b10',
    '   ',
    'NaN',
    'Infinity',
    '-Infinity',
  ])('rejects non-decimal number input %j', (value) => {
    expect(validateInternalFormAnswers([optionalNumber], { a_0: value })).toEqual({
      ok: false,
      error: 'amount の形式が正しくありません',
    });
  });

  test.each<[string, number]>([
    ['-12', -12],
    ['12.5', 12.5],
    ['.5', 0.5],
    ['-0.25', -0.25],
    ['6.02e23', 6.02e23],
    ['1e+3', 1_000],
    ['-2.5E-3', -0.0025],
  ])('accepts HTML-compatible decimal input %s', (value, expected) => {
    const result = validateInternalFormAnswers([optionalNumber], { a_0: value });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.amount).toBe(expected);
  });

  test.each([
    {},
    { a_0: '' },
  ])('omits an optional empty number instead of coercing it', (input) => {
    const result = validateInternalFormAnswers([optionalNumber], input);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers).not.toHaveProperty('amount');
  });

  test('enforces min/max by Unicode code point for text and textarea', () => {
    const fields = [
      field('short', 'text', { minLength: 2, maxLength: 3 }),
      field('long', 'textarea', { minLength: 2, maxLength: 3 }),
    ] as InternalFormField[];

    expect(validateInternalFormAnswers(fields, { a_0: '😀', a_1: 'ab' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/2文字以上/) });
    expect(validateInternalFormAnswers(fields, { a_0: '😀ab', a_1: 'abcd' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/3文字以内/) });
    expect(validateInternalFormAnswers(fields, { a_0: '😀a', a_1: '日本' })).toMatchObject({
      ok: true,
      answers: { short: '😀a', long: '日本' },
    });
  });
});

describe('validateInternalFormAnswers W2 scalar normalization', () => {
  test('住所の改行を保存前に半角スペースへ変換して後工程へ1行で渡す', () => {
    const result = validateInternalFormAnswers(
      [field('address', 'address' as HarnessFieldType) as InternalFormField],
      { a_0: ' 東京都\r\n千代田区\n千代田1-1\r本館 ' },
    );

    expect(result).toMatchObject({
      ok: true,
      answers: { address: '東京都 千代田区 千代田1-1 本館' },
    });
    if (result.ok) expect(JSON.stringify(result.answers)).not.toMatch(/\\[nr]/);
  });

  test('uses the shared postal lookup normalization when a native postal value is submitted', () => {
    const result = validateInternalFormAnswers(
      [field('postal', 'postal_code') as InternalFormField],
      { a_0: '１－２ー３−４‐５‑６-７' },
    );

    expect(result).toMatchObject({ ok: true, answers: { postal: '1234567' } });
  });

  test('normalizes yes/no, date/time/datetime, URL and Japanese address parts', () => {
    const fields = [
      field('yn', 'yes_no'),
      field('time', 'time'),
      field('date', 'date'),
      field('datetime', 'datetime'),
      field('website', 'website'),
      field('country', 'country', {}, { required: true }),
      field('postal', 'postal_code'),
      field('prefecture', 'prefecture'),
      field('city', 'address_city'),
      field('street', 'address_street'),
      field('building', 'address_building'),
    ] as InternalFormField[];

    const result = validateInternalFormAnswers(fields, {
      a_0: 'yes',
      a_1: '09:05',
      a_2: '2028-02-29',
      a_3: '2028-02-29T09:05',
      a_4: 'https://example.test/path',
      a_5: ' 日本 ',
      a_6: '100-0001',
      a_7: '東京都',
      a_8: ' 千代田区 ',
      a_9: ' 千代田1-1 ',
      a_10: ' 本館 ',
    });

    expect(result).toMatchObject({
      ok: true,
      answers: {
        yn: true,
        time: '09:05',
        date: '2028-02-29',
        datetime: '2028-02-29T09:05',
        website: 'https://example.test/path',
        country: '日本',
        postal: '1000001',
        prefecture: '東京都',
        city: '千代田区',
        street: '千代田1-1',
        building: '本館',
      },
    });
  });

  test.each([
    ['yes_no', 'maybe'],
    ['time', '24:00'],
    ['date', '2026-02-30'],
    ['datetime', '2026-02-30T10:00'],
    ['website', 'javascript:alert(1)'],
    ['postal_code', '1234'],
    ['prefecture', '東京'],
  ] as const)('rejects invalid %s value', (type, value) => {
    expect(validateInternalFormAnswers([field(type, type) as InternalFormField], { a_0: value }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/形式|選択肢/) });
  });

  test('exports the exact 47 Japanese prefectures used by validation/rendering', () => {
    expect(JAPAN_PREFECTURES).toHaveLength(47);
    expect(JAPAN_PREFECTURES[0]).toBe('北海道');
    expect(JAPAN_PREFECTURES.at(-1)).toBe('沖縄県');
  });
});

describe('rating, signature, matrix, repeating and decoration answers', () => {
  test.each([
    ['star', '5', 5],
    ['embeded', '1', 1],
    ['nps', '10', 10],
    ['score', '-2.5', -2.5],
    ['like_dislike', 'like', 'like'],
  ] as const)('normalizes %s rating', (ratingSubType, raw, expected) => {
    const result = validateInternalFormAnswers([
      field('rating', 'rating', { ratingSubType }) as InternalFormField,
    ], { a_0: raw });
    expect(result).toMatchObject({ ok: true, answers: { rating: expected } });
  });

  test.each([
    ['star', '0'],
    ['star', '6'],
    ['nps', '11'],
    ['nps', '1.5'],
    ['like_dislike', 'yes'],
    ['score', 'NaN'],
  ] as const)('rejects invalid %s rating %s', (ratingSubType, raw) => {
    expect(validateInternalFormAnswers([
      field('rating', 'rating', { ratingSubType }) as InternalFormField,
    ], { a_0: raw })).toMatchObject({ ok: false });
  });

  test('accepts a bounded PNG data URL for signature', () => {
    const signature = `data:image/png;base64,${btoa('signature')}`;
    expect(validateInternalFormAnswers([
      field('sign', 'signature') as InternalFormField,
    ], { a_0: signature })).toMatchObject({ ok: true, answers: { sign: signature } });
    expect(validateInternalFormAnswers([
      field('sign', 'signature') as InternalFormField,
    ], { a_0: 'javascript:alert(1)' })).toMatchObject({ ok: false });
  });

  test('stores matrix answers as human-readable row title -> column title', () => {
    const matrix = field('matrix', 'matrix', {
      matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
      matrixChoiceGroups: [{ title: '接客' }, { title: '価格' }],
    }, { required: true }) as InternalFormField;

    expect(validateInternalFormAnswers([matrix], {
      a_0_m_0: 'good',
      a_0_m_1: 'bad',
    })).toMatchObject({
      ok: true,
      answers: { matrix: { 接客: '良い', 価格: '悪い' } },
    });
    expect(validateInternalFormAnswers([matrix], { a_0_m_0: 'unknown', a_0_m_1: 'bad' }))
      .toMatchObject({ ok: false });
    expect(validateInternalFormAnswers([matrix], { a_0_m_0: 'good' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/必須/) });
  });

  test('stores repeating rows keyed by referenced field id and does not validate templates standalone', () => {
    const fields = [
      field('name', 'text', { maxLength: 10 }, { required: true }),
      field('age', 'number', {}, { required: true }),
      field('repeat', 'repeating_section', {
        repeatingColumns: [
          { columnField: 'name', title: '氏名' },
          { columnField: 'age', title: '年齢' },
        ],
        minRows: 1,
        maxRows: 2,
      }),
    ] as InternalFormField[];

    expect(validateInternalFormAnswers(fields, {
      a_2_count: '2',
      a_2_r_0_0: '佐藤',
      a_2_r_0_1: '20',
      a_2_r_1_0: '鈴木',
      a_2_r_1_1: '30',
    })).toMatchObject({
      ok: true,
      answers: {
        repeat: [
          { name: '佐藤', age: 20 },
          { name: '鈴木', age: 30 },
        ],
      },
    });
  });

  test('skips decorations entirely', () => {
    const fields = [
      field('section', 'section', { text: '案内' }),
      field('page', 'page_break'),
      field('video', 'video', { videoUrl: 'https://example.test/video' }),
      field('image', 'image', { imageUrl: 'https://example.test/image.png' }),
      field('name', 'text'),
    ] as InternalFormField[];
    expect(validateInternalFormAnswers(fields, { a_4: '佐藤' })).toMatchObject({
      ok: true,
      answers: { name: '佐藤' },
    });
  });
});

describe('file validation and pending upload hand-off', () => {
  test('returns validated File objects separately and never puts them in answers', () => {
    const upload = new File(['hello'], 'document.PDF', { type: 'application/pdf' });
    const result = validateInternalFormAnswers([
      field('attachment', 'file', { allowedExtensions: ['pdf'], maxSizeKb: 256 }) as InternalFormField,
    ], { a_0: upload });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers).not.toHaveProperty('attachment');
    expect(result.pendingUploads).toEqual([{ fieldId: 'attachment', fieldIndex: 0, files: [upload] }]);
  });

  test('enforces required, multiplicity, extension and size before upload', () => {
    const config = { allowedExtensions: ['pdf'], maxSizeKb: 256 };
    const required = field('attachment', 'file', config, { required: true }) as InternalFormField;
    expect(validateInternalFormAnswers([required], {})).toMatchObject({ ok: false, error: expect.stringMatching(/必須/) });
    expect(validateInternalFormAnswers([required], {
      a_0: [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')],
    })).toMatchObject({ ok: false, error: expect.stringMatching(/1つ/) });
    expect(validateInternalFormAnswers([required], { a_0: new File(['x'], 'x.exe') }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/拡張子/) });
    expect(validateInternalFormAnswers([required], { a_0: new File([new Uint8Array(256 * 1024 + 1)], 'x.pdf') }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/サイズ/) });
  });
});

describe('safe formula parser and server recomputation', () => {
  test('supports precedence, unary signs, parentheses, decimal exponents and references', () => {
    expect(evaluateInternalFormula('-({price}+1.5e1)*2/{divisor}', { price: 5, divisor: 4 }))
      .toEqual({ ok: true, value: -10 });
  });

  test.each([
    ['globalThis.process.exit()', {}],
    ['{missing}+1', {}],
    ['1/0', {}],
    ['1e308*1e308', {}],
  ] as Array<[string, Record<string, unknown>]>)('rejects unsafe/missing/div-zero/non-finite formula %s', (formula, values) => {
    expect(evaluateInternalFormula(formula, values)).toMatchObject({ ok: false });
  });

  test('recomputes formulas on the server in dependency order and rounds decimal places', () => {
    const fields = [
      field('price', 'number'),
      field('quantity', 'number'),
      field('subtotal', 'variable', {
        variableSubType: 'formula',
        formula: '{price}*{quantity}',
        decimalPlaces: 2,
      }),
      field('taxed', 'variable', { variableSubType: 'formula', formula: '{subtotal}*1.1', decimalPlaces: 2 }),
    ] as InternalFormField[];

    expect(validateInternalFormAnswers(fields, { a_0: '12.34', a_1: '3', a_2: '999999' })).toMatchObject({
      ok: true,
      answers: { price: 12.34, quantity: 3, subtotal: 37.02, taxed: 40.72 },
    });
  });

  test('fails submission when a referenced answer is missing or division becomes zero', () => {
    const fields = [
      field('amount', 'number'),
      field('divisor', 'number'),
      field('result', 'variable', { variableSubType: 'formula', formula: '{amount}/{divisor}' }),
    ] as InternalFormField[];
    expect(validateInternalFormAnswers(fields, { a_0: '10', a_1: '' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/計算/) });
    expect(validateInternalFormAnswers(fields, { a_0: '10', a_1: '0' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/計算/) });
  });
});

describe('internal form definition and availability', () => {
  const source: InternalFormField = {
    id: 'kind', type: 'choice', label: '種別', required: true, position: 0,
    config: { choices: ['法人', '個人'] },
  };
  const company: InternalFormField = {
    id: 'company', type: 'text', label: '会社名', required: true, position: 1, config: {},
  };

  test('accepts internal logic, design, completion, redirect, and operations settings', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [source, company],
      logic: [{
        id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人',
        action: 'show', targetFieldId: 'company',
      }],
      formType: 'simple',
      design: { themeColor: '#123456', backgroundColor: '#F0F0F0' },
      formCopy: { buttonText: '申し込む', successMessage: '完了' },
      formRedirect: { url: 'https://example.test/thanks', openExternalBrowser: true },
      successPages: [{ id: 'done-a', title: 'A完了', description: 'ありがとうございました' }],
      operationsSettings: {
        maxSubmitCount: 20,
        submitStartTime: '2026-07-25T00:00:00+09:00',
        submitEndTime: '2026-08-01T00:00:00+09:00',
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.logic).toHaveLength(1);
    expect(result.definition.formType).toBe('simple');
    expect(result.definition.design).toMatchObject({ themeColor: '#123456' });
    expect(result.definition.formRedirect).toMatchObject({ url: 'https://example.test/thanks' });
    expect(result.definition.successPages).toEqual([{ id: 'done-a', title: 'A完了', description: 'ありがとうございました' }]);
    expect(result.definition.operationsSettings).toMatchObject({ maxSubmitCount: 20 });
  });

  test('reports upcoming, ended, limit reached, and open states with an honest Japanese message', () => {
    const definition = {
      fields: [source], logic: [], buttonText: null, successMessage: null, errorMessage: null,
      design: {}, formType: 'simple' as const, formRedirect: {}, successPages: [],
      operationsSettings: {
        submitStartTime: '2026-07-25T00:00:00+09:00',
        submitEndTime: '2026-08-01T00:00:00+09:00',
        maxSubmitCount: 2,
      },
    };

    expect(evaluateInternalFormAvailability(definition, 0, new Date('2026-07-24T12:00:00+09:00')))
      .toEqual({ status: 'upcoming', message: '受付開始前・7月25日から' });
    expect(evaluateInternalFormAvailability(definition, 0, new Date('2026-08-01T00:00:00+09:00')))
      .toEqual({ status: 'ended', message: '受付は終了しました' });
    expect(evaluateInternalFormAvailability(definition, 2, new Date('2026-07-26T00:00:00+09:00')))
      .toEqual({ status: 'limit_reached', message: '回答上限に達したため受付を終了しました' });
    expect(evaluateInternalFormAvailability(definition, 1, new Date('2026-07-26T00:00:00+09:00')))
      .toEqual({ status: 'open', message: null });
  });

  test('rejects an受付 period whose end is not after its start', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [source],
      logic: [],
      operationsSettings: {
        submitStartTime: '2026-08-01T00:00:00+09:00',
        submitEndTime: '2026-07-25T00:00:00+09:00',
      },
    }));

    expect(result).toEqual({ ok: false, error: '受付終了は受付開始より後の日時にしてください' });
  });

  test.each(['\r', '\n', '\t', '\u0000', '\u007f'])('rejects control character %j in an internal redirect URL', (control) => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [source],
      logic: [],
      formRedirect: { url: `https://example.test/thanks${control}injected`, openExternalBrowser: false },
    }));

    expect(result).toEqual({ ok: false, error: '送信後の飛び先URLに使用できない文字が含まれています' });
  });

  test.each([
    [{ conditions: [null] }, 'condition shape'],
    [{ conditions: [{ sourceFieldId: 'missing', operator: 'is', value: 'x' }] }, 'condition source'],
    [{ conditions: [{ sourceFieldId: '__channel__', operator: 'is', value: 'sms' }] }, 'condition channel'],
    [{ actions: [{ action: 'show', targetFieldId: 'missing' }] }, 'action target'],
    [{ actions: [{ action: 'send_webhook', targetFieldId: 'company' }] }, 'action verb'],
  ])('rejects an unsafe compound logic definition: %s', (extra, _name) => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [source, company],
      logic: [{
        id: 'compound', sourceFieldId: 'kind', operator: 'equals', value: '法人',
        action: 'show', targetFieldId: 'company', ...extra,
      }],
    }));

    expect(result).toEqual({ ok: false, error: '分岐設定を読み込めません' });
  });

  test('does not require or persist a field hidden by the shared logic result', () => {
    expect(validateInternalFormAnswers([source, company], { a_0: '個人' }, {
      visibleFieldIds: ['kind'],
    })).toEqual({ ok: true, answers: { kind: '個人' }, pendingUploads: [] });
  });

  test('keeps a valid legacy text postal autofill mapping on the zip field', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.fields[0].config.postalAutofill).toEqual({
      zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town',
    });
    if (result.ok) expect(Object.keys(result.definition.fields[0].config.postalAutofill ?? {})).toEqual([
      'zipField', 'prefField', 'cityField', 'townField',
    ]);
  });

  test('keeps an exact combined postal mapping to one address field', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { mode: 'combined', zipField: 'zip', addressField: 'address' } },
        },
        { id: 'address', type: 'address', label: '住所', required: true, position: 1, config: {} },
      ],
      logic: [],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.fields[0].config.postalAutofill).toEqual({
      mode: 'combined', zipField: 'zip', addressField: 'address',
    });
    if (result.ok) expect(Object.keys(result.definition.fields[0].config.postalAutofill ?? {})).toEqual([
      'mode', 'zipField', 'addressField',
    ]);
  });

  test.each([
    ['missing target', { mode: 'combined', zipField: 'zip', addressField: 'missing' }],
    ['wrong source', { mode: 'combined', zipField: 'other-zip', addressField: 'address' }],
    ['non-address target', { mode: 'combined', zipField: 'zip', addressField: 'note' }],
    ['duplicate target', { mode: 'combined', zipField: 'zip', addressField: 'zip' }],
  ])('rejects an invalid combined postal mapping: %s', (_name, postalAutofill) => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill },
        },
        { id: 'other-zip', type: 'postal_code', label: '別の郵便番号', required: false, position: 1, config: {} },
        { id: 'address', type: 'address', label: '住所', required: true, position: 2, config: {} },
        { id: 'note', type: 'text', label: '備考', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result).toEqual({ ok: false, error: '郵便番号自動入力の項目設定が正しくありません' });
  });

  test('keeps a valid postal-code mapping to dedicated address fields', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'prefecture', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.fields[0].config.postalAutofill).toEqual({
      zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town',
    });
  });

  test('allows a native postal-code mapping to retain a text destination fallback', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref-text', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref-text', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result.ok).toBe(true);
  });

  test('allows a grandfathered text source to move its destinations to dedicated fields', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'prefecture', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result.ok).toBe(true);
  });

  test.each([
    [
      'missing target',
      { zipField: 'zip', prefField: 'missing', cityField: 'city', townField: 'town' },
    ],
    [
      'duplicate target',
      { zipField: 'zip', prefField: 'pref', cityField: 'pref', townField: 'town' },
    ],
  ])('rejects an invalid postal mapping: %s', (_name, postalAutofill) => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        { id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0, config: { postalAutofill } },
        { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result).toEqual({ ok: false, error: '郵便番号自動入力の項目設定が正しくありません' });
  });

  test('rejects a postal mapping whose destination type is incompatible with its address slot', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'dropdown', label: '都道府県', required: true, position: 1, config: { choices: ['大阪府'] } },
        { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result).toEqual({ ok: false, error: '郵便番号自動入力の項目設定が正しくありません' });
  });

  test('rejects dedicated city and street fields assigned to the wrong destination slots', () => {
    const result = parseInternalFormDefinition(JSON.stringify({
      fields: [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'town', townField: 'city' } },
        },
        { id: 'pref', type: 'prefecture', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
      ],
      logic: [],
    }));

    expect(result).toEqual({ ok: false, error: '郵便番号自動入力の項目設定が正しくありません' });
  });
});
