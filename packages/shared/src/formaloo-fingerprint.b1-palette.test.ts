/**
 * treasure-b1-palette (T-D1/T-D2/R-2) — drift fingerprint への rating/oembed 射影 + 既定値ガード。
 *   T-D1 canonicalDefinitionProjection: rating を subType 込み(star drop)・oembed を {type:oembed,videoUrl(url非空)} で射影
 *   T-D2 rating/signature/video 含むフォームの fingerprint が push→pull→再射影で安定(同一 SHA / drift false-positive 無し)
 *   R-2  rating/signature/video を含まない既存フォームの fingerprint が本変更の前後で同一 SHA(false-drift ゼロ・最重要ガード)
 *
 * 既定 star drop / url 非空ガードが無いと、新型追加が既存 form の射影を変え cron 全件 false-drift を鳴らす(後方互換の要)。
 * media-limits の max_size=2048 ガード(T-A6) と同型。
 */
import { describe, it, expect } from 'vitest';
import { canonicalDefinitionProjection, formalooDefinitionFingerprint } from './formaloo-fingerprint';
import { fromFormalooField, toFormalooFieldPayload } from './formaloo-forms';

function projFields(fields: unknown[]): Record<string, unknown>[] {
  return canonicalDefinitionProjection(fields, null).fields as unknown as Record<string, unknown>[];
}
async function fp(fields: unknown[], logic: unknown = null): Promise<string> {
  return formalooDefinitionFingerprint(fields, logic);
}

// ── R-2 golden: rating/signature/video を 1 件も含まない既存フォーム fixture ──
//   本 SHA は本案件 (C1/C2/C3) 着工 *前* の baseline コードで計測 (throwaway probe / sidecar 記録)。
//   post-change でこの SHA が変われば「新型追加が既存フォームの fingerprint を変えた」= R-2 違反(false-drift)。
const EXISTING_FORM = [
  { slug: 's_name', type: 'short_text', title: 'お名前', required: true, position: 0, max_length: 40 },
  { slug: 's_mail', type: 'email', title: 'メール', required: true, position: 1 },
  { slug: 's_note', type: 'long_text', title: '備考', required: false, position: 2, description: '自由記入' },
  { slug: 's_pick', type: 'choice', title: 'ご希望', required: true, position: 3, choice_items: [{ title: 'A', position: 0 }, { title: 'B', position: 1 }] },
  { slug: 's_file', type: 'file', title: '添付', required: false, position: 4, max_size: 20480 },
  { slug: 's_sec', type: 'meta', sub_type: 'section', title: '案内', description: '説明本文', position: 5 },
];
const EXISTING_LOGIC = [
  { identifier: 'L1', title: 'r', when: { operation: 'and' }, actions: [{ type: 'show', field: 's_mail' }] },
];
const R2_GOLDEN = 'e85a2551d2aae150f396e035e31e700f081ac83034a068b9625bf6fc6aa862e1';

describe('B1 fingerprint — rating/oembed 射影 (T-D1)', () => {
  it('rating を subType 込みで射影 (sub_type=nps)', () => {
    const f = projFields([{ slug: 'r1', type: 'rating', title: '評価', required: true, position: 0, sub_type: 'nps' }]);
    expect(f[0].type).toBe('rating');
    expect(f[0].subType).toBe('nps');
  });
  it('rating sub_type=star (既定) は subType を射影しない (star drop)', () => {
    const f = projFields([{ slug: 'r1', type: 'rating', title: '評価', required: true, position: 0, sub_type: 'star' }]);
    expect('subType' in f[0]).toBe(false);
  });
  it('oembed を {type:oembed,videoUrl(url非空)} で射影 (required 常時 false)', () => {
    const f = projFields([{ slug: 'v1', type: 'oembed', title: '動画', required: true, position: 0, url: 'https://youtu.be/x' }]);
    expect(f[0].type).toBe('oembed');
    expect(f[0].videoUrl).toBe('https://youtu.be/x');
    expect(f[0].required).toBe(false);
  });
  it('oembed の url 空/未載は videoUrl を射影しない (url 非空ガード)', () => {
    const f = projFields([{ slug: 'v1', type: 'oembed', title: '動画', position: 0 }]);
    expect(f[0].type).toBe('oembed');
    expect('videoUrl' in f[0]).toBe(false);
  });
});

describe('B1 fingerprint — 新型フォームの安定性 (T-D2)', () => {
  it('rating/signature/video 含むフォームは push→pull→再射影で同一 SHA (drift false-positive なし)', async () => {
    const raw = [
      { slug: 'r1', type: 'rating', title: '満足度', required: true, position: 0, sub_type: 'nps' },
      { slug: 's1', type: 'signature', title: 'サイン', required: true, position: 1 },
      { slug: 'v1', type: 'oembed', title: '説明動画', position: 2, url: 'https://youtu.be/x' },
    ];
    const fp1 = await fp(raw);
    // Formaloo raw → harness (pull) → Formaloo payload (push) → slug 再付与 → 再射影
    const back = raw.map((el) => {
      const h = fromFormalooField(el, (s) => s)!;
      return { ...toFormalooFieldPayload(h), slug: el.slug };
    });
    const fp2 = await fp(back);
    expect(fp2).toBe(fp1);
  });
});

describe('B1 fingerprint — 既存フォーム byte 不変 (R-2 / 最重要後方互換ガード)', () => {
  it('rating/signature/video を含まない既存フォームの fingerprint が baseline SHA と一致 (false-drift ゼロ)', async () => {
    expect(await fp(EXISTING_FORM, EXISTING_LOGIC)).toBe(R2_GOLDEN);
  });
  it('新型 field の追加は fingerprint を変える (真 drift は検知する)', async () => {
    const withRating = [...EXISTING_FORM, { slug: 'r1', type: 'rating', title: '評価', required: true, position: 6, sub_type: 'nps' }];
    expect(await fp(withRating, EXISTING_LOGIC)).not.toBe(R2_GOLDEN);
  });
  it('rating sub_type=star と sub_type 未載は同一 fingerprint (star false-drift 無し)', async () => {
    const star = await fp([{ slug: 'r1', type: 'rating', title: '評価', required: true, position: 0, sub_type: 'star' }]);
    const none = await fp([{ slug: 'r1', type: 'rating', title: '評価', required: true, position: 0 }]);
    expect(star).toBe(none);
  });
});
