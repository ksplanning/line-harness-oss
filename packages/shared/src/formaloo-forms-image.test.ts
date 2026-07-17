import { describe, it, expect } from 'vitest';
import {
  DECORATION_FIELD_TYPES,
  HARNESS_TO_FORMALOO_TYPE,
  isDecorationType,
  toFormalooFieldPayload,
  fromFormalooField,
  type HarnessField,
} from './formaloo-forms';
import { buildImageDescriptionHtml } from './form-image';

const imgField = (config: Record<string, unknown>): HarnessField => ({
  id: 'f_img',
  type: 'image',
  label: '差し込み画像',
  required: false,
  position: 3,
  config: config as HarnessField['config'],
});

describe('T-A1 image decoration 型 (formaloo-forms)', () => {
  it("DECORATION_FIELD_TYPES に 'image' が入り isDecorationType('image')===true", () => {
    expect(DECORATION_FIELD_TYPES).toContain('image');
    expect(isDecorationType('image')).toBe(true);
  });

  it("HARNESS_TO_FORMALOO_TYPE['image']==='meta' (section と同じ description 経路)", () => {
    expect(HARNESS_TO_FORMALOO_TYPE.image).toBe('meta');
  });

  it('toFormalooFieldPayload(image) は meta/section + canonical <img> description', () => {
    const payload = toFormalooFieldPayload(imgField({ imageUrl: 'https://cdn.test/a.png', imageAlt: '写真', imageWidth: 'medium' }));
    expect(payload).toEqual({
      type: 'meta',
      sub_type: 'section',
      title: '差し込み画像',
      description: buildImageDescriptionHtml('https://cdn.test/a.png', '写真', 'medium'),
      position: 3,
    });
    expect(payload.description).toBe('<img src="https://cdn.test/a.png" alt="写真" style="max-width:70%;border-radius:8px">');
  });

  it('imageUpload (pending) は Formaloo payload に載せない (harness 側 intent)', () => {
    const payload = toFormalooFieldPayload(imgField({ imageUrl: 'https://cdn.test/a.png', imageWidth: 'small', imageUpload: { intent: 'replace', dataUrl: 'data:image/png;base64,AAAA' } }));
    expect(payload).not.toHaveProperty('imageUpload');
    expect(payload.description).toContain('max-width:40%');
  });
});

describe('T-A1 fromFormalooField meta→image 判別', () => {
  it('image description を持つ meta/section は image field へ復元', () => {
    const raw = {
      type: 'meta',
      sub_type: 'section',
      slug: 'sec_1',
      title: '差し込み画像',
      description: buildImageDescriptionHtml('https://cdn.test/x.jpg', 'キャンペーン', 'full'),
      position: 2,
    };
    const f = fromFormalooField(raw);
    expect(f?.type).toBe('image');
    expect(f?.required).toBe(false);
    expect(f?.config).toEqual({ imageUrl: 'https://cdn.test/x.jpg', imageAlt: 'キャンペーン', imageWidth: 'full' });
    expect(f?.label).toBe('差し込み画像');
  });

  it('散文 description の meta/section は section のまま (後方互換・image に誤分類しない)', () => {
    const raw = { type: 'meta', sub_type: 'section', slug: 'sec_2', title: '案内', description: 'ここにご記入ください。', position: 1 };
    const f = fromFormalooField(raw);
    expect(f?.type).toBe('section');
    expect(f?.config).toEqual({ text: 'ここにご記入ください。' });
  });

  it('image → payload → fromFormalooField round-trip で config 一致', () => {
    const original = imgField({ imageUrl: 'https://cdn.test/r.png', imageAlt: 'alt値', imageWidth: 'small' });
    const payload = toFormalooFieldPayload(original);
    const back = fromFormalooField({ ...payload, slug: 'sec_r' });
    expect(back?.type).toBe('image');
    expect(back?.config).toEqual({ imageUrl: 'https://cdn.test/r.png', imageAlt: 'alt値', imageWidth: 'small' });
  });
});
