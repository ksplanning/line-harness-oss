/**
 * T-C4 / A5 / D-2 — broadcast.ts の buildMessage 拡張 (新 type dispatch + fail-loud + sender)。
 *
 * スコープは broadcast 用 impl (broadcast.ts:buildMessage) のみ。新 type(video/audio/imagemap/
 * richvideo) は broadcasts.message_type の CHECK 拡張(054)でしか保存できず、reminder_steps/
 * scenario_steps の CHECK は text/image/flex のまま = reminder-delivery/step-delivery の buildMessage
 * には新 type が到達しない → 両者は無変更。本 test でその分離を behavior で固定する。
 */
import { describe, test, expect } from 'vitest';
import { buildMessage as buildBroadcast } from './broadcast.js';
import { buildMessage as buildStep } from './step-delivery.js';
import { buildMessage as buildReminder } from './reminder-delivery.js';
import { MessageBuildError } from '../utils/message-build.js';

const validVideo = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/p.png' });
const validAudio = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/a.m4a', duration: 60000 });
const validImagemap = JSON.stringify({
  baseUrl: 'https://cdn.example.com/im',
  altText: 'メニュー',
  baseSize: { width: 1040, height: 1040 },
  actions: [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 520, height: 520 } }],
});
const validRichVideo = JSON.stringify({
  baseUrl: 'https://cdn.example.com/im',
  altText: '動画',
  baseSize: { width: 1040, height: 1040 },
  actions: [],
  video: {
    originalContentUrl: 'https://cdn.example.com/v.mp4',
    previewImageUrl: 'https://cdn.example.com/p.png',
    area: { x: 0, y: 0, width: 1040, height: 520 },
    externalLink: { linkUri: 'https://example.com/more', label: '詳しく見る' },
  },
});

describe('T-C4 broadcast buildMessage: new type dispatch (G4/G13/G14)', () => {
  test('video → video Message object', () => {
    const m = buildBroadcast('video', validVideo) as { type: string; originalContentUrl: string; previewImageUrl: string };
    expect(m.type).toBe('video');
    expect(m.originalContentUrl).toBe('https://cdn.example.com/v.mp4');
    expect(m.previewImageUrl).toBe('https://cdn.example.com/p.png');
  });

  test('audio → audio Message object', () => {
    const m = buildBroadcast('audio', validAudio) as { type: string; originalContentUrl: string; duration: number };
    expect(m.type).toBe('audio');
    expect(m.originalContentUrl).toBe('https://cdn.example.com/a.m4a');
    expect(m.duration).toBe(60000);
  });

  test('imagemap → imagemap Message object with actions', () => {
    const m = buildBroadcast('imagemap', validImagemap) as { type: string; baseUrl: string; actions: unknown[] };
    expect(m.type).toBe('imagemap');
    expect(m.baseUrl).toBe('https://cdn.example.com/im');
    expect(m.actions).toHaveLength(1);
  });

  test('T-A2(d): imagemap area 座標は LINE payload に素通しされる (ドラッグ/数値 単一正典の送信保証)', () => {
    // web の buildMediaJson が出力する形と byte 一致する content。ドラッグエディタも数値入力も
    // 同一 s.regions → 同一 JSON を生むため、worker が area を無変換で送ることが round-trip の要。
    const content = JSON.stringify({
      baseUrl: 'https://cdn.example.com/im',
      altText: 'リッチメッセージ',
      baseSize: { width: 1040, height: 520 },
      actions: [
        { type: 'uri', linkUri: 'https://x/lp', area: { x: 0, y: 0, width: 520, height: 520 } },
        { type: 'message', text: 'こんにちは', area: { x: 520, y: 0, width: 520, height: 520 } },
      ],
    });
    const m = buildBroadcast('imagemap', content) as {
      baseSize: { width: number; height: number };
      actions: Array<{ type: string; area: { x: number; y: number; width: number; height: number } }>;
    };
    expect(m.baseSize).toEqual({ width: 1040, height: 520 });
    expect(m.actions[0].area).toEqual({ x: 0, y: 0, width: 520, height: 520 });
    expect(m.actions[1].area).toEqual({ x: 520, y: 0, width: 520, height: 520 });
  });

  test('richvideo → imagemap Message object carrying a video block', () => {
    const m = buildBroadcast('richvideo', validRichVideo) as { type: string; video?: { originalContentUrl: string; externalLink?: { label: string } } };
    expect(m.type).toBe('imagemap');
    expect(m.video?.originalContentUrl).toBe('https://cdn.example.com/v.mp4');
    expect(m.video?.externalLink?.label).toBe('詳しく見る');
  });
});

describe('T-C4 broadcast buildMessage: fail-loud (silent 事故根治)', () => {
  test('FAIL-CLOSED: video missing previewImageUrl throws MessageBuildError', () => {
    expect(() => buildBroadcast('video', JSON.stringify({ originalContentUrl: 'https://x/v.mp4' }))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: audio with non-positive duration throws', () => {
    expect(() => buildBroadcast('audio', JSON.stringify({ originalContentUrl: 'https://x/a.m4a', duration: 0 }))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: invalid video JSON throws', () => {
    expect(() => buildBroadcast('video', 'not-json{')).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: imagemap with missing baseSize throws', () => {
    expect(() => buildBroadcast('imagemap', JSON.stringify({ baseUrl: 'https://x/im', actions: [] }))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: richvideo without a video block throws', () => {
    expect(() => buildBroadcast('richvideo', validImagemap)).toThrow(MessageBuildError);
  });

  test('FAIL-LOUD: unknown message_type throws MessageBuildError (NOT silent text fallback)', () => {
    expect(() => buildBroadcast('xyz', 'some content')).toThrow(MessageBuildError);
    // raw content が text として決して返らない (silent 事故の根治)。
    let sent: unknown;
    try { sent = buildBroadcast('xyz', 'some content'); } catch { sent = undefined; }
    expect(sent).toBeUndefined();
  });
});

describe('T-C4 sender attachment (G25)', () => {
  const sender = { name: 'キャンペーン担当', iconUrl: 'https://cdn.example.com/i.png' };
  test('sender is attached to a text message when provided', () => {
    const m = buildBroadcast('text', 'hi', undefined, sender) as { type: string; sender?: { name: string } };
    expect(m.sender?.name).toBe('キャンペーン担当');
  });
  test('sender is attached to a new-type (video) message', () => {
    const m = buildBroadcast('video', validVideo, undefined, sender) as { sender?: { name: string } };
    expect(m.sender?.name).toBe('キャンペーン担当');
  });
  test('no sender param → message has no sender (default sender = 挙動不変)', () => {
    const m = buildBroadcast('text', 'hi') as { sender?: unknown };
    expect(m.sender).toBeUndefined();
  });
});

describe('T-C4 impl separation: reminder/step buildMessage unchanged (new type unreachable there)', () => {
  test('step-delivery/reminder-delivery still text-fallback on unknown type (proves they are NOT changed)', () => {
    // broadcast は throw、他 2 impl は従来どおり text fallback = 本 batch で無変更。
    expect(buildStep('xyz', 'foo')).toEqual({ type: 'text', text: 'foo' });
    expect(buildReminder('xyz', 'foo')).toEqual({ type: 'text', text: 'foo' });
    expect(() => buildBroadcast('xyz', 'foo')).toThrow(MessageBuildError);
  });
});
