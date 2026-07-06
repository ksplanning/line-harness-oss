/**
 * batch E (T-E3 / M-3) — hero video を含む Flex メッセージが broadcast.ts の buildMessage を通り、
 * text silent fallback に落ちない (「動画のつもりが JSON/URL が text で飛ぶ」事故の防止)。
 *
 * video は message_type='flex' の contents(bubble.hero=video)として送るため、新 message type は増えず
 * 既存の flex dispatch をそのまま通る。reminder/step の同名 buildMessage は触らない (M-3)。
 */
import { describe, test, expect } from 'vitest';
import { buildMessage } from './broadcast.js';

// 動画 hero を持つ bare Flex contents (builder to-flex が出す形)。
const videoFlex = JSON.stringify({
  type: 'bubble',
  size: 'mega',
  hero: {
    type: 'video',
    url: 'https://example.com/v.mp4',
    previewUrl: 'https://example.com/p.png',
    altContent: { type: 'image', url: 'https://example.com/alt.png', size: 'full', aspectMode: 'cover' },
    aspectRatio: '20:13',
  },
  body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'キャンペーン', wrap: true }] },
});

describe('batch E — video Flex は buildMessage(flex) を通る (M-3 silent fallback なし)', () => {
  test('type:flex で返り、hero video が contents に保持される (text に落ちない)', () => {
    const msg = buildMessage('flex', videoFlex) as { type: string; contents: { hero?: { type?: string; url?: string } }; altText?: string };
    expect(msg.type).toBe('flex'); // ← text ではない
    expect(msg.contents.hero?.type).toBe('video');
    expect(msg.contents.hero?.url).toBe('https://example.com/v.mp4');
    expect(typeof msg.altText).toBe('string'); // altText は自動生成 (body の text から)
  });

  test('altText は body のテキストから拾える', () => {
    const msg = buildMessage('flex', videoFlex) as { altText?: string };
    expect(msg.altText).toContain('キャンペーン');
  });

  test('壊れた video Flex JSON は throw (fail-closed / 生 JSON を text 送信しない)', () => {
    expect(() => buildMessage('flex', '{壊れた')).toThrow();
  });
});
