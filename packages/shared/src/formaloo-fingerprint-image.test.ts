import { describe, it, expect } from 'vitest';
import { canonicalDefinitionProjection, formalooDefinitionFingerprint } from './formaloo-fingerprint';
import { buildImageDescriptionHtml } from './form-image';

// raw Formaloo field 要素 (fields_list shape)
const imgSectionRaw = (desc: string, slug = 'sec_img', pos = 2) => ({
  type: 'meta', sub_type: 'section', slug, title: '差し込み画像', description: desc, position: pos,
});
const proseSectionRaw = { type: 'meta', sub_type: 'section', slug: 'sec_prose', title: '案内', description: 'ここにご記入ください。', position: 1 };
const inputRaw = { type: 'short_text', slug: 'name', title: 'お名前', required: true, position: 0 };
const videoRaw = { type: 'oembed', slug: 'vid', title: '動画', url: 'https://youtu.be/x', position: 3 };

describe('T-A4 fingerprint image 射影 (parse 済み値・R-2)', () => {
  it('canonical <img> の image section を {imageUrl,imageAlt,imageWidth} で射影', () => {
    const desc = buildImageDescriptionHtml('https://cdn.test/a.png', '写真', 'medium');
    const { fields } = canonicalDefinitionProjection([imgSectionRaw(desc)], []);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ slug: 'sec_img', imageUrl: 'https://cdn.test/a.png', imageAlt: '写真', imageWidth: 'medium' });
  });

  it('散文 section は fingerprint 非射影 (既存フォーム false-drift ゼロ / R-1)', () => {
    const { fields } = canonicalDefinitionProjection([proseSectionRaw], []);
    expect(fields).toEqual([]);
  });

  it('imageWidth を変えると SHA が変わる (表示領域=render に効く)', async () => {
    const medium = await formalooDefinitionFingerprint([imgSectionRaw(buildImageDescriptionHtml('https://cdn.test/a.png', 'x', 'medium'))], []);
    const full = await formalooDefinitionFingerprint([imgSectionRaw(buildImageDescriptionHtml('https://cdn.test/a.png', 'x', 'full'))], []);
    expect(medium).not.toBe(full);
  });

  it('同一 image の raw description HTML が揺れても SHA 不変 (parse 済み値射影ゆえ)', async () => {
    // 同じ url/alt/width だが border-radius 値差 + 自己終了 /> + 末尾空白 = cosmetic 揺れ
    const canonical = await formalooDefinitionFingerprint([imgSectionRaw('<img src="https://cdn.test/a.png" alt="x" style="max-width:70%;border-radius:8px">')], []);
    const jittered = await formalooDefinitionFingerprint([imgSectionRaw('<img src="https://cdn.test/a.png" alt="x" style="max-width:70%;border-radius:12px" /> ')], []);
    expect(canonical).toBe(jittered);
  });

  it('既存 field/section/video 混在フォームで image のみ射影追加 (section/video の扱い不変)', async () => {
    const desc = buildImageDescriptionHtml('https://cdn.test/a.png', 'x', 'small');
    const { fields } = canonicalDefinitionProjection([inputRaw, proseSectionRaw, imgSectionRaw(desc), videoRaw], []);
    const slugs = fields.map((f) => f.slug).sort();
    // 散文 section は落ち、input/image/video は残る
    expect(slugs).toEqual(['name', 'sec_img', 'vid']);
    // video 射影は従来どおり videoUrl のみ (image キーを持たない)
    const vid = fields.find((f) => f.slug === 'vid')!;
    expect(vid).toMatchObject({ videoUrl: 'https://youtu.be/x' });
    expect(vid).not.toHaveProperty('imageUrl');
  });
});
