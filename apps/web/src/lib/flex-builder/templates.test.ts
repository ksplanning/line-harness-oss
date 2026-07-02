/**
 * テンプレ実データテスト (D-4)。3 テンプレが validateFlex.ok かつ非空 bubble/carousel。
 */
import { describe, test, expect } from 'vitest';
import { NAIL_TEMPLATES, blankModel, cloneTemplate } from './templates';
import { buildModelToFlex } from './to-flex';
import { validateFlex } from './validate';

describe('NAIL_TEMPLATES', () => {
  test('3 テンプレが存在し日本語ラベルを持つ', () => {
    expect(NAIL_TEMPLATES.length).toBe(3);
    for (const t of NAIL_TEMPLATES) {
      expect(t.label).toMatch(/[ぁ-んァ-ヶ一-龠]/); // 日本語ラベル
      expect(t.label).not.toMatch(/flex|json|carousel|bubble/i); // 専門語ゼロ
    }
  });

  test('D-4: 各テンプレが validateFlex.ok を返す', () => {
    for (const t of NAIL_TEMPLATES) {
      const r = validateFlex(buildModelToFlex(t.model));
      if (!r.ok) throw new Error(`${t.key} failed: ${JSON.stringify(r.errors)}`);
      expect(r.ok).toBe(true);
    }
  });

  test('D-4: buildModelToFlex 出力が非空の bubble/carousel', () => {
    for (const t of NAIL_TEMPLATES) {
      const out = buildModelToFlex(t.model);
      expect(out.type === 'bubble' || out.type === 'carousel').toBe(true);
      if (out.type === 'bubble') {
        expect(out.body?.contents.length).toBeGreaterThan(0);
      } else {
        expect(out.contents.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test('商品テンプレは carousel (2 カード) になる', () => {
    const products = NAIL_TEMPLATES.find((t) => t.key === 'products')!;
    const out = buildModelToFlex(products.model);
    expect(out.type).toBe('carousel');
    if (out.type !== 'carousel') throw new Error();
    expect(out.contents.length).toBe(2);
  });

  test('全テンプレ画像 URL が https:// (プレースホルダ含む)', () => {
    for (const t of NAIL_TEMPLATES) {
      for (const card of t.model.cards) {
        for (const p of card.parts) {
          if (p.kind === 'image') expect(p.url.startsWith('https://')).toBe(true);
        }
      }
    }
  });

  test('cloneTemplate は id を新しく振り、元データを汚さない', () => {
    const tpl = NAIL_TEMPLATES[0];
    const originalFirstId = tpl.model.cards[0].id;
    const cloned = cloneTemplate(tpl);
    expect(cloned.cards[0].id).not.toBe(originalFirstId);
    expect(tpl.model.cards[0].id).toBe(originalFirstId); // 元は不変
    // 出力は元と同じ Flex 構造 (id は Flex に出ないので validateFlex.ok は維持)
    expect(validateFlex(buildModelToFlex(cloned)).ok).toBe(true);
  });

  test('blankModel は空 1 カード (validate は保存時に「中身がありません」)', () => {
    const m = blankModel();
    expect(m.cards.length).toBe(1);
    expect(m.cards[0].parts.length).toBe(0);
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
});
