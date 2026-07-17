import { describe, it, expect, vi } from 'vitest';
import { uploadImageDataUrlToR2, resolveInBodyImageUploads } from './form-image-upload.js';
import { buildImageDescriptionHtml, fromFormalooField, toFormalooFieldPayload, type HarnessField } from '@line-crm/shared';

const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgo=';
const mockR2 = () => {
  const puts: Array<{ key: string; size: number; contentType?: string }> = [];
  const IMAGES = { put: vi.fn(async (key: string, data: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
    puts.push({ key, size: (data as Uint8Array).byteLength ?? (data as ArrayBuffer).byteLength, contentType: opts?.httpMetadata?.contentType });
  }) } as unknown as R2Bucket;
  return { IMAGES, puts };
};

describe('T-C1 uploadImageDataUrlToR2 (R2 host + no-auth GET URL)', () => {
  it('valid png を R2 put し media/form-image/{formId}/ prefix の /images/{key} URL を返す', async () => {
    const { IMAGES, puts } = mockR2();
    const r = await uploadImageDataUrlToR2({ IMAGES, WORKER_URL: 'https://w.test' }, PNG_DATAURL, 'form123', 'https://origin.test');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(puts).toHaveLength(1);
      expect(puts[0].key).toMatch(/^media\/form-image\/form123\/[0-9a-f-]+\.png$/);
      expect(puts[0].contentType).toBe('image/png');
      expect(r.url).toBe(`https://w.test/images/${puts[0].key}`);
    }
  });

  it('WORKER_URL 未設定なら fallbackOrigin を使う', async () => {
    const { IMAGES } = mockR2();
    const r = await uploadImageDataUrlToR2({ IMAGES }, PNG_DATAURL, 'f', 'https://fallback.test');
    expect(r.ok && r.url.startsWith('https://fallback.test/images/')).toBe(true);
  });

  it('非画像 dataUrl は reject (put しない)', async () => {
    const { IMAGES, puts } = mockR2();
    const r = await uploadImageDataUrlToR2({ IMAGES, WORKER_URL: 'https://w.test' }, 'data:text/plain;base64,AAAA', 'f', 'https://o.test');
    expect(r.ok).toBe(false);
    expect(puts).toHaveLength(0);
  });
});

const imgField = (config: Record<string, unknown>): HarnessField => ({ id: 'img1', type: 'image', label: '画像', required: false, position: 2, config: config as HarnessField['config'] });

describe('T-C2 resolveInBodyImageUploads (dataUrl→R2→imageUrl 解決)', () => {
  it('replace intent は upload → imageUrl 確定 + imageUpload drop', async () => {
    const fields = [imgField({ imageWidth: 'medium', imageUpload: { intent: 'replace', dataUrl: PNG_DATAURL } })];
    const uploader = vi.fn(async () => ({ ok: true as const, url: 'https://w.test/images/media/form-image/f/x.png' }));
    const r = await resolveInBodyImageUploads(fields, uploader);
    expect(r.ok).toBe(true);
    expect(uploader).toHaveBeenCalledTimes(1);
    expect(fields[0].config.imageUrl).toBe('https://w.test/images/media/form-image/f/x.png');
    expect(fields[0].config.imageUpload).toBeUndefined();
  });

  it('remove intent は imageUrl と imageUpload を消す', async () => {
    const fields = [imgField({ imageUrl: 'https://w.test/images/old.png', imageUpload: { intent: 'remove' } })];
    const r = await resolveInBodyImageUploads(fields, vi.fn(async () => ({ ok: true as const, url: 'x' })));
    expect(r.ok).toBe(true);
    expect(fields[0].config.imageUrl).toBeUndefined();
    expect(fields[0].config.imageUpload).toBeUndefined();
  });

  it('URL 直指定 (imageUpload 無) は uploader を呼ばず imageUrl 温存', async () => {
    const fields = [imgField({ imageUrl: 'https://cdn.test/a.png', imageWidth: 'full' })];
    const uploader = vi.fn(async () => ({ ok: true as const, url: 'x' }));
    const r = await resolveInBodyImageUploads(fields, uploader);
    expect(r.ok).toBe(true);
    expect(uploader).not.toHaveBeenCalled();
    expect(fields[0].config.imageUrl).toBe('https://cdn.test/a.png');
  });

  it('非 image field は不変 (uploader 非呼出)', async () => {
    const fields = [{ id: 't', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 20 } } as HarnessField];
    const uploader = vi.fn(async () => ({ ok: true as const, url: 'x' }));
    const r = await resolveInBodyImageUploads(fields, uploader);
    expect(r.ok).toBe(true);
    expect(uploader).not.toHaveBeenCalled();
    expect(fields[0].config).toEqual({ maxLength: 20 });
  });

  it('upload 失敗は全体を止める (silent skip しない = honest surface)', async () => {
    const fields = [imgField({ imageUpload: { intent: 'replace', dataUrl: PNG_DATAURL } })];
    const r = await resolveInBodyImageUploads(fields, vi.fn(async () => ({ ok: false as const, error: 'R2 失敗' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('R2');
  });
});

describe('T-C3 push→GET canonical <img> byte 一致 封鎖 (fingerprint false-drift 防止)', () => {
  it('canonical <img> は fromFormalooField→toFormalooFieldPayload で byte 完全再生 (spike T-C3 の unit 封鎖)', () => {
    const canonical = buildImageDescriptionHtml('https://cdn.test/a.png', 'お客様の写真', 'medium');
    // Formaloo GET-back (spike 実測 byte 一致) を fields_list 要素で模す
    const back = fromFormalooField({ type: 'meta', sub_type: 'section', slug: 'sec', title: '画像', description: canonical, position: 2 });
    expect(back?.type).toBe('image');
    const rebuilt = toFormalooFieldPayload(back!);
    expect(rebuilt.description).toBe(canonical); // 再 push は同一 byte = drift 誤発火しない
  });

  it('Formaloo が cosmetic 揺れ (border-radius 差・自己終了 />) を返しても再 push は canonical に正規化', () => {
    const canonical = buildImageDescriptionHtml('https://cdn.test/a.png', 'x', 'small');
    const jittered = '<img src="https://cdn.test/a.png" alt="x" style="max-width:40%;border-radius:12px" />';
    const back = fromFormalooField({ type: 'meta', sub_type: 'section', slug: 'sec', title: 'x', description: jittered, position: 1 });
    const rebuilt = toFormalooFieldPayload(back!);
    expect(rebuilt.description).toBe(canonical); // parse 済み値→canonical 再生成で byte 安定
  });
});
