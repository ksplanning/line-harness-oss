/**
 * treasure-b1-palette — rating / signature / video(oembed) の 4 層対称 (弾S maxSizeKb 前例踏襲)。
 *
 *   rating (入力型 / Formaloo type=rating + sub_type)
 *     T-A1 型定義 + 逆引き対称     T-A2 validate (sub_type whitelist / 既定 star)
 *     T-A3 push (sub_type 未設定 drop) T-A4 pull (star drop)  T-A5 round-trip 対称 (5 sub_type)
 *   signature (入力型 / Formaloo type=signature・固有 config なし)
 *     T-B1 型定義 + 逆引き対称     T-B2 push/pull round-trip (bare)
 *   video (装飾型 / Formaloo type=oembed + url・meta ではない)
 *     T-C1 装飾登録 + type='oembed'  T-C2 validate (url 非空 string / required false / 空=保存 hold)
 *     T-C3 push (url 常時 emit=PATCH500回避)  T-C4 pull (oembed→video round-trip)
 *     T-C5 装飾として page-segment/logic 経路で skip (isDecorationType 経由)
 *
 * 既存 10+2 型・既存フォームの byte 不変は formaloo-forms.test.ts / R-2 fingerprint test が担保。
 */
import { describe, test, expect } from 'vitest';
import {
  FORMALOO_FIELD_TYPES,
  DECORATION_FIELD_TYPES,
  HARNESS_TO_FORMALOO_TYPE,
  FORMALOO_TO_HARNESS_TYPE,
  isDecorationType,
  validateHarnessField,
  computeRouteTerminalWarnings,
  type HarnessField,
  type HarnessLogicRule,
} from './formaloo-forms';

function field(type: HarnessField['type'], config: Record<string, unknown> = {}, over: Partial<HarnessField> = {}): HarnessField {
  return { id: `${type}1`, type, label: type, required: false, position: 0, config: config as HarnessField['config'], ...over };
}

// =============================================================================
// rating — 型定義 + validate (C1)
// =============================================================================
describe('B1 rating — 型定義 + 逆引き対称 (T-A1)', () => {
  test('FORMALOO_FIELD_TYPES に rating を含む', () => {
    expect((FORMALOO_FIELD_TYPES as readonly string[]).includes('rating')).toBe(true);
  });
  test('HARNESS_TO_FORMALOO_TYPE.rating==="rating" / 逆引き rating==="rating"', () => {
    expect(HARNESS_TO_FORMALOO_TYPE.rating).toBe('rating');
    expect(FORMALOO_TO_HARNESS_TYPE.rating).toBe('rating');
  });
});

describe('B1 rating — validate sub_type whitelist (T-A2)', () => {
  test.each(['star', 'like_dislike', 'nps', 'score', 'embeded'])('sub_type=%s は ok', (sub) => {
    const r = validateHarnessField({ id: 'r', type: 'rating', label: '評価', config: { ratingSubType: sub } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.field.config.ratingSubType).toBe(sub);
  });
  test('範囲外 sub_type (numerical) は reject', () => {
    expect(validateHarnessField({ id: 'r', type: 'rating', label: '評価', config: { ratingSubType: 'numerical' } }).ok).toBe(false);
  });
  test('非 string sub_type は reject', () => {
    expect(validateHarnessField({ id: 'r', type: 'rating', label: '評価', config: { ratingSubType: 5 } }).ok).toBe(false);
  });
  test('ratingSubType 未定義は ok (既定 star / config に載らない)', () => {
    const r = validateHarnessField({ id: 'r', type: 'rating', label: '評価', config: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect('ratingSubType' in r.field.config).toBe(false);
  });
});

// =============================================================================
// signature — 型定義 (C1)
// =============================================================================
describe('B1 signature — 型定義 + 逆引き対称 (T-B1)', () => {
  test('FORMALOO_FIELD_TYPES に signature を含む', () => {
    expect((FORMALOO_FIELD_TYPES as readonly string[]).includes('signature')).toBe(true);
  });
  test('HARNESS_TO_FORMALOO_TYPE.signature==="signature" / 逆引き対称', () => {
    expect(HARNESS_TO_FORMALOO_TYPE.signature).toBe('signature');
    expect(FORMALOO_TO_HARNESS_TYPE.signature).toBe('signature');
  });
  test('signature は固有 config を持たない (validate は標準のみ)', () => {
    const r = validateHarnessField({ id: 's', type: 'signature', label: 'サイン', required: true, config: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.field.type).toBe('signature');
      expect(r.field.required).toBe(true); // 入力型ゆえ required 有意
      expect(r.field.config).toEqual({});
    }
  });
});

// =============================================================================
// video — 装飾登録 + validate (C1)
// =============================================================================
describe('B1 video — 装飾登録 + type=oembed (T-C1)', () => {
  test('DECORATION_FIELD_TYPES に video を含む / isDecorationType(video)=true', () => {
    expect((DECORATION_FIELD_TYPES as readonly string[]).includes('video')).toBe(true);
    expect(isDecorationType('video')).toBe(true);
  });
  test('HARNESS_TO_FORMALOO_TYPE.video==="oembed" (meta ではない)', () => {
    expect(HARNESS_TO_FORMALOO_TYPE.video).toBe('oembed');
  });
  test('oembed は逆引きに載らない (装飾ゆえ explicit 分岐で扱う)', () => {
    expect(FORMALOO_TO_HARNESS_TYPE.oembed).toBeUndefined();
  });
});

describe('B1 video — validate (T-C2)', () => {
  test('videoUrl 非空 string は ok・required は false 強制 (装飾)', () => {
    const r = validateHarnessField({ id: 'v', type: 'video', label: '動画', required: true, config: { videoUrl: 'https://youtu.be/abc' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.field.config.videoUrl).toBe('https://youtu.be/abc');
      expect(r.field.required).toBe(false); // isDecorationType 分岐で false 強制
    }
  });
  test('非 string videoUrl は reject', () => {
    expect(validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: 123 } }).ok).toBe(false);
  });
  test('空 videoUrl は保存 hold (reject — 空 url push=500 の元)', () => {
    expect(validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: '' } }).ok).toBe(false);
  });
  test('videoUrl 未設定の video も保存 hold (reject — url 必須)', () => {
    expect(validateHarnessField({ id: 'v', type: 'video', label: '動画', config: {} }).ok).toBe(false);
  });
});

describe('B1 video — 装飾として page-segment/logic で skip (T-C5)', () => {
  test('video は最終入力に数えられない (submit-close ルートで なだれ込み警告なし)', () => {
    // seg1(=jump 先) の最終「入力」は q2 (video ではない)。q2 が submit-close ゆえ なだれ込み無し。
    // video が誤って入力扱いなら seg1 最終入力=video (非 submit) → なだれ込み警告が誤発火する。
    const fields: HarnessField[] = [
      field('text', {}, { id: 'q1', position: 0 }),
      field('page_break', {}, { id: 'p1', position: 1 }),
      field('text', {}, { id: 'q2', position: 2 }),
      field('video', { videoUrl: 'https://youtu.be/x' }, { id: 'vid', position: 3 }),
      field('page_break', {}, { id: 'p2', position: 4 }),
      field('text', {}, { id: 'q3', position: 5 }),
    ];
    const logic: HarnessLogicRule[] = [
      { id: 'j1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'p1' },
      { id: 's1', sourceFieldId: 'q2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' },
    ];
    const warnings = computeRouteTerminalWarnings(fields, logic, 'multi_step');
    expect(warnings.some((w) => w.includes('なだれ込み'))).toBe(false);
  });
});
