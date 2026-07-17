/**
 * LANE form design contract — Formaloo color fidelity, update-safe normalization,
 * image upload intent validation, and the shared preset palette catalogue.
 */
import { describe, it, expect } from 'vitest';
import {
  FORM_DESIGN_COLOR_KEYS,
  FORM_DESIGN_TO_FORMALOO,
  LINE_PRESET_PALETTES,
  DEFAULT_FORM_DESIGN_PRESET_ID,
  defaultFormDesign,
  formalooColorToHex,
  hexToFormalooRgba,
  isValidHexColor,
  normalizeFormDesign,
  validateImageUpload,
  MAX_IMAGE_UPLOAD_BYTES,
  type FormalooColorValue,
} from './form-design';

// WCAG 2.x relative-luminance contrast ratio (pure・テスト内実装 = shared public API を増やさない)。
// #37352F 同色事故の構造的 re-trap 防止を機械 assert するための番人ヘルパ。
function relativeLuminance(hex: string): number {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
// spec §3.2 補足: 現行 line-green の白×緑ボタンは 2.26（既存ブランド標準・本案件は不可触）。
// button/submit >= 3.0 gate はこの 1 種のみ grandfather 除外（色変更は既存 fingerprint に波及するため）。
// field/text・bg/text の 4.5 gate は 全プリセットに無条件適用（罠の芯 = 入力欄不可視の防止）。
const GRANDFATHERED_BUTTON_CONTRAST = new Set(['line-green']);

describe('formalooColorToHex', () => {
  it('T-A1 converts RGBA objects while rounding, clamping, and ignoring alpha', () => {
    expect(formalooColorToHex({ r: 6, g: 199, b: 85, a: 1 })).toBe('#06C755');
    expect(formalooColorToHex({ r: 5.6, g: 198.7, b: 85.4 })).toBe('#06C755');
    expect(formalooColorToHex({ r: 300, g: -5, b: 85 })).toBe('#FF0055');
    expect(formalooColorToHex({ r: 6, g: 199, b: 85, a: 0.4 })).toBe('#06C755');
    expect(formalooColorToHex({ r: Number.NaN, g: 1, b: 2 })).toBeNull();
    expect(formalooColorToHex({ r: 1, g: 2 } as unknown as FormalooColorValue)).toBeNull();
  });

  it('T-A1b parses the JSON-stringified RGBA shape returned by fresh Formaloo forms', () => {
    expect(formalooColorToHex('{"r":6,"g":199,"b":85,"a":1}')).toBe('#06C755');
  });

  it('T-A2 normalizes hex strings to uppercase six-digit hex', () => {
    expect(formalooColorToHex('#06c755')).toBe('#06C755');
    expect(formalooColorToHex('#abc')).toBe('#AABBCC');
  });

  it('T-A3 rejects nullish and invalid Formaloo color values', () => {
    expect(formalooColorToHex(null)).toBeNull();
    expect(formalooColorToHex(undefined)).toBeNull();
    expect(formalooColorToHex('red')).toBeNull();
    expect(formalooColorToHex({} as unknown as FormalooColorValue)).toBeNull();
    expect(formalooColorToHex([1, 2, 3] as unknown as FormalooColorValue)).toBeNull();
  });
});

describe('hex color helpers', () => {
  it('T-A4 accepts only #RGB and #RRGGBB', () => {
    expect(isValidHexColor('#06C755')).toBe(true);
    expect(isValidHexColor('#000')).toBe(true);
    expect(isValidHexColor('red')).toBe(false);
    expect(isValidHexColor('06C755')).toBe(false);
    expect(isValidHexColor('#GGGGGG')).toBe(false);
  });

  it('T-A5 converts valid hex to the insurance RGBA push shape', () => {
    expect(hexToFormalooRgba('#06C755')).toEqual({ r: 6, g: 199, b: 85, a: 1 });
    expect(hexToFormalooRgba('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(hexToFormalooRgba('bad')).toBeNull();
  });
});

describe('normalizeFormDesign', () => {
  it('T-A6 explicitly whitelists keys and drops invalid colors and URLs', () => {
    const result = normalizeFormDesign({
      themeColor: '#06c755',
      textColor: 'nope',
      logoUrl: 'javascript:alert(1)',
      junk: 1,
    });

    expect(result.themeColor).toBe('#06C755');
    expect('textColor' in result).toBe(false);
    expect('logoUrl' in result).toBe(false);
    expect('junk' in result).toBe(false);
    expect(normalizeFormDesign({ logoUrl: 'https://ex/x.png' }).logoUrl).toBe('https://ex/x.png');
  });

  it('normalizes every supported property without passing through unknown values', () => {
    const result = normalizeFormDesign({
      backgroundColor: '{"r":244,"g":251,"b":247,"a":1}',
      buttonColor: '#0a5',
      themeName: `  ${'x'.repeat(140)}  `,
      coverImageUrl: 'http://example.com/cover.png',
      backgroundImageUrl: 'data:image/png;base64,AA',
      presetId: 'line-green',
      inheritedDanger: true,
    });

    expect(result.backgroundColor).toBe('#F4FBF7');
    expect(result.buttonColor).toBe('#00AA55');
    expect(result.themeName).toBe('x'.repeat(120));
    expect(result.coverImageUrl).toBe('http://example.com/cover.png');
    expect('backgroundImageUrl' in result).toBe(false);
    expect(result.presetId).toBe('line-green');
    expect('inheritedDanger' in result).toBe(false);
  });

  it('T-A7 maps undefined, null, and an empty object to the same zero-key design', () => {
    const emptyDesign = {};

    for (const input of [undefined, null, {}]) {
      const result = normalizeFormDesign(input);
      expect(result).toEqual(emptyDesign);
      expect(Object.keys(result)).toEqual([]);
      for (const key of FORM_DESIGN_COLOR_KEYS) expect(key in result).toBe(false);
    }
  });
});

describe('validateImageUpload', () => {
  it('T-A12 accepts a supported replacement data URL', () => {
    expect(validateImageUpload({
      intent: 'replace',
      dataUrl: 'data:image/png;base64,AA',
      mimeType: 'image/png',
    })).toEqual({ ok: true });
  });

  it('T-A12 requires dataUrl for replace, but not for keep or remove', () => {
    expect(validateImageUpload({ intent: 'replace', mimeType: 'image/png' })).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(validateImageUpload({ intent: 'keep' })).toEqual({ ok: true });
    expect(validateImageUpload({ intent: 'remove' })).toEqual({ ok: true });
  });

  it('T-A12 rejects disallowed image MIME types', () => {
    expect(validateImageUpload({
      intent: 'replace',
      dataUrl: 'data:image/svg+xml;base64,AA',
      mimeType: 'image/svg+xml',
    })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('F4: rejects a replacement whose decoded bytes exceed the 10MB cap', () => {
    // 14MB of base64 'A' → ~10.5MB decoded (> MAX_IMAGE_UPLOAD_BYTES).
    const oversize = 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024);
    expect(validateImageUpload({ intent: 'replace', dataUrl: oversize, mimeType: 'image/png' }))
      .toEqual({ ok: false, reason: expect.any(String) });
    // just-under-cap payload stays ok.
    const small = 'data:image/png;base64,' + 'A'.repeat(1024);
    expect(validateImageUpload({ intent: 'replace', dataUrl: small, mimeType: 'image/png' })).toEqual({ ok: true });
  });

  it('F4: MAX_IMAGE_UPLOAD_BYTES is 10MB', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('shared form design catalogue', () => {
  it('exposes the canonical Formaloo field mapping', () => {
    expect(FORM_DESIGN_TO_FORMALOO).toEqual({
      themeColor: 'theme_color',
      backgroundColor: 'background_color',
      buttonColor: 'button_color',
      textColor: 'text_color',
      fieldColor: 'field_color',
      borderColor: 'border_color',
      submitTextColor: 'submit_text_color',
    });
  });

  it('T-A8 ships the full preset catalogue with non-empty ids, labels, and valid colors', () => {
    // OD-1 (2026-07-17): 現行 4 + owner 選定 8 候補 = 12 種。
    expect(LINE_PRESET_PALETTES.length).toBeGreaterThanOrEqual(3);
    expect(LINE_PRESET_PALETTES).toHaveLength(12);

    // preset id は一意（重複 id は UI の testid / 選択状態を壊す）。
    const ids = LINE_PRESET_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const preset of LINE_PRESET_PALETTES) {
      expect(preset.id.trim()).not.toBe('');
      expect(preset.label.trim()).not.toBe('');
      expect(Object.keys(preset.colors).sort()).toEqual([...FORM_DESIGN_COLOR_KEYS].sort());
      for (const key of FORM_DESIGN_COLOR_KEYS) {
        expect(isValidHexColor(preset.colors[key])).toBe(true);
      }
    }
  });

  it('T-A8b owner が選定した 8 候補 (ダーク 3 + 明るい系 5) が additive で追加されている', () => {
    const ids = new Set(LINE_PRESET_PALETTES.map((p) => p.id));
    // 現行 4 種は byte 不変で残る（後方互換）。
    for (const id of ['line-green', 'warm-terracotta', 'deep-tide', 'soft-plum']) {
      expect(ids.has(id)).toBe(true);
    }
    // OD-1 の 8 候補が揃っている。
    for (const id of ['dark-sumi', 'dark-indigo', 'dark-tokiwa', 'sand-washi', 'mono-ink', 'fresh-mint', 'coral-pop', 'matcha-wa']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('T-A1(contrast) 全プリセットで 入力欄背景↔文字 と 背景↔文字 のコントラストが 4.5:1 以上 (#37352F 同色 re-trap の構造的防止)', () => {
    for (const preset of LINE_PRESET_PALETTES) {
      const c = preset.colors;
      // 入力欄が見えない罠 (#37352F 同色) の根絶: 入力欄背景 vs 文字色。
      expect(contrastRatio(c.fieldColor, c.textColor)).toBeGreaterThanOrEqual(4.5);
      // ページ地色 vs 文字色。
      expect(contrastRatio(c.backgroundColor, c.textColor)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('T-A1(contrast-button) 送信ボタン色↔ボタン文字色が 3.0 以上 (line-green は既存ブランド標準 2.26 を grandfather 除外・spec §3.2)', () => {
    for (const preset of LINE_PRESET_PALETTES) {
      if (GRANDFATHERED_BUTTON_CONTRAST.has(preset.id)) continue;
      const c = preset.colors;
      // 大サイズ太字ボタン文字ゆえ WCAG AA では 3:1 で足りる (WARN5)。
      expect(contrastRatio(c.buttonColor, c.submitTextColor)).toBeGreaterThanOrEqual(3.0);
    }
    // grandfather 対象は現状 line-green のみ (他が混入したら回帰として気付けるよう固定)。
    expect([...GRANDFATHERED_BUTTON_CONTRAST]).toEqual(['line-green']);
  });

  it('T-A9 avoids generic theme/button colors and includes exact LINE green', () => {
    const banned = new Set(['#000000', '#FFFFFF', '#3B82F6', '#6366F1', '#2563EB']);

    for (const preset of LINE_PRESET_PALETTES) {
      expect(banned.has(preset.colors.themeColor)).toBe(false);
      expect(banned.has(preset.colors.buttonColor)).toBe(false);
    }
    expect(LINE_PRESET_PALETTES.some((preset) => preset.colors.themeColor === '#06C755')).toBe(true);
  });

  it('T-A1(defaultFormDesign) 既定パレットは OD-2 (line-green) の presetId + 7 色 hex を返す', () => {
    expect(DEFAULT_FORM_DESIGN_PRESET_ID).toBe('line-green');
    const d = defaultFormDesign();
    expect(d.presetId).toBe(DEFAULT_FORM_DESIGN_PRESET_ID);
    // カタログの line-green と同一色 (単一正本 = drift しない)。
    const green = LINE_PRESET_PALETTES.find((p) => p.id === DEFAULT_FORM_DESIGN_PRESET_ID)!;
    for (const key of FORM_DESIGN_COLOR_KEYS) {
      expect(d[key]).toBe(green.colors[key]);
      expect(isValidHexColor(d[key] as string)).toBe(true);
    }
    // 別 object を返す (共有参照で preset を破壊しない)。
    expect(defaultFormDesign()).not.toBe(defaultFormDesign());
  });
});
