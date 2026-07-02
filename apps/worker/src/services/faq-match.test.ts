import { describe, expect, test } from 'vitest';
import { dice, matchFaq, matchFaqDetailed, ngrams, normalize, scoreFaq } from './faq-match.js';

const activeFaq = (overrides: Partial<{
  id: string;
  question: string;
  variants: string[];
  answer: string;
  is_active: number;
}> = {}) => ({
  id: overrides.id ?? 'faq-1',
  line_account_id: null,
  question: overrides.question ?? '営業時間は何時からですか',
  variants: overrides.variants ?? [],
  answer: overrides.answer ?? '10時からです',
  is_active: overrides.is_active ?? 1,
  hit_count: 0,
  created_at: '2026-07-02T00:00:00+09:00',
  updated_at: '2026-07-02T00:00:00+09:00',
});

describe('FAQ matcher', () => {
  test('normalize applies NFKC, hiragana conversion, lower-case, and punctuation removal', () => {
    expect(normalize(' ＡＢＣ！？ｶﾞガ・「営業時間」(TEST)　')).toBe('abcがが営業時間test');
  });

  test('ngrams returns one item for strings shorter than n', () => {
    expect([...ngrams('ab', 3)]).toEqual(['ab']);
    expect([...ngrams('abcd', 2)]).toEqual(['ab', 'bc', 'cd']);
  });

  test('dice returns Sørensen-Dice coefficient and fails closed on empty sets', () => {
    expect(dice(new Set(['ab', 'bc']), new Set(['bc', 'cd']))).toBe(0.5);
    expect(dice(new Set(), new Set(['bc']))).toBe(0);
  });

  test('scoreFaq uses the best normalized question or variant with bi+tri average', () => {
    const faq = activeFaq({ question: '営業時間は何時からですか', variants: ['開店時間'] });
    expect(scoreFaq('開店時間は？', faq)).toBeGreaterThan(scoreFaq('駐車場ありますか', faq));
  });

  test('matchFaq hits at the threshold boundary and returns null below threshold', () => {
    const faq = activeFaq();
    const exactScore = scoreFaq('営業時間は何時からですか', faq);

    expect(matchFaq('営業時間は何時からですか', [faq], exactScore)?.faq.id).toBe('faq-1');
    expect(matchFaq('営業時間は何時からですか', [faq], exactScore + 0.001)).toBeNull();
  });

  test('empty query, empty list, and inactive-only list return null', () => {
    expect(matchFaq('！？　', [activeFaq()], 0.6)).toBeNull();
    expect(matchFaq('営業時間', [], 0.6)).toBeNull();
    expect(matchFaq('営業時間', [activeFaq({ is_active: 0 })], 0.6)).toBeNull();
  });

  test('matchFaqDetailed exposes topScore even when threshold is not reached', () => {
    const detail = matchFaqDetailed('営業時間', [activeFaq()], 1.1);
    expect(detail.match).toBeNull();
    expect(detail.topScore).toBeGreaterThan(0);
    expect(detail.best?.faq.id).toBe('faq-1');
  });
});
