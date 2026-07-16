/**
 * form-design worker push helpers。
 *  - designColorFields: FormDesign(canonical hex)→ Formaloo form 直フィールド (present key のみ / update 意味論)。
 *  - applyDesignImages: keep/replace/remove intent → multipart(replace)+ JSON null(remove)。
 * live-probe(2026-07-16): 色は hex 文字列で round-trip・画像は logo/background_image のみ書ける・
 *   remove は JSON {field:null}(空文字は 400)。
 */
import { describe, test, expect, vi } from 'vitest';
import { designColorFields, applyDesignImages } from './formaloo-design';
import type { FormDesign, FormDesignImages } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

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

describe('designColorFields (色 push body / update 意味論)', () => {
  test('present な色役割のみ Formaloo フィールド名 + hex に map、theme_name も', () => {
    const design: FormDesign = { themeColor: '#06C755', buttonColor: '#06C755', themeName: 'brand' };
    expect(designColorFields(design)).toEqual({ theme_color: '#06C755', button_color: '#06C755', theme_name: 'brand' });
  });
  test('空 design は空 object (何も PATCH しない = 未変更)', () => {
    expect(designColorFields({})).toEqual({});
    expect(designColorFields(undefined as unknown as FormDesign)).toEqual({});
  });
  test('全 7 色役割を map できる', () => {
    const design: FormDesign = {
      themeColor: '#111111', backgroundColor: '#222222', buttonColor: '#333333', textColor: '#444444',
      fieldColor: '#555555', borderColor: '#666666', submitTextColor: '#777777',
    };
    expect(designColorFields(design)).toEqual({
      theme_color: '#111111', background_color: '#222222', button_color: '#333333', text_color: '#444444',
      field_color: '#555555', border_color: '#666666', submit_text_color: '#777777',
    });
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
