/**
 * route-terminal-phase2 (T-B1) — worker redirect push helpers。
 *  - redirectFields: FormRedirect の present key を Formaloo form 直キー
 *    ({form_redirects_after_submit, include_data_on_redirect}) へ写像 (url 未設定なら送らない)。
 *    url は buildRedirectTargetUrl で openExternalBrowser=1 を付与済の最終 target を載せる (M8)。
 *  - confirmRedirectReflected: meta PATCH 後 GET-after-PATCH で form_redirects_after_submit の反映を
 *    bounded retry 確認 (soft-200 対策)。不一致は ok:false (route が out_of_sync)。
 * formaloo-copy.ts (form-jp-localization) を写経元にした file-disjoint な専用 helper。
 */
import { describe, expect, it } from 'vitest';
import { redirectFields, confirmRedirectReflected } from './formaloo-redirect.js';
import type { FormalooClient } from './formaloo-client.js';

/** request だけ実装した最小 mock client (confirm は client.request('GET', ...) しか使わない)。 */
function mockClient(responder: (method: string, path: string) => { ok: boolean; status: number; data?: unknown }): FormalooClient {
  return {
    request: async (method: string, path: string) => responder(method, path),
  } as unknown as FormalooClient;
}

const noSleep = async () => {};

describe('redirectFields — present-key 写像', () => {
  it('url + openExternalBrowser=true → form_redirects_after_submit に openExternalBrowser=1 付与済 URL', () => {
    const out = redirectFields({ url: 'https://example.com/lp', openExternalBrowser: true });
    expect(out.form_redirects_after_submit).toBe('https://example.com/lp?openExternalBrowser=1');
    expect('include_data_on_redirect' in out).toBe(false);
  });

  it('url + openExternalBrowser=false → 素の URL (param 無し)', () => {
    const out = redirectFields({ url: 'https://example.com/lp', openExternalBrowser: false });
    expect(out.form_redirects_after_submit).toBe('https://example.com/lp');
  });

  it('url 未設定 → form_redirects_after_submit を送らない', () => {
    expect(redirectFields({ openExternalBrowser: true })).toEqual({});
    expect(redirectFields({})).toEqual({});
    expect(redirectFields(undefined)).toEqual({});
    expect(redirectFields(null)).toEqual({});
  });

  it('includeData present → include_data_on_redirect に写像 (reserved key)', () => {
    const out = redirectFields({ url: 'https://example.com/lp', includeData: true });
    expect(out.include_data_on_redirect).toBe(true);
    expect(out.form_redirects_after_submit).toBe('https://example.com/lp');
  });
});

describe('confirmRedirectReflected — GET-after-PATCH soft-200 対策', () => {
  it('送る url が無ければ GET せず ok:true (確認対象なし)', async () => {
    let gets = 0;
    const client = mockClient((m) => { if (m === 'GET') gets++; return { ok: true, status: 200, data: {} }; });
    const r = await confirmRedirectReflected(client, 'SLUG', {});
    expect(r.ok).toBe(true);
    expect(gets).toBe(0);
  });

  it('GET で form_redirects_after_submit が一致 → ok:true', async () => {
    const client = mockClient(() => ({
      ok: true, status: 200,
      data: { data: { form: { form_redirects_after_submit: 'https://example.com/lp?openExternalBrowser=1' } } },
    }));
    const r = await confirmRedirectReflected(client, 'SLUG', { url: 'https://example.com/lp', openExternalBrowser: true });
    expect(r.ok).toBe(true);
  });

  it('GET で不一致 (soft-200 無言無視) → ok:false + error', async () => {
    const client = mockClient(() => ({
      ok: true, status: 200, data: { data: { form: { form_redirects_after_submit: null } } },
    }));
    const r = await confirmRedirectReflected(client, 'SLUG', { url: 'https://example.com/lp' }, { retries: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
  });

  it('bounded retry: N 回目で反映 → ok:true (eventual consistency)', async () => {
    let n = 0;
    const client = mockClient(() => {
      n++;
      return { ok: true, status: 200, data: { data: { form: { form_redirects_after_submit: n >= 2 ? 'https://example.com/lp' : null } } } };
    });
    const r = await confirmRedirectReflected(client, 'SLUG', { url: 'https://example.com/lp' }, { retries: 2, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('URL 正規化耐性: trailing slash 差だけは一致扱い (Formaloo canonicalize)', async () => {
    const client = mockClient(() => ({
      ok: true, status: 200, data: { data: { form: { form_redirects_after_submit: 'https://example.com/' } } },
    }));
    const r = await confirmRedirectReflected(client, 'SLUG', { url: 'https://example.com' });
    expect(r.ok).toBe(true);
  });

  it('GET 失敗 → ok:false (fail-closed)', async () => {
    const client = mockClient(() => ({ ok: false, status: 500 }));
    const r = await confirmRedirectReflected(client, 'SLUG', { url: 'https://example.com/lp' }, { retries: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
  });
});
