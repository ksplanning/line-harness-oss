/**
 * b1-field-polish (T-B2 / R-4) — 星色 managed custom_css の生成 + 非破壊 merge。
 *   spike PASS の star クラス scope CSS (nps-icon-star / react-rater-star) のみ着色 = 本文/入力欄 decouple。
 *   mergeManagedCss は foreign custom_css を保持しつつ旧 harness block を置換・null で除去・hex のみ埋込 (CSS 注入防止)。
 */
import { describe, test, expect } from 'vitest';
import {
  ratingStarCss,
  mergeManagedCss,
  RATING_STAR_CSS_START,
  RATING_STAR_CSS_END,
} from './formaloo-rating-style';

describe('b1-field-polish T-B2 — ratingStarCss (managed block 生成)', () => {
  test('delimited managed block を生成し検証済 hex を埋め込む', () => {
    const css = ratingStarCss('#F5B301');
    expect(css.startsWith(RATING_STAR_CSS_START)).toBe(true);
    expect(css.trimEnd().endsWith(RATING_STAR_CSS_END)).toBe(true);
    expect(css).toContain('#F5B301');
  });

  test('R-4: star クラス scope のみ (本文/入力欄/label を触らない = decouple)', () => {
    const css = ratingStarCss('#F5B301');
    // 星クラス selector を全て含む (空星 hollow + 塗り選択星)。
    expect(css).toContain('nps-icon-star');
    expect(css).toContain('nps-notActive');
    expect(css).toContain('--filled');
    expect(css).toContain('.react-rater-star');
    // text_color / 本文 / 入力欄 に効く selector を **一切含まない** (黄星でも本文不変)。
    for (const forbidden of ['body', 'input', 'textarea', 'label', 'text_color', 'field_color', '.formaloo-form', 'html']) {
      expect(css).not.toContain(forbidden);
    }
  });

  test('不正 hex は reject (任意文字列を CSS に通さない = 注入防止)', () => {
    for (const bad of ['red', 'F5B301', '#zzz', '#12', 'url(x)', '#fff;}body{}', '']) {
      expect(() => ratingStarCss(bad)).toThrow();
    }
  });

  test('#RGB 短縮 hex も正規化して埋め込む', () => {
    const css = ratingStarCss('#fc0');
    expect(css).toContain('#FFCC00');
  });
});

describe('b1-field-polish T-B2 — mergeManagedCss (非破壊 merge)', () => {
  const block = ratingStarCss('#F5B301');

  test('空 / null base は block をそのまま返す', () => {
    expect(mergeManagedCss('', block)).toBe(block);
    expect(mergeManagedCss(null, block)).toBe(block);
    expect(mergeManagedCss(undefined, block)).toBe(block);
  });

  test('foreign custom_css を保持して block を追記', () => {
    const merged = mergeManagedCss('.foo{color:red}', block);
    expect(merged).toContain('.foo{color:red}');
    expect(merged).toContain(block);
  });

  test('旧 harness block を新 block で置換 (managed block は常に 1 つ・foreign 保持)', () => {
    const oldBlock = ratingStarCss('#FF0000');
    const withOld = `.foo{color:red}\n${oldBlock}`;
    const merged = mergeManagedCss(withOld, block);
    expect(merged).toContain('.foo{color:red}'); // foreign 保持
    expect(merged).toContain('#F5B301'); // 新色
    expect(merged).not.toContain('#FF0000'); // 旧色は消える
    // managed block は 1 つだけ (start delimiter が 1 回)。
    expect(merged.split(RATING_STAR_CSS_START).length - 1).toBe(1);
  });

  test('null block は managed block を除去し foreign を保持', () => {
    const withBlock = `.foo{color:red}\n${block}`;
    const removed = mergeManagedCss(withBlock, null);
    expect(removed).toContain('.foo{color:red}');
    expect(removed).not.toContain(RATING_STAR_CSS_START);
    expect(removed).not.toContain('#F5B301');
  });

  test('block 無し foreign css に null merge は不変 (byte 不変)', () => {
    expect(mergeManagedCss('.foo{color:red}', null)).toBe('.foo{color:red}');
    expect(mergeManagedCss('', null)).toBe('');
    expect(mergeManagedCss(null, null)).toBe('');
  });
});
