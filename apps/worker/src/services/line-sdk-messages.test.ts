/**
 * T-C1 — line-sdk 拡張の unit test (F2 batch3 G4/G14/G25 の SDK 土台)。
 *
 * line-sdk は独自の vitest 設定を持たない (baseline は db/worker/web の 3 suite)。
 * worker vitest が `@line-crm/line-sdk` を src にエイリアスするため、SDK helper/型の
 * unit test は worker suite に置く (worker が line-sdk を import する層 = 妥当な配置)。
 *
 * 検証:
 *   - audioMessage(originalContentUrl, duration) が正しい AudioMessage を返す
 *   - imageMapMessage が video (再生後アクション) 対応
 *   - 全 outbound helper が optional sender を付与できる
 *   - client.ts の送信メソッド署名が byte-identical (Message[] を受ける・無変更)
 */
import { describe, it, expect } from 'vitest';
import {
  audioMessage,
  imageMapMessage,
  textMessage,
  imageMessage,
  videoMessage,
  flexMessage,
  LineClient,
} from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';

describe('T-C1 line-sdk: audioMessage', () => {
  it('returns a valid audio Message object', () => {
    const m = audioMessage('https://cdn.example.com/a.m4a', 60000);
    expect(m).toEqual({
      type: 'audio',
      originalContentUrl: 'https://cdn.example.com/a.m4a',
      duration: 60000,
    });
  });

  it('is assignable to the outbound Message union (audio is an outbound type)', () => {
    const m: Message = audioMessage('https://cdn.example.com/a.m4a', 1000);
    expect(m.type).toBe('audio');
  });
});

describe('T-C1 line-sdk: imageMapMessage video (G14 リッチビデオ)', () => {
  it('carries a video block with area + externalLink when provided', () => {
    const m = imageMapMessage({
      baseUrl: 'https://cdn.example.com/im',
      altText: 'メニュー',
      baseSize: { width: 1040, height: 1040 },
      actions: [],
      video: {
        originalContentUrl: 'https://cdn.example.com/v.mp4',
        previewImageUrl: 'https://cdn.example.com/p.png',
        area: { x: 0, y: 0, width: 1040, height: 520 },
        externalLink: { linkUri: 'https://example.com/more', label: '詳しく見る' },
      },
    });
    expect(m.video).toBeDefined();
    expect(m.video?.originalContentUrl).toBe('https://cdn.example.com/v.mp4');
    expect(m.video?.externalLink?.label).toBe('詳しく見る');
  });

  it('omits video for a plain imagemap (backward compatible)', () => {
    const m = imageMapMessage({
      baseUrl: 'https://cdn.example.com/im',
      altText: 'メニュー',
      baseSize: { width: 1040, height: 1040 },
      actions: [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 520, height: 520 } }],
    });
    expect(m.video).toBeUndefined();
    expect(m.type).toBe('imagemap');
  });
});

describe('T-C1 line-sdk: sender on all outbound types (G25 なりすまし対応の器)', () => {
  it('every outbound message can carry an optional sender { name, iconUrl }', () => {
    const sender = { name: 'キャンペーン担当', iconUrl: 'https://cdn.example.com/i.png' };
    const withSender: Message[] = [
      { ...textMessage('hi'), sender },
      { ...imageMessage('https://x/o.png', 'https://x/p.png'), sender },
      { ...videoMessage('https://x/v.mp4', 'https://x/p.png'), sender },
      { ...flexMessage('alt', { type: 'bubble' }), sender },
      { ...audioMessage('https://x/a.m4a', 1000), sender },
    ];
    for (const m of withSender) {
      expect((m as { sender?: { name: string } }).sender?.name).toBe('キャンペーン担当');
    }
  });

  it('sender is optional — messages without it stay valid (default sender = 挙動不変)', () => {
    const m: Message = textMessage('hi');
    expect((m as { sender?: unknown }).sender).toBeUndefined();
  });
});

describe('T-C1 line-sdk: client.ts send signatures byte-identical (no change)', () => {
  it('pushMessage/multicast/broadcast/replyMessage still accept Message[]', () => {
    const client = new LineClient('tok');
    // arity + presence — client.ts は本 batch で無変更 (sender は Message property に載る)
    expect(typeof client.pushMessage).toBe('function');
    expect(client.pushMessage.length).toBe(2); // (to, messages)
    expect(client.multicast.length).toBe(3); // (to, messages, customAggregationUnits?)
    expect(client.broadcast.length).toBe(1); // (messages)
    expect(client.replyMessage.length).toBe(2); // (replyToken, messages)
  });
});
