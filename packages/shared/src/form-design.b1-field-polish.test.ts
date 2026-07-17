/**
 * b1-field-polish (T-B1) — FormDesign.ratingStarColor (星色) の additive model。
 *   owner「黒星なのでオプション色は変えたいデフォルト黄色とか」→ 星色を design に格納 (本文 flat 7 色と decouple)。
 *   normalizeFormDesign が hex を正規化保持・null(明示クリア) を保持・不正は drop・absent は不在 (後方互換)。
 *   designColorFields (本文 flat 7 色 push) は ratingStarColor を **一切含まない** (D-2 二重実装回避・別経路)。
 */
import { describe, test, expect } from 'vitest';
import {
  normalizeFormDesign,
  defaultRatingStarColor,
  DEFAULT_RATING_STAR_COLOR,
  isValidHexColor,
} from './form-design';

describe('b1-field-polish T-B1 — DEFAULT_RATING_STAR_COLOR / defaultRatingStarColor', () => {
  test('既定は黄系の妥当な hex (OD-2 amber)', () => {
    expect(DEFAULT_RATING_STAR_COLOR).toBe('#F5B301');
    expect(isValidHexColor(DEFAULT_RATING_STAR_COLOR)).toBe(true);
    // 黄系 = R 高 / B 低 (黒 #37352F の反対で映える)。
    const r = parseInt(DEFAULT_RATING_STAR_COLOR.slice(1, 3), 16);
    const b = parseInt(DEFAULT_RATING_STAR_COLOR.slice(5, 7), 16);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(80);
  });
  test('defaultRatingStarColor() は既定黄を返す', () => {
    expect(defaultRatingStarColor()).toBe(DEFAULT_RATING_STAR_COLOR);
  });
});

describe('b1-field-polish T-B1 — normalizeFormDesign(ratingStarColor)', () => {
  test('valid hex を正規化保持 (#RGB → #RRGGBB uppercase)', () => {
    expect(normalizeFormDesign({ ratingStarColor: '#f5b301' }).ratingStarColor).toBe('#F5B301');
    expect(normalizeFormDesign({ ratingStarColor: '#fc0' }).ratingStarColor).toBe('#FFCC00');
  });
  test('explicit null (明示クリア) を保持 (注入なしの signal)', () => {
    expect(normalizeFormDesign({ ratingStarColor: null }).ratingStarColor).toBeNull();
  });
  test('不正値は key ごと drop (color convention)', () => {
    expect('ratingStarColor' in normalizeFormDesign({ ratingStarColor: 'yellow' })).toBe(false);
    expect('ratingStarColor' in normalizeFormDesign({ ratingStarColor: 123 })).toBe(false);
    expect('ratingStarColor' in normalizeFormDesign({ ratingStarColor: '#zzz' })).toBe(false);
  });
  test('absent は出力に不在 (後方互換・byte 不変)', () => {
    expect('ratingStarColor' in normalizeFormDesign({ themeColor: '#06C755' })).toBe(false);
  });
  test('normalize は冪等 (round-trip 安定)', () => {
    const once = normalizeFormDesign({ ratingStarColor: '#f5b301', themeColor: '#06c755' });
    expect(normalizeFormDesign(once)).toEqual(once);
  });
});
