/**
 * form-design worker push helpers。
 *  - designColorFields: FormDesign(canonical hex)→ Formaloo form 直フィールド (present key のみ / update 意味論)。
 *  - confirmDesignReflected: meta PATCH 後に GET-after-PATCH で反映を確認 (soft-200 対策)。
 *  - applyDesignImages: keep/replace/remove intent → multipart(replace)+ JSON null(remove)。
 * spike(design-hosted-apply-fix 2026-07-17): hosted 公開ページは flat 色を **JSON-string RGBA** 形式
 *   ('{"r":..,"g":..,"b":..,"a":1}') で受けたときのみ描画する。hex はデータ層に round-trip するが
 *   hosted app が parse できず既定色にフォールバックする (= 従来の非反映バグの真因)。
 */
import { describe, test, expect, vi } from 'vitest';
import { designColorFields, confirmDesignReflected, applyDesignImages } from './formaloo-design';
import { defaultFormDesign, FORM_DESIGN_TO_FORMALOO, FORM_DESIGN_COLOR_KEYS } from '@line-crm/shared';
import type { FormDesign, FormDesignImages } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

/** spike 確定: hosted が parse する形式 = JSON.stringify({r,g,b,a:1})。 */
function jrgba(hex: string): string {
  const h = hex.replace('#', '');
  return JSON.stringify({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 });
}

function okForm(form: Record<string, unknown>) {
  return { ok: true as const, status: 200, data: { data: { form } } };
}

function failRes(status = 500) {
  return { ok: false as const, status, error: `HTTP ${status}` };
}
function mockClient(opts: { multipartFails?: boolean; removeFails?: boolean } = {}) {
  const requestForm = vi.fn(async () => (opts.multipartFails ? failRes() : okForm({ logo: 'https://s3/new-logo.png', background_image: 'https://s3/new-bg.png' })));
  const request = vi.fn(async () => (opts.removeFails ? failRes() : okForm({})));
  return { requestForm, request } as unknown as FormalooClient & { requestForm: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
}

describe('designColorFields (色 push body / update 意味論 / JSON-string RGBA)', () => {
  test('present な色役割のみ Formaloo フィールド名 + JSON-string RGBA に map、theme_name も', () => {
    const design: FormDesign = { themeColor: '#06C755', buttonColor: '#06C755', themeName: 'brand' };
    expect(designColorFields(design)).toEqual({ theme_color: jrgba('#06C755'), button_color: jrgba('#06C755'), theme_name: 'brand' });
  });

  test('値は JSON.parse 可能な RGBA object 文字列 (hosted が parse できる形式・hex ではない)', () => {
    const out = designColorFields({ buttonColor: '#06C755' });
    expect(out.button_color).not.toMatch(/^#/);
    expect(JSON.parse(out.button_color)).toEqual({ r: 6, g: 199, b: 85, a: 1 });
  });

  test('空 design / undefined / null は空 object (何も PATCH しない = 未変更)', () => {
    expect(designColorFields({})).toEqual({});
    expect(designColorFields(undefined)).toEqual({});
    expect(designColorFields(null)).toEqual({});
  });

  test('不正 hex 値は skip (壊れた色を push しない)', () => {
    expect(designColorFields({ buttonColor: 'not-a-hex' } as FormDesign)).toEqual({});
  });

  test('全 7 色役割を JSON-string RGBA で map できる', () => {
    const design: FormDesign = {
      themeColor: '#111111', backgroundColor: '#222222', buttonColor: '#333333', textColor: '#444444',
      fieldColor: '#555555', borderColor: '#666666', submitTextColor: '#777777',
    };
    expect(designColorFields(design)).toEqual({
      theme_color: jrgba('#111111'), background_color: jrgba('#222222'), button_color: jrgba('#333333'),
      text_color: jrgba('#444444'), field_color: jrgba('#555555'), border_color: jrgba('#666666'),
      submit_text_color: jrgba('#777777'),
    });
  });

  // T-B3 / T-B1: create-seed した既定 design が実際に Formaloo hosted へ色を運ぶこと (7 field 非空 JSON-string RGBA)
  // を unit で封鎖し、逆に既存 null 経路 (design:{}) は色 0 push であることを固定する。
  test('designColorFields(defaultFormDesign()) は 7 Formaloo field を全て JSON-string RGBA で返す (seed→push 到達)', () => {
    const out = designColorFields(defaultFormDesign());
    const expectedFields = FORM_DESIGN_COLOR_KEYS.map((k) => FORM_DESIGN_TO_FORMALOO[k]);
    for (const field of expectedFields) {
      const parsed = JSON.parse(out[field]) as Record<string, number>;
      expect(parsed).toMatchObject({ r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), a: 1 });
    }
    // theme_name / presetId は色 field でないので混ざらない (色 field はちょうど 7 個)。
    expect(Object.keys(out).sort()).toEqual([...expectedFields].sort());
  });

  test('designColorFields({}) は {} (既存 design=null 経路は色 push 0 = 不可触)', () => {
    expect(designColorFields({})).toEqual({});
  });
});

describe('confirmDesignReflected (soft-200 対策 GET-after-PATCH)', () => {
  // remote GET は保存後の値を JSON-string RGBA で返す (spike 実測)。formalooColorToHex 正規化で期待 hex と比較。
  function getClient(remote: Record<string, unknown>, fail = false) {
    const request = vi.fn(async (method: string) => {
      if (method === 'GET') return fail ? failRes(500) : okForm(remote);
      return okForm({});
    });
    return { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
  }
  const noSleep = () => Promise.resolve();

  test('remote が期待色に一致 → ok:true', async () => {
    const c = getClient({ button_color: jrgba('#06C755'), text_color: jrgba('#17352A') });
    const r = await confirmDesignReflected(c, 'slugX', { buttonColor: '#06C755', textColor: '#17352A' }, { retries: 0, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(c.request).toHaveBeenCalledWith('GET', '/v3.0/forms/slugX/');
  });

  test('remote が期待色と不一致 (soft-200 で無言無視されたケース) → ok:false + error', async () => {
    // remote は依然 hex (= 反映されていない = 従来バグ)。期待 hex と正規化一致するが hosted 描画不能形式。
    const c = getClient({ button_color: '#E56970' }); // 期待 #06C755 と別色
    const r = await confirmDesignReflected(c, 'slugY', { buttonColor: '#06C755' }, { retries: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
  });

  test('色なし design は確認スキップ (ok:true / GET しない)', async () => {
    const c = getClient({});
    const r = await confirmDesignReflected(c, 'slugZ', { themeName: 'brand' }, { retries: 0, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(c.request).not.toHaveBeenCalled();
  });

  test('bounded retry: 途中不一致→最終一致で ok:true', async () => {
    let call = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== 'GET') return okForm({});
      call += 1;
      return call < 2 ? okForm({ button_color: '#000000' }) : okForm({ button_color: jrgba('#06C755') });
    });
    const c = { request } as unknown as FormalooClient & { request: ReturnType<typeof vi.fn> };
    const r = await confirmDesignReflected(c, 'slugR', { buttonColor: '#06C755' }, { retries: 2, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(call).toBe(2);
  });
});

describe('applyDesignImages (画像 intent → Formaloo)', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  test('replace は multipart PATCH (logo→logo / cover→background_image) で送り URL を返す', async () => {
    const c = mockClient();
    const images: FormDesignImages = {
      logo: { intent: 'replace', dataUrl, mimeType: 'image/png', filename: 'l.png' },
      cover: { intent: 'replace', dataUrl, mimeType: 'image/png', filename: 'c.png' },
    };
    const r = await applyDesignImages(c, 'slug1', images);
    expect(c.requestForm).toHaveBeenCalledTimes(1);
    const [, path, form] = c.requestForm.mock.calls[0];
    expect(path).toBe('/v3.0/forms/slug1/');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).has('logo')).toBe(true);
    expect((form as FormData).has('background_image')).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.logoUrl).toBe('https://s3/new-logo.png');
    expect(r.backgroundImageUrl).toBe('https://s3/new-bg.png');
    expect(c.request).not.toHaveBeenCalled();
  });

  test('remove は JSON PATCH {field:null} で送り URL を null にする', async () => {
    const c = mockClient();
    const images: FormDesignImages = { logo: { intent: 'remove' }, cover: { intent: 'remove' } };
    const r = await applyDesignImages(c, 'slug2', images);
    expect(c.request).toHaveBeenCalledTimes(1);
    const [method, path, body] = c.request.mock.calls[0];
    expect(method).toBe('PATCH');
    expect(path).toBe('/v3.0/forms/slug2/');
    expect(body).toEqual({ logo: null, background_image: null });
    expect(r.ok).toBe(true);
    expect(r.logoUrl).toBeNull();
    expect(r.backgroundImageUrl).toBeNull();
    expect(c.requestForm).not.toHaveBeenCalled();
  });

  test('keep / 空は何も送らない (ok:true / no-op)', async () => {
    const c = mockClient();
    expect(await applyDesignImages(c, 'slug3', { logo: { intent: 'keep' } })).toEqual({ ok: true });
    expect(await applyDesignImages(c, 'slug3', {})).toEqual({ ok: true });
    expect(c.requestForm).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
  });

  test('replace + remove 混在は multipart と JSON の両方を送る', async () => {
    const c = mockClient();
    const images: FormDesignImages = { logo: { intent: 'replace', dataUrl, mimeType: 'image/png' }, cover: { intent: 'remove' } };
    const r = await applyDesignImages(c, 'slug4', images);
    expect(c.requestForm).toHaveBeenCalledTimes(1);
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(c.request.mock.calls[0][2]).toEqual({ background_image: null });
    expect(r.ok).toBe(true);
    expect(r.logoUrl).toBe('https://s3/new-logo.png');
    expect(r.backgroundImageUrl).toBeNull();
  });

  test('不正 dataUrl の replace は ok:false (silent success にしない / F1)', async () => {
    const c = mockClient();
    const r = await applyDesignImages(c, 'slug5', { logo: { intent: 'replace', dataUrl: 'not-a-data-url' } });
    expect(c.requestForm).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
  });

  test('F1: multipart replace が非 ok なら ok:false・URL 未確定 (silent success 禁止)', async () => {
    const c = mockClient({ multipartFails: true });
    const r = await applyDesignImages(c, 'slug6', { logo: { intent: 'replace', dataUrl, mimeType: 'image/png' } });
    expect(c.requestForm).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
    expect('logoUrl' in r).toBe(false); // 失敗 slot の URL は確定しない (D1 は prev を維持)
  });

  test('F1: JSON remove が非 ok なら ok:false', async () => {
    const c = mockClient({ removeFails: true });
    const r = await applyDesignImages(c, 'slug7', { cover: { intent: 'remove' } });
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect('backgroundImageUrl' in r).toBe(false);
  });
});
