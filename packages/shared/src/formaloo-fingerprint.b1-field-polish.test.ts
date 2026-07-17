/**
 * b1-field-polish (T-A2 / R-2) — video config.height は cosmetic ゆえ drift fingerprint に射影しない。
 *   同一 video の height 違い 2 状態が同一 fingerprint (height 変更で cron が false-drift を鳴らさない)。
 *   videoUrl (構造的 identity) の射影は不変。既存フォーム (oembed 有/無) の SHA は本変更前後で不変。
 *   星色 (custom_css) も canonicalDefinitionProjection=fields+logic に不入 = fingerprint 非関与 (別経路)。
 */
import { describe, it, expect } from 'vitest';
import { canonicalDefinitionProjection, formalooDefinitionFingerprint } from './formaloo-fingerprint';

const oembed = (over: Record<string, unknown> = {}) => ({
  slug: 'v1', type: 'oembed', title: '説明動画', position: 3, url: 'https://youtu.be/x', ...over,
});
const fp = (fields: unknown[]) => formalooDefinitionFingerprint(fields, null);

describe('b1-field-polish T-A2 — videoHeight は fingerprint 非射影', () => {
  it('射影 field に height / config が現れない (videoUrl のみ)', () => {
    const proj = canonicalDefinitionProjection([oembed({ config: { height: '350px' } })], null).fields as Record<string, unknown>[];
    expect(proj[0].videoUrl).toBe('https://youtu.be/x');
    expect('height' in proj[0]).toBe(false);
    expect('config' in proj[0]).toBe(false);
    expect('videoHeight' in proj[0]).toBe(false);
  });

  it('同一 video の height 違い 2 状態が同一 fingerprint (false-drift ゼロ)', async () => {
    const a = await fp([oembed()]); // config 無 (既定 100px 相当)
    const b = await fp([oembed({ config: { height: '250px' } })]);
    const c = await fp([oembed({ config: { height: '350px' } })]);
    const d = await fp([oembed({ config: { height: '56.25vw', width: '100%' } })]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it('videoUrl の変化は fingerprint を変える (構造的 identity は射影不変)', async () => {
    const a = await fp([oembed({ url: 'https://youtu.be/x', config: { height: '250px' } })]);
    const b = await fp([oembed({ url: 'https://youtu.be/YYY', config: { height: '250px' } })]);
    expect(b).not.toBe(a);
  });

  it('R-2: oembed field を含むフォームの SHA は config.height の有無で不変', async () => {
    const withHeight = [
      { slug: 's_name', type: 'short_text', title: 'お名前', required: true, position: 0 },
      oembed({ config: { height: '350px' } }),
    ];
    const withoutHeight = [
      { slug: 's_name', type: 'short_text', title: 'お名前', required: true, position: 0 },
      oembed(),
    ];
    expect(await fp(withHeight)).toBe(await fp(withoutHeight));
  });
});
