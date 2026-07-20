import { describe, expect, test } from 'vitest';
import { renderMessageContent } from './render-message.js';

describe('renderMessageContent', () => {
  test('replaces {{liff_id}} with given liffId', () => {
    expect(renderMessageContent('hello https://liff.line.me/{{liff_id}}/x', '12345-AAA'))
      .toBe('hello https://liff.line.me/12345-AAA/x');
  });

  test('replaces all occurrences', () => {
    expect(renderMessageContent('a={{liff_id}} b={{liff_id}}', 'X'))
      .toBe('a=X b=X');
  });

  test('returns input unchanged when no placeholder', () => {
    expect(renderMessageContent('no placeholder', 'X')).toBe('no placeholder');
  });

  test('returns input unchanged when liffId is null', () => {
    expect(renderMessageContent('a {{liff_id}} b', null)).toBe('a {{liff_id}} b');
  });

  test('returns input unchanged when liffId is empty string', () => {
    expect(renderMessageContent('a {{liff_id}} b', '')).toBe('a {{liff_id}} b');
  });

  test('handles event path embedded in URL template', () => {
    const tpl = 'イベント詳細→ https://liff.line.me/{{liff_id}}/?page=event&id=evt-1';
    expect(renderMessageContent(tpl, 'LIFF-9999')).toBe(
      'イベント詳細→ https://liff.line.me/LIFF-9999/?page=event&id=evt-1',
    );
  });

  test('replaces display name and uses an explicit fallback when it is unavailable', () => {
    expect(renderMessageContent(
      'こんにちは {{display_name}}さん / {{display_name|お客様}}',
      null,
      { displayName: '山田花子' },
    )).toBe('こんにちは 山田花子さん / 山田花子');

    expect(renderMessageContent(
      'こんにちは {{display_name}}さん / {{display_name|お客様}}',
      null,
      { displayName: null },
    )).toBe('こんにちは さん / お客様');
  });

  test('replaces defined custom fields, including empty and non-string values', () => {
    expect(renderMessageContent(
      '{{field:会員ランク}} / {{field:担当者}} / {{field:来店回数}} / {{field:興味}}',
      null,
      {
        customFields: {
          会員ランク: 'ゴールド',
          担当者: '',
          来店回数: 3,
          興味: ['新商品', 'セール'],
        },
      },
    )).toBe('ゴールド /  / 3 / 新商品, セール');
  });

  test('leaves unknown variables and undefined custom fields unchanged', () => {
    expect(renderMessageContent(
      '{{unknown}} {{field:未定義}} {{display_name}}',
      null,
      { displayName: '山田', customFields: { 会員ランク: 'ゴールド' } },
    )).toBe('{{unknown}} {{field:未定義}} 山田');
  });

  test('does not scan known tokens nested inside an unknown token', () => {
    expect(renderMessageContent(
      '{{unknown {{field:A}}}} / {{field:A}}',
      null,
      { customFields: { A: 'VALUE' } },
    )).toBe('{{unknown {{field:A}}}} / VALUE');
  });

  test('keeps legacy liff_id replacement inside otherwise unknown syntax', () => {
    expect(renderMessageContent(
      '{{unknown {{liff_id}}}} / {{liff_id}}',
      'LIFF-1',
      { customFields: { A: 'VALUE' } },
    )).toBe('{{unknown LIFF-1}} / LIFF-1');
  });

  test('keeps a missing display-name context untouched while rendering provided fields', () => {
    expect(renderMessageContent(
      '{{display_name|お客様}} / {{field:会員ランク}}',
      null,
      { customFields: { 会員ランク: 'ゴールド' } },
    )).toBe('{{display_name|お客様}} / ゴールド');
  });

  test('inserts recipient values literally without replacement-token or recursive expansion', () => {
    expect(renderMessageContent(
      '{{display_name}} / {{field:A}} / {{field:B}} / {{field:C}} / {{field:D}}',
      null,
      {
        displayName: '{{field:A}}',
        customFields: {
          A: '$& VIP',
          B: '$$',
          C: '$` and $\'',
          D: '{{display_name}}',
        },
      },
    )).toBe('{{field:A}} / $& VIP / $$ / $` and $\' / {{display_name}}');
  });

  test('renders an array with no printable values as empty', () => {
    expect(renderMessageContent(
      '{{field:興味}} / {{field:空要素}}',
      null,
      { customFields: { 興味: [], 空要素: ['', null] } },
    )).toBe(' / ');
  });

  test('matches custom field names literally even when they contain token delimiters', () => {
    expect(renderMessageContent(
      '{{field:会員|区分}} / {{field:備考}欄}} / {{field:会員|区分|一般}}',
      null,
      {
        customFields: {
          '会員|区分': '',
          '備考}欄': '確認済み',
        },
      },
    )).toBe(' / 確認済み / {{field:会員|区分|一般}}');
  });

  test('does not reinterpret an undefined delimiter name as a shorter field plus fallback', () => {
    expect(renderMessageContent(
      '{{field:会員|区分}} / {{field:会員}}',
      null,
      { customFields: { 会員: 'VIP' } },
    )).toBe('{{field:会員|区分}} / VIP');
  });

  test('does not consume recipient variables when recipient context is absent', () => {
    expect(renderMessageContent(
      '{{display_name}} {{field:会員ランク}} {{liff_id}}',
      'LIFF-1',
    )).toBe('{{display_name}} {{field:会員ランク}} LIFF-1');
  });

  test('keeps variable-free Unicode text byte-for-byte identical', () => {
    const content = 'こんにちは😊\nそのままの本文です✨';
    const rendered = renderMessageContent(content, 'LIFF-1', {
      displayName: '未使用',
      customFields: { 会員ランク: '未使用' },
    });

    expect(rendered).toBe(content);
    expect(new TextEncoder().encode(rendered)).toEqual(new TextEncoder().encode(content));
  });
});
