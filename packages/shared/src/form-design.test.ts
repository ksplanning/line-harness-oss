/**
 * LANE form design contract — Formaloo color fidelity, update-safe normalization,
 * image upload intent validation, and the shared preset palette catalogue.
 */
import { describe, it, expect } from 'vitest';
import {
  FORM_DESIGN_COLOR_KEYS,
  FORM_DESIGN_TO_FORMALOO,
  LINE_PRESET_PALETTES,
  formalooColorToHex,
  hexToFormalooRgba,
  isValidHexColor,
  normalizeFormDesign,
  validateImageUpload,
  type FormalooColorValue,
} from './form-design';

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

  it('T-A8 ships four complete presets with non-empty ids, labels, and valid colors', () => {
    expect(LINE_PRESET_PALETTES.length).toBeGreaterThanOrEqual(3);
    expect(LINE_PRESET_PALETTES).toHaveLength(4);

    for (const preset of LINE_PRESET_PALETTES) {
      expect(preset.id.trim()).not.toBe('');
      expect(preset.label.trim()).not.toBe('');
      expect(Object.keys(preset.colors).sort()).toEqual([...FORM_DESIGN_COLOR_KEYS].sort());
      for (const key of FORM_DESIGN_COLOR_KEYS) {
        expect(isValidHexColor(preset.colors[key])).toBe(true);
      }
    }
  });

  it('T-A9 avoids generic theme/button colors and includes exact LINE green', () => {
    const banned = new Set(['#000000', '#FFFFFF', '#3B82F6', '#6366F1', '#2563EB']);

    for (const preset of LINE_PRESET_PALETTES) {
      expect(banned.has(preset.colors.themeColor)).toBe(false);
      expect(banned.has(preset.colors.buttonColor)).toBe(false);
    }
    expect(LINE_PRESET_PALETTES.some((preset) => preset.colors.themeColor === '#06C755')).toBe(true);
  });
});
