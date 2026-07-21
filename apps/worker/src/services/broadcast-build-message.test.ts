/**
 * T-C4 / A5 / D-2 — broadcast.ts の buildMessage 拡張 (新 type dispatch + fail-loud + sender)。
 *
 * D-3 では template pack を auto-reply へ展開した後も同じ outbound renderer を通す。
 * broadcast と step/auto-reply の両方で media/sticker を同じ LINE Message に変換し、
 * 未知 type や壊れた JSON は text fallback せず fail-loud にする契約を固定する。
 */
import { describe, test, expect } from 'vitest';
import { buildMessage as buildBroadcast } from './broadcast.js';
import { buildMessage as buildStep } from './step-delivery.js';
import { buildMessage as buildReminder } from './reminder-delivery.js';
import { MessageBuildError } from '../utils/message-build.js';

const validVideo = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/p.png' });
const validAudio = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/a.m4a', duration: 60000 });
const validSticker = JSON.stringify({ packageId: '11537', stickerId: '52002734' });
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
const legacyFlexWithLineDeepLink = JSON.stringify({
  type: 'bubble',
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [{
      type: 'button',
      action: { type: 'uri', label: 'LINEを開く', uri: 'line://nv/location' },
    }],
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

  test('sticker → outbound sticker Message object', () => {
    const m = buildBroadcast('sticker', validSticker) as { type: string; packageId: string; stickerId: string };
    expect(m).toEqual({ type: 'sticker', packageId: '11537', stickerId: '52002734' });
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
  test('FAIL-CLOSED: sticker missing packageId throws', () => {
    expect(() => buildBroadcast('sticker', JSON.stringify({ stickerId: '52002734' }))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: sticker IDs must be numeric LINE IDs', () => {
    expect(() => buildBroadcast('sticker', JSON.stringify({ packageId: 'abc', stickerId: 'xyz' }))).toThrow(MessageBuildError);
  });
  test.each([
    [{}, 'missing action type and area'],
    [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 1041, height: 10 } }, 'area outside base image'],
    [{ type: 'message', text: '', area: { x: 0, y: 0, width: 10, height: 10 } }, 'empty message action'],
  ])('FAIL-CLOSED: imagemap rejects malformed action ($1)', (action) => {
    expect(() => buildBroadcast('imagemap', JSON.stringify({
      baseUrl: 'https://x/im',
      baseSize: { width: 1040, height: 1040 },
      actions: [action],
    }))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: richvideo requires a valid video area', () => {
    const parsed = JSON.parse(validRichVideo) as Record<string, unknown>;
    parsed.video = {
      originalContentUrl: 'https://cdn.example.com/v.mp4',
      previewImageUrl: 'https://cdn.example.com/p.png',
    };
    expect(() => buildBroadcast('richvideo', JSON.stringify(parsed))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: imagemap validates an optional video block when present', () => {
    const parsed = JSON.parse(validImagemap) as Record<string, unknown>;
    parsed.video = {};
    expect(() => buildBroadcast('imagemap', JSON.stringify(parsed))).toThrow(MessageBuildError);
  });
  test('FAIL-CLOSED: richvideo without a video block throws', () => {
    expect(() => buildBroadcast('richvideo', validImagemap)).toThrow(MessageBuildError);
  });

  test.each([
    [{ type: 'message', text: 'あ'.repeat(401), area: { x: 0, y: 0, width: 10, height: 10 } }, 'message text > 400'],
    [{ type: 'clipboard', clipboardText: 'a'.repeat(1001), area: { x: 0, y: 0, width: 10, height: 10 } }, 'clipboard > 1000'],
    [{ type: 'uri', linkUri: `https://${'a'.repeat(993)}`, area: { x: 0, y: 0, width: 10, height: 10 } }, 'linkUri > 1000'],
    [{ type: 'uri', label: 'a'.repeat(101), linkUri: 'https://example.com', area: { x: 0, y: 0, width: 10, height: 10 } }, 'action label > 100'],
  ])('FAIL-CLOSED: imagemap rejects official action character-limit overage ($1)', (action) => {
    expect(() => buildBroadcast('imagemap', JSON.stringify({
      baseUrl: 'https://x/im',
      baseSize: { width: 1040, height: 1040 },
      actions: [action],
    }))).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: imagemap URL and altText official limits are enforced', () => {
    const parsed = JSON.parse(validImagemap) as Record<string, unknown>;
    parsed.baseUrl = `https://${'a'.repeat(1993)}`;
    expect(() => buildBroadcast('imagemap', JSON.stringify(parsed))).toThrow(MessageBuildError);
    expect(() => buildBroadcast('imagemap', validImagemap, 'あ'.repeat(1501))).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: richvideo URL and external label official limits are enforced', () => {
    const tooLongLabel = JSON.parse(validRichVideo) as Record<string, unknown>;
    (tooLongLabel.video as { externalLink: { label: string } }).externalLink.label = 'あ'.repeat(31);
    expect(() => buildBroadcast('richvideo', JSON.stringify(tooLongLabel))).toThrow(MessageBuildError);

    const tooLongVideoUrl = JSON.parse(validRichVideo) as Record<string, unknown>;
    (tooLongVideoUrl.video as { originalContentUrl: string }).originalContentUrl = `https://${'a'.repeat(1993)}`;
    expect(() => buildBroadcast('richvideo', JSON.stringify(tooLongVideoUrl))).toThrow(MessageBuildError);
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

describe('D-3 shared outbound renderer: step/auto-reply accepts pack media and fails loud', () => {
  test.each([
    ['video', validVideo, 'video'],
    ['audio', validAudio, 'audio'],
    ['imagemap', validImagemap, 'imagemap'],
    ['sticker', validSticker, 'sticker'],
  ])('%s pack item builds the same outbound type on the step/auto-reply path', (messageType, content, expectedType) => {
    expect(buildStep(messageType, content).type).toBe(expectedType);
  });

  test.each([
    ['video', '{broken'],
    ['audio', JSON.stringify({ originalContentUrl: 'https://x/a.m4a', duration: 0 })],
    ['imagemap', JSON.stringify({ baseUrl: 'https://x/im', actions: [] })],
    ['sticker', JSON.stringify({ stickerId: '52002734' })],
    ['unknown', 'raw content'],
  ])('%s is fail-loud on the step/auto-reply path instead of becoming text', (messageType, content) => {
    expect(() => buildStep(messageType, content)).toThrow(MessageBuildError);
  });

  test('invalid Flex and text over LINE 5000-character limit fail before pack/auto-reply send', () => {
    expect(() => buildStep('flex', '{}')).toThrow(MessageBuildError);
    expect(() => buildStep('text', 'あ'.repeat(5001))).toThrow(MessageBuildError);
    expect(() => buildBroadcast('text', 'あ'.repeat(5001))).toThrow(MessageBuildError);
  });

  test.each([null, {}, { type: 'box' }])(
    'Flex carousel rejects a non-bubble child at send-time structure gate (%j)',
    (invalidChild) => {
      expect(() => buildStep('flex', JSON.stringify({
        type: 'carousel',
        contents: [invalidChild],
      }))).toThrow(MessageBuildError);
    },
  );

  test('legacy Flex with a line:// deep link remains sendable on every shared-renderer path', () => {
    const broadcast = buildBroadcast('flex', legacyFlexWithLineDeepLink, '従来リンク');
    const step = buildStep('flex', legacyFlexWithLineDeepLink, '従来リンク');

    expect(broadcast).toMatchObject({
      type: 'flex',
      altText: '従来リンク',
      contents: {
        body: {
          contents: [{ action: { uri: 'line://nv/location' } }],
        },
      },
    });
    expect(step).toEqual(broadcast);
  });

  test('reminder remains outside this pack/auto-reply expansion', () => {
    expect(buildReminder('xyz', 'foo')).toEqual({ type: 'text', text: 'foo' });
  });
});
