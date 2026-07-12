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

describe('appendLineUserToReturnUrl — configured WORKER origin アンカー (CX-1 wire / 本番トポロジ実測)', () => {
  // 本番 KS: client は cross-origin (…-liff.pages.dev) で配信され、追跡経路 /fo/:id は WORKER origin
  // (…workers.dev) に在る。client が selfOrigin として渡すのは WORKER canonical origin であって
  // window.location.origin(=pages.dev) ではない (pages.dev を渡すと legit worker URL を弾き F-1 復路が壊れる)。
  const WORKER = 'https://line-harness-ks.web-8af.workers.dev';

  test('legit な worker /fo/:id 復路は lu を維持 (3-hop round-trip 非退行)', () => {
    expect(appendLineUserToReturnUrl(`${WORKER}/fo/fa_abc`, LU, WORKER)).toBe(
      `${WORKER}/fo/fa_abc?lu=${LU}`,
    );
  });

  test('legit な worker /t/:id 復路も lu を維持 (旧 tracked-links 経路 非退行)', () => {
    expect(appendLineUserToReturnUrl(`${WORKER}/t/lnk_1`, LU, WORKER)).toBe(
      `${WORKER}/t/lnk_1?lu=${LU}`,
    );
  });

  test('攻撃者 origin (evil.com/fo/x forward-slash) には lu を付けない (LINE userId 非漏出)', () => {
    expect(appendLineUserToReturnUrl('https://evil.com/fo/x', LU, WORKER)).toBe('https://evil.com/fo/x');
  });

  test('backslash 正規化形 (Codex P1) も origin 不一致で lu を付けない', () => {
    // URL parser は authority 直後の backslash を `/` に正規化する → origin=evil.example ≠ worker origin。
    const back = 'https://evil.example\\fo\\x';
    const got = appendLineUserToReturnUrl(back, LU, WORKER);
    // origin が worker と不一致なので無改変 (lu を含まない = 漏出しない)。
    expect(got).not.toContain(`lu=${LU}`);
    expect(new URL(got).origin).toBe('https://evil.example');
  });

  test('protocol-relative //evil.example/fo/x も worker origin 不一致で無改変', () => {
    // selfOrigin を base に解決 → //evil.example は別 authority → origin 不一致 → lu 無し。
    const got = appendLineUserToReturnUrl('//evil.example/fo/x', LU, WORKER);
    expect(got).not.toContain(`lu=${LU}`);
  });

  test('worker origin 詐称を狙った userinfo 混入 (workers.dev@evil.example) も lu を付けない', () => {
    // `https://line-harness-ks.web-8af.workers.dev@evil.example/fo/x` の実 host は evil.example。
    const spoof = 'https://line-harness-ks.web-8af.workers.dev@evil.example/fo/x';
    const got = appendLineUserToReturnUrl(spoof, LU, WORKER);
    expect(got).not.toContain(`lu=${LU}`);
  });

  test('WORKER origin 未設定 (selfOrigin undefined) は pathname 判定に縮退 = 復路は壊さない (fail-safe)', () => {
    // build env 未注入時: legit worker 復路は絶対 URL の pathname 前方一致で従来どおり lu 付与され round-trip は維持。
    expect(appendLineUserToReturnUrl(`${WORKER}/fo/fa_abc`, LU, undefined)).toBe(
      `${WORKER}/fo/fa_abc?lu=${LU}`,
    );
  });
});
