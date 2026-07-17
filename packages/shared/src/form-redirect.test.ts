/**
 * route-terminal-phase2 (T-A1) — FormRedirect 契約 + validateRedirectUrl / buildRedirectTargetUrl /
 *   normalizeFormRedirect の https-only 検証・openExternalBrowser 付与・whitelist 正規化を封鎖。
 *  - spike M7 実測: Formaloo server は javascript:/data:/ftp:/protocol-relative を無検証で STORE する
 *    → harness 側で https-only 検証を MUST 化 (server は守ってくれない)。
 *  - spike M8: openExternalBrowser=1 は LINE 公式 (LIFF 除く) で redirect URL に決定的付与可。
 *  - CX-9 phishing 面: userinfo 付き URL (https://user:pass@host) を拒否。
 * form-copy.test.ts の写経元 (additive-optional / whitelist / 空 drop)。
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_REDIRECT_KEYS,
  FORM_REDIRECT_TO_FORMALOO,
  validateRedirectUrl,
  buildRedirectTargetUrl,
  normalizeFormRedirect,
  type FormRedirect,
} from './form-redirect';

describe('FORM_REDIRECT_KEYS / FORM_REDIRECT_TO_FORMALOO (canonical 契約)', () => {
  it('canonical key は 3 種 (url/openExternalBrowser/includeData) で順序安定', () => {
    expect(FORM_REDIRECT_KEYS).toEqual(['url', 'openExternalBrowser', 'includeData']);
  });

  it('url/includeData は Formaloo form 直フィールド名へ写像する', () => {
    expect(FORM_REDIRECT_TO_FORMALOO.url).toBe('form_redirects_after_submit');
    expect(FORM_REDIRECT_TO_FORMALOO.includeData).toBe('include_data_on_redirect');
  });
});

describe('validateRedirectUrl — https-only 検証 (M7: server は守ってくれない)', () => {
  it('https URL は通過し trim 済 url を返す', () => {
    const r = validateRedirectUrl('  https://example.com/lp?utm=x  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/lp?utm=x');
  });

  it('javascript: を拒否する (XSS スキーム)', () => {
    expect(validateRedirectUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('data: を拒否する', () => {
    expect(validateRedirectUrl('data:text/html,x').ok).toBe(false);
  });

  it('http: を拒否する (https 固定)', () => {
    expect(validateRedirectUrl('http://example.com').ok).toBe(false);
  });

  it('ftp: を拒否する', () => {
    expect(validateRedirectUrl('ftp://example.com/f').ok).toBe(false);
  });

  it('protocol-relative (//host) を拒否する', () => {
    expect(validateRedirectUrl('//evil.example.com/lp').ok).toBe(false);
  });

  it('パース不能な文字列を拒否する', () => {
    expect(validateRedirectUrl('not a url at all').ok).toBe(false);
    expect(validateRedirectUrl('https://').ok).toBe(false);
  });

  it('userinfo 付き URL (https://user:pass@host) を拒否する (CX-9 phishing 面)', () => {
    expect(validateRedirectUrl('https://user:pass@example.com/lp').ok).toBe(false);
    expect(validateRedirectUrl('https://user@example.com/lp').ok).toBe(false);
  });

  it('2048 文字超過を拒否する', () => {
    const long = 'https://example.com/' + 'a'.repeat(2100);
    expect(validateRedirectUrl(long).ok).toBe(false);
  });

  it('非 string / 空文字を拒否する', () => {
    expect(validateRedirectUrl(123 as unknown).ok).toBe(false);
    expect(validateRedirectUrl('').ok).toBe(false);
    expect(validateRedirectUrl('   ').ok).toBe(false);
    expect(validateRedirectUrl(null as unknown).ok).toBe(false);
  });

  it('openExternalBrowser 付与後に 2048 超過する URL を拒否する (CX-6)', () => {
    // 付与前は 2048 以内・付与後 (openExternalBrowser=1 の 22 byte) で超過する境界。
    const base = 'https://example.com/lp?p=' + 'a'.repeat(2048 - 'https://example.com/lp?p='.length);
    expect(base.length).toBeLessThanOrEqual(2048);
    expect(validateRedirectUrl(base).ok).toBe(true); // 付与しなければ OK
    expect(validateRedirectUrl(base, { openExternalBrowser: true }).ok).toBe(false); // 付与後超過
  });
});

describe('buildRedirectTargetUrl — openExternalBrowser=1 の URL 構造付与 (M8)', () => {
  it('openExternalBrowser=true で openExternalBrowser=1 を URLSearchParams で set する', () => {
    const out = buildRedirectTargetUrl('https://example.com/lp', true);
    expect(out).toContain('openExternalBrowser=1');
    expect(new URL(out).searchParams.get('openExternalBrowser')).toBe('1');
  });

  it('既存 query を保持し openExternalBrowser を追加する (?/& 処理)', () => {
    const out = buildRedirectTargetUrl('https://example.com/lp?utm=x', true);
    const u = new URL(out);
    expect(u.searchParams.get('utm')).toBe('x');
    expect(u.searchParams.get('openExternalBrowser')).toBe('1');
  });

  it('#fragment を保持し query が fragment 後に来ない', () => {
    const out = buildRedirectTargetUrl('https://example.com/lp?a=1#section', true);
    expect(out.indexOf('openExternalBrowser=1')).toBeLessThan(out.indexOf('#section'));
    expect(out).toContain('#section');
    expect(new URL(out).hash).toBe('#section');
  });

  it('既存 openExternalBrowser=0 を 1 に上書きし二重付与しない', () => {
    const out = buildRedirectTargetUrl('https://example.com/lp?openExternalBrowser=0', true);
    const matches = out.match(/openExternalBrowser=/g) ?? [];
    expect(matches.length).toBe(1);
    expect(new URL(out).searchParams.get('openExternalBrowser')).toBe('1');
  });

  it('openExternalBrowser=false/undefined では付与せず url をそのまま返す', () => {
    expect(buildRedirectTargetUrl('https://example.com/lp', false)).toBe('https://example.com/lp');
    expect(buildRedirectTargetUrl('https://example.com/lp')).toBe('https://example.com/lp');
    expect(buildRedirectTargetUrl('https://example.com/lp', false)).not.toContain('openExternalBrowser');
  });
});

describe('normalizeFormRedirect — whitelist / trim / 検証失敗 drop', () => {
  it('有効 https url を trim して保持する', () => {
    const out = normalizeFormRedirect({ url: '  https://example.com/lp  ', openExternalBrowser: true });
    expect(out).toEqual({ url: 'https://example.com/lp', openExternalBrowser: true });
  });

  it('未知キーを drop する (whitelist)', () => {
    const out = normalizeFormRedirect({ url: 'https://example.com/lp', evil: 'x', __proto__: 'y' } as Record<string, unknown>);
    expect(out).toEqual({ url: 'https://example.com/lp' });
    expect('evil' in out).toBe(false);
  });

  it('非 string url は drop し {} を返す', () => {
    expect(normalizeFormRedirect({ url: 123 } as unknown)).toEqual({});
  });

  it('空 / 検証失敗 url は drop し {} を返す (openExternalBrowser 単独は無意味 = 落とす)', () => {
    expect(normalizeFormRedirect({ url: '' })).toEqual({});
    expect(normalizeFormRedirect({ url: '   ' })).toEqual({});
    expect(normalizeFormRedirect({ url: 'javascript:alert(1)' })).toEqual({});
    expect(normalizeFormRedirect({ url: 'http://x.com' })).toEqual({});
    expect(normalizeFormRedirect({ openExternalBrowser: true })).toEqual({});
  });

  it('includeData は boolean のみ保持 (reserved / router 接続点)', () => {
    expect(normalizeFormRedirect({ url: 'https://example.com/lp', includeData: true }))
      .toEqual({ url: 'https://example.com/lp', includeData: true });
    expect(normalizeFormRedirect({ url: 'https://example.com/lp', includeData: 'yes' } as unknown))
      .toEqual({ url: 'https://example.com/lp' });
  });

  it('非 object 入力 (null / array / string) は {} を返す', () => {
    expect(normalizeFormRedirect(null)).toEqual({});
    expect(normalizeFormRedirect(undefined)).toEqual({});
    expect(normalizeFormRedirect([])).toEqual({});
    expect(normalizeFormRedirect('https://example.com')).toEqual({});
  });

  it('返り値は FormRedirect 型に代入可能 (型契約)', () => {
    const out: FormRedirect = normalizeFormRedirect({ url: 'https://example.com/lp' });
    expect(out.url).toBe('https://example.com/lp');
  });
});
