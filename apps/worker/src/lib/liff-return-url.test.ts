import { describe, expect, test } from 'vitest';
import { appendLineUserToReturnUrl } from './liff-return-url.js';

// =============================================================================
// F-1 — LIFF 復路 URL への lu 付与 (無限ループ回避の要)。
//   /fo/:id 復路に lu が付かないと LINE in-app で LIFF 分岐が再発火し無限ループ (reviewer F-1 critical)。
// =============================================================================

const LU = 'U1234567890abcdef';

describe('appendLineUserToReturnUrl (F-1)', () => {
  test('/fo/:id 復路に lu を付与 (無限ループ回避の要)', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1', LU)).toBe(
      `https://api.example.com/fo/fa1?lu=${LU}`,
    );
  });

  test('/t/:id 復路にも従来どおり lu を付与 (回帰なし)', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/t/lnk1', LU)).toBe(
      `https://api.example.com/t/lnk1?lu=${LU}`,
    );
  });

  test('既存 query があれば & で連結', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1?foo=1', LU)).toBe(
      `https://api.example.com/fo/fa1?foo=1&lu=${LU}`,
    );
  });

  test('lineUserId は encodeURIComponent される', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1', 'a b/c')).toBe(
      'https://api.example.com/fo/fa1?lu=a%20b%2Fc',
    );
  });

  test('追跡経路でない URL は無改変 (不要な lu を付けない)', () => {
    expect(appendLineUserToReturnUrl('https://example.com/landing', LU)).toBe('https://example.com/landing');
  });

  test('空入力は無改変 (fail-safe)', () => {
    expect(appendLineUserToReturnUrl('', LU)).toBe('');
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1', '')).toBe('https://api.example.com/fo/fa1');
  });
});
