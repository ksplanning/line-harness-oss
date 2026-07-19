import { describe, expect, test } from 'vitest';
import {
  JP_LOCALIZED_CONTENT,
  MANAGED_LOCALIZATION_KEYS,
  buildLocalizedContentMerge,
} from './formaloo-localization';

const EXPECTED_KEYS = [
  'back_btn',
  'next_btn',
  'skip_btn',
  'start_btn',
  'previous_btn',
  'continue_btn',
  'answer',
  'day',
  'month',
  'year',
  'hours',
  'minutes',
  'long_text_hint',
] as const;

describe('Formaloo hosted 日本語 chrome の管理境界', () => {
  test('実測済み top-level key だけを管理し、文字数 validation key を含まない', () => {
    expect(MANAGED_LOCALIZATION_KEYS).toEqual(EXPECTED_KEYS);
    expect(Object.keys(JP_LOCALIZED_CONTENT)).toEqual(EXPECTED_KEYS);
    expect(Object.keys(JP_LOCALIZED_CONTENT).some((key) => /max.?length|character/i.test(key))).toBe(false);
    expect(Object.values(JP_LOCALIZED_CONTENT).every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
  });
});

describe('buildLocalizedContentMerge', () => {
  test('ON は管理 key だけを日本語へ merge し、nested foreign key と入力 object を保つ', () => {
    const existing = {
      next_btn: 'Tenant override',
      tenant_banner: 'foreign',
      errors: { invalid_field_error: 'custom error' },
    };
    const before = structuredClone(existing);

    const merged = buildLocalizedContentMerge(existing, true);

    expect(merged).toEqual({
      ...existing,
      ...JP_LOCALIZED_CONTENT,
    });
    expect(merged.tenant_banner).toBe('foreign');
    expect(merged.errors).toEqual({ invalid_field_error: 'custom error' });
    expect(existing).toEqual(before);
  });

  test('OFF は管理 key だけを remove し、foreign key を byte 同等で残す', () => {
    const existing = {
      tenant_banner: 'foreign',
      back_btn: '戻る',
      errors: { invalid_field_error: 'custom error' },
      next_btn: '次へ',
    };

    expect(buildLocalizedContentMerge(existing, false)).toEqual({
      tenant_banner: 'foreign',
      errors: { invalid_field_error: 'custom error' },
    });
    expect(existing).toHaveProperty('back_btn');
    expect(existing).toHaveProperty('next_btn');
  });

  test('既に ON/OFF の状態なら同じ object を返して PATCH 短絡を可能にする', () => {
    const alreadyOn = { tenant_banner: 'foreign', ...JP_LOCALIZED_CONTENT };
    const alreadyOff = { tenant_banner: 'foreign', errors: { invalid_field_error: 'custom error' } };

    expect(buildLocalizedContentMerge(alreadyOn, true)).toBe(alreadyOn);
    expect(buildLocalizedContentMerge(alreadyOff, false)).toBe(alreadyOff);
    expect(JSON.stringify(buildLocalizedContentMerge(alreadyOff, false))).toBe(JSON.stringify(alreadyOff));
  });

  test('ON/OFF とも冪等で、null・配列は空 object として安全に扱う', () => {
    const firstOn = buildLocalizedContentMerge({ tenant_banner: 'foreign' }, true);
    expect(buildLocalizedContentMerge(firstOn, true)).toBe(firstOn);

    const firstOff = buildLocalizedContentMerge(firstOn, false);
    expect(buildLocalizedContentMerge(firstOff, false)).toBe(firstOff);
    expect(buildLocalizedContentMerge(null, false)).toEqual({});
    expect(buildLocalizedContentMerge([], true)).toEqual(JP_LOCALIZED_CONTENT);
  });
});
