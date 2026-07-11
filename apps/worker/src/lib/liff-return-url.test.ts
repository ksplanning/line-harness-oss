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

  test('query/fragment に /fo/ を紛れ込ませても pathname 判定で無改変 (substring 誤判定を排除 / CX-1)', () => {
    // 旧 includes('/fo/') は ?next=/fo/ を誤検知した。pathname は /landing なので lu を付けない。
    expect(appendLineUserToReturnUrl('https://api.example.com/landing?next=/fo/y', LU)).toBe(
      'https://api.example.com/landing?next=/fo/y',
    );
    expect(appendLineUserToReturnUrl('https://api.example.com/x?fo=/fo/', LU)).toBe('https://api.example.com/x?fo=/fo/');
  });
});

describe('appendLineUserToReturnUrl — same-origin ガード (CX-1 / LINE userId 漏出防止)', () => {
  const SELF = 'https://api.example.com';

  test('別 origin の URL には lu を付与しない (pathname を /fo/ に詐称しても)', () => {
    // 攻撃者が ?redirect=https://evil.com/fo/x を仕込んでも selfOrigin 不一致で拒否 (LINE userId 非漏出)。
    expect(appendLineUserToReturnUrl('https://evil.com/fo/x', LU, SELF)).toBe('https://evil.com/fo/x');
    expect(appendLineUserToReturnUrl('https://evil.com/t/x', LU, SELF)).toBe('https://evil.com/t/x');
  });

  test('同 origin の /fo/ には lu を付与 (round-trip 維持)', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1', LU, SELF)).toBe(
      `https://api.example.com/fo/fa1?lu=${LU}`,
    );
  });

  test('同 origin の /t/ にも lu を付与 (旧 /t/ 経路も同ガード下で維持)', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/t/lnk1', LU, SELF)).toBe(
      `https://api.example.com/t/lnk1?lu=${LU}`,
    );
  });

  test('root-relative は selfOrigin で同 origin 解決され lu 付与 (相対形を保持)', () => {
    expect(appendLineUserToReturnUrl('/fo/fa1', LU, SELF)).toBe(`/fo/fa1?lu=${LU}`);
  });

  test('同 origin でも pathname が非追跡なら無改変', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/landing', LU, SELF)).toBe('https://api.example.com/landing');
  });

  test('selfOrigin 不正/解析不能は無改変 (fail-safe)', () => {
    expect(appendLineUserToReturnUrl('https://api.example.com/fo/fa1', LU, 'not-a-url')).toBe('https://api.example.com/fo/fa1');
    expect(appendLineUserToReturnUrl('::::bad', LU, SELF)).toBe('::::bad');
  });
});
