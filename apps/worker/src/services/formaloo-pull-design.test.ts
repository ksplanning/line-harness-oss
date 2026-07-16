/**
 * form-design pull 復元 (extractDesign / buildPullResult.design)。
 * live-probe(2026-07-16): fresh 色は JSON-stringified RGBA 文字列、hex PATCH 後は hex 文字列。
 *   logo は `logo`(S3 URL) 優先・`logo_url` fallback。カバー = `background_image`。
 */
import { describe, test, expect } from 'vitest';
import { extractDesign, buildPullResult } from './formaloo-pull';

describe('extractDesign (Formaloo GET body → FormDesign)', () => {
  test('JSON-stringified RGBA と hex を hex に正規化・logo/background を URL 復元', () => {
    const body = {
      data: {
        form: {
          fields_list: [],
          theme_color: '#06C755',
          button_color: '{"r":6,"g":199,"b":85,"a":1}', // fresh = JSON 文字列
          background_color: '#FFFFFF',
          text_color: '{"r":17,"g":17,"b":17,"a":1}',
          theme_name: 'brand',
          logo: 'https://s3.amazonaws.com/formaloo-en/x/logo.png',
          background_image: 'https://s3.amazonaws.com/formaloo-en/x/bg.png',
        },
      },
    };
    const d = extractDesign(body);
    expect(d.themeColor).toBe('#06C755');
    expect(d.buttonColor).toBe('#06C755'); // JSON 文字列 → hex
    expect(d.backgroundColor).toBe('#FFFFFF');
    expect(d.textColor).toBe('#111111');
    expect(d.themeName).toBe('brand');
    expect(d.logoUrl).toBe('https://s3.amazonaws.com/formaloo-en/x/logo.png');
    expect(d.backgroundImageUrl).toBe('https://s3.amazonaws.com/formaloo-en/x/bg.png');
  });

  test('logo が null なら logo_url へ fallback', () => {
    const body = { data: { form: { fields_list: [], logo: null, logo_url: 'https://cdn/x/logo2.png' } } };
    expect(extractDesign(body).logoUrl).toBe('https://cdn/x/logo2.png');
  });

  test('色/画像が無いフォームは空 design (色キー無し)', () => {
    const d = extractDesign({ data: { form: { fields_list: [], theme_color: null, logo: null } } });
    expect(d.themeColor).toBeUndefined();
    expect(d.logoUrl).toBeUndefined();
    expect(Object.keys(d)).toHaveLength(0);
  });

  test('read-shape が違っても throw しない (空 design)', () => {
    expect(extractDesign(null)).toEqual({});
    expect(extractDesign({ nonsense: 1 })).toEqual({});
  });
});

describe('buildPullResult は design を含める', () => {
  test('fields_list + design を持つ body から design を復元', () => {
    const body = { data: { form: { fields_list: [], theme_color: '#06C755' } } };
    const r = buildPullResult(body, (s) => s);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.design?.themeColor).toBe('#06C755');
  });
});
