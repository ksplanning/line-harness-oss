import { describe, expect, test } from 'vitest';
import { expandVariables } from './step-delivery.js';

const friend = {
  id: 'friend-1',
  display_name: '山田花子',
  user_id: 'user-1',
  ref_code: '紹介A',
  metadata: {
    回答: 'はい',
    興味: ['新商品', 'セール'],
    空欄: '',
  },
};

describe('expandVariables regression and personalization bridge', () => {
  test('keeps every legacy variable and conditional behavior unchanged', () => {
    expect(expandVariables(
      '{{name}}/{{uid}}/{{friend_id}}/{{ref}} '
        + '{{#if_ref}}refあり{{/if_ref}} '
        + '{{metadata.回答}}/{{metadata.興味}} '
        + '{{#if_metadata.回答}}回答あり{{/if_metadata.回答}}'
        + '{{#if_metadata.空欄}}表示しない{{/if_metadata.空欄}}',
      friend,
    )).toBe('山田花子/user-1/friend-1/紹介A refあり はい/新商品, セール 回答あり');

    expect(expandVariables(
      '前{{#if_ref}}refあり{{/if_ref}}後',
      { ...friend, ref_code: null },
    )).toBe('前後');
  });

  test('keeps the legacy auth URL shape and query values', () => {
    expect(expandVariables(
      '{{auth_url:channel 1}}',
      friend,
      'https://worker.example',
    )).toBe('https://worker.example/auth/line?account=channel+1&ref=cross-link&uid=user-1');
  });

  test('renders display_name through the common synchronous route without re-evaluating its value', () => {
    expect(expandVariables(
      '{{display_name|お客様}} / {{field:会員ランク}}',
      { ...friend, display_name: '{{field:会員ランク}}' },
    )).toBe('{{field:会員ランク}} / {{field:会員ランク}}');
  });

  test('keeps variable-free Unicode text byte-for-byte identical', () => {
    const content = '通常のステップ本文 😊\n2行目✨';
    const expanded = expandVariables(content, friend, 'https://worker.example');

    expect(expanded).toBe(content);
    expect(new TextEncoder().encode(expanded)).toEqual(new TextEncoder().encode(content));
  });
});
