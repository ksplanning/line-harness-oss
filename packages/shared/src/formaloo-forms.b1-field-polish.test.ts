/**
 * b1-field-polish (T-A1) — 動画窓 field config.height 4層対称 (型/validate/push/pull)。
 *   spike 確定 (evidence/spike-results.md): oembed 既定 config.height=100px の薄帯を config.height で拡大。
 *   push は url + config を常時同送 (url 無 config 単独 PATCH=500)。既定 height は pull で drop (false-drift 回避)。
 *   videoHeight は cosmetic ゆえ fingerprint 非射影 (formaloo-fingerprint.b1-field-polish.test.ts が別途 assert)。
 */
import { describe, test, expect } from 'vitest';
import {
  DEFAULT_VIDEO_HEIGHT,
  validateHarnessField,
  toFormalooFieldPayload,
  fromFormalooField,
  type HarnessField,
} from './formaloo-forms';

const vid = (config: Record<string, unknown>, over: Partial<HarnessField> = {}): HarnessField => ({
  id: 'v1', type: 'video', label: '説明動画', required: false, position: 2, config: config as HarnessField['config'], ...over,
});

describe('b1-field-polish T-A1 — DEFAULT_VIDEO_HEIGHT 定数', () => {
  test('既定は再生可能な高さ (250px・OD-3)', () => {
    expect(DEFAULT_VIDEO_HEIGHT).toBe('250px');
  });
});

describe('b1-field-polish T-A1 — validate videoHeight (whitelist)', () => {
  test('px/vw の 2〜4 桁は受理', () => {
    for (const h of ['250px', '56vw', '350px', '1080px', '75vw']) {
      const r = validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: 'https://youtu.be/x', videoHeight: h } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.field.config.videoHeight).toBe(h);
    }
  });
  test('whitelist 外 (単位無/不正単位/CSS 注入) は reject', () => {
    for (const h of ['250', 'abc', '250em', '1px', '99999px', '100%;color:red', '250px !important', 'calc(100%)']) {
      expect(validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: 'https://youtu.be/x', videoHeight: h } }).ok).toBe(false);
    }
  });
  test('videoHeight 未設定の video は従来どおり受理 (url があれば ok・push が既定補完)', () => {
    const r = validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: 'https://youtu.be/x' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.field.config.videoHeight).toBeUndefined();
  });
  test('非 string videoHeight は reject', () => {
    expect(validateHarnessField({ id: 'v', type: 'video', label: '動画', config: { videoUrl: 'https://youtu.be/x', videoHeight: 250 } }).ok).toBe(false);
  });
});

describe('b1-field-polish T-A1 — push (config.height を url と常時同送)', () => {
  test('videoHeight 設定時は config.height=videoHeight を url と同送', () => {
    const p = toFormalooFieldPayload(vid({ videoUrl: 'https://youtu.be/x', videoHeight: '350px' }));
    expect(p).toEqual({ type: 'oembed', title: '説明動画', url: 'https://youtu.be/x', position: 2, config: { height: '350px' } });
  });
  test('videoHeight 未設定時は config.height=DEFAULT を補完して同送 (既存 video も次回保存で拡大 / OD-4)', () => {
    const p = toFormalooFieldPayload(vid({ videoUrl: 'https://youtu.be/x' }));
    expect(p).toEqual({ type: 'oembed', title: '説明動画', url: 'https://youtu.be/x', position: 2, config: { height: DEFAULT_VIDEO_HEIGHT } });
    expect('url' in p).toBe(true); // url 無いと oembed PATCH=500 (spike 実測)
  });
});

describe('b1-field-polish T-A1 — pull (config.height → videoHeight・既定 drop)', () => {
  test('非既定 config.height を videoHeight に復元', () => {
    const f = fromFormalooField({ slug: 'v1', type: 'oembed', title: '説明動画', position: 2, url: 'https://youtu.be/x', config: { height: '350px' } });
    expect(f?.type).toBe('video');
    expect(f?.config.videoUrl).toBe('https://youtu.be/x');
    expect(f?.config.videoHeight).toBe('350px');
  });
  test('既定 height は drop (videoHeight 未設定 = false-drift ガード)', () => {
    const f = fromFormalooField({ slug: 'v1', type: 'oembed', title: '説明動画', position: 2, url: 'https://youtu.be/x', config: { height: DEFAULT_VIDEO_HEIGHT } });
    expect(f?.config.videoHeight).toBeUndefined();
  });
  test('config 欠落 / height 非 string は videoHeight を復元しない', () => {
    expect(fromFormalooField({ slug: 'v1', type: 'oembed', title: 't', position: 0, url: 'https://youtu.be/x' })?.config.videoHeight).toBeUndefined();
    expect(fromFormalooField({ slug: 'v1', type: 'oembed', title: 't', position: 0, url: 'https://youtu.be/x', config: { height: 350 } })?.config.videoHeight).toBeUndefined();
  });
});

describe('b1-field-polish T-A1 — round-trip 対称 (明示 height)', () => {
  test('videoHeight 明示は push→pull で保つ', () => {
    const original = vid({ videoUrl: 'https://youtu.be/x', videoHeight: '350px' });
    const pushed = toFormalooFieldPayload(original);
    const asRead = { ...pushed, slug: original.id };
    expect(fromFormalooField(asRead, (s) => s)).toEqual(original);
  });
});
