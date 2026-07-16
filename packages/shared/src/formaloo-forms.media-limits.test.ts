/**
 * form-media-limits (Batch A / T-A1〜T-A5) — file field 最大サイズ maxSizeKb の 4 層対称 + 既定 2048 ガード。
 *   T-A1 validateHarnessField: 範囲クランプ [256,102400] / 非 number reject
 *   T-A2 toFormalooFieldPayload: 未設定は max_size を送らない / 設定時のみ送る (push 後方互換 byte 不変)
 *   T-A3 fromFormalooField: max_size pull / 既定 2048・未載は set しない (pull 後方互換ガード)
 *   T-A4 round-trip: save→push→pull で maxSizeKb が安定往復 (対称)
 *   T-A5 後方互換 100%: maxSizeKb 無しの既存 file field は push payload / pull config が実装前と byte 一致
 */
import { describe, test, expect } from 'vitest';
import {
  toFormalooFieldPayload,
  fromFormalooField,
  validateHarnessField,
  type HarnessField,
} from './formaloo-forms';

function fileField(config: Record<string, unknown> = {}): HarnessField {
  return { id: 'file1', type: 'file', label: '添付', required: false, position: 0, config: config as HarnessField['config'] };
}

describe('form-media-limits — validateHarnessField.maxSizeKb (T-A1)', () => {
  test('下限 256KB 未満は 256 にクランプ', () => {
    const r = validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: 255 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.field.config.maxSizeKb).toBe(256);
  });
  test('上限 102400KB 超は 102400 にクランプ (spike API 受理上限)', () => {
    const r = validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: 200000 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.field.config.maxSizeKb).toBe(102400);
  });
  test('範囲内 (10240=10MB) はそのまま保持', () => {
    const r = validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: 10240 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.field.config.maxSizeKb).toBe(10240);
  });
  test('非 number は reject (ok:false)', () => {
    const r = validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: 'x' } });
    expect(r.ok).toBe(false);
  });
  test('NaN / Infinity は reject (Number.isFinite ガード)', () => {
    expect(validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: Number.NaN } }).ok).toBe(false);
    expect(validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { maxSizeKb: Number.POSITIVE_INFINITY } }).ok).toBe(false);
  });
  test('未設定は maxSizeKb を持たない (既存 file field 非退行)', () => {
    const r = validateHarnessField({ id: 'f', type: 'file', label: '添付', config: { allowMultipleFiles: true, allowedExtensions: ['pdf'] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect('maxSizeKb' in r.field.config).toBe(false);
  });
});

describe('form-media-limits — toFormalooFieldPayload.max_size (T-A2)', () => {
  test('maxSizeKb 未設定なら max_size を送らない (push byte 不変)', () => {
    const p = toFormalooFieldPayload(fileField({ allowMultipleFiles: false }));
    expect('max_size' in p).toBe(false);
  });
  test('maxSizeKb 設定時のみ max_size を送る', () => {
    const p = toFormalooFieldPayload(fileField({ maxSizeKb: 10240 }));
    expect(p.max_size).toBe(10240);
  });
});

describe('form-media-limits — fromFormalooField.maxSizeKb (T-A3 / 既定2048ガード)', () => {
  test('max_size 未載なら maxSizeKb は undefined', () => {
    const f = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0 });
    expect(f?.config.maxSizeKb).toBeUndefined();
  });
  test('max_size=2048 (既定) は maxSizeKb を set しない (後方互換ガード)', () => {
    const f = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, max_size: 2048 });
    expect(f?.config.maxSizeKb).toBeUndefined();
  });
  test('max_size=20480 (引上げ) は maxSizeKb=20480 に読み戻す', () => {
    const f = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, max_size: 20480 });
    expect(f?.config.maxSizeKb).toBe(20480);
  });
  test('非 number max_size は無視 (Number.isFinite ガード)', () => {
    const f = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, max_size: 'big' });
    expect(f?.config.maxSizeKb).toBeUndefined();
  });
});

describe('form-media-limits — max_size round-trip 対称 (T-A4)', () => {
  test('maxSizeKb=20480 が push→pull で安定往復', () => {
    const p = toFormalooFieldPayload(fileField({ maxSizeKb: 20480 }));
    expect(p.max_size).toBe(20480);
    // 擬似 Formaloo field (form-detail read-shape) で読み戻す
    const back = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, max_size: 20480 });
    expect(back?.config.maxSizeKb).toBe(20480);
  });
});

describe('form-media-limits — 後方互換 100% (T-A5 / byte 不変)', () => {
  // maxSizeKb 実装前の期待値 fixture (allowMultipleFiles/allowedExtensions のみ持つ既存 file field)。
  test('既存 file field の push payload に max_size キーが現れない (push byte 不変)', () => {
    const p = toFormalooFieldPayload(fileField({ allowMultipleFiles: true, allowedExtensions: ['pdf', 'png'] }));
    // 実装前と同一: type/title/required/position/allow_multiple_files/allowed_extensions のみ・max_size 無し
    expect(p).toEqual({
      type: 'file',
      title: '添付',
      required: false,
      position: 0,
      allow_multiple_files: true,
      allowed_extensions: ['pdf', 'png'],
    });
    expect('max_size' in p).toBe(false);
  });
  test('既存 file field (max_size 無/=2048) の pull config が実装前と deep-equal', () => {
    const noMax = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, allow_multiple_files: true, allowed_extensions: ['pdf'] });
    const default2048 = fromFormalooField({ slug: 'file1', type: 'file', title: '添付', required: false, position: 0, allow_multiple_files: true, allowed_extensions: ['pdf'], max_size: 2048 });
    // maxSizeKb は載らない (既定ガード) → 両者の config は maxSizeKb 実装前と同一
    expect(noMax?.config).toEqual({ allowMultipleFiles: true, allowedExtensions: ['pdf'] });
    expect(default2048?.config).toEqual({ allowMultipleFiles: true, allowedExtensions: ['pdf'] });
  });
});
