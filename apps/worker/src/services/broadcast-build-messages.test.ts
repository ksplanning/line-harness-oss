/**
 * C4 — buildBroadcastMessages(broadcast, liffId): Message[] (fail-closed 厳格)。
 *
 *  - messages 非NULL → Message[](len N)・要素順序保存・renderMessageContent を要素単位に適用。
 *  - messages NULL → 従来 single と byte 等価な単一要素配列 (fallback は NULL のときだけ)。
 *  - 非NULL の不正値 (parse失敗 / 非配列 / 空 / len>5 / 未知 type / 要素 unbuildable) は
 *    MessageBuildError を throw して single に落ちない (codex HIGH #3)。
 */
import { describe, it, expect } from 'vitest';
import type { Broadcast } from '@line-crm/db';
import { buildBroadcastMessages, buildMessage } from './broadcast.js';
import { renderMessageContent } from './render-message.js';
import { MessageBuildError } from '../utils/message-build.js';

const IMG = '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}';

function bc(fields: Partial<Broadcast> & Record<string, unknown>): Broadcast {
  return {
    id: 'b1', title: 'T', message_type: 'text', message_content: 'hi', target_type: 'all',
    ...fields,
  } as unknown as Broadcast;
}

describe('buildBroadcastMessages', () => {
  it('builds Message[] for a non-NULL messages combo (order preserved)', () => {
    const messages = JSON.stringify([
      { type: 'image', content: IMG },
      { type: 'text', content: 'せつめい' },
      { type: 'text', content: 'ボーナス' },
    ]);
    const out = buildBroadcastMessages(bc({ message_type: 'image', message_content: IMG, messages }), null);
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('image');
    expect(out[1]).toEqual({ type: 'text', text: 'せつめい' });
    expect(out[2]).toEqual({ type: 'text', text: 'ボーナス' });
  });

  it('messages NULL → single-element array byte-equal to legacy buildMessage', () => {
    const single = bc({ message_type: 'text', message_content: 'こんにちは {{liff_id}}', messages: null, alt_text: undefined });
    const out = buildBroadcastMessages(single, 'LIFF123');
    expect(out).toEqual([buildMessage('text', renderMessageContent('こんにちは {{liff_id}}', 'LIFF123'), undefined)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'text', text: 'こんにちは LIFF123' });
  });

  it('messages undefined (column absent / projection 渡し忘れ) → throw (F1: undefined は null と別・silent single 禁止)', () => {
    // 構造契約: fallback は messages === null のときだけ。undefined は projection の渡し忘れの兆候ゆえ
    // silent single に落とさず throw する (compiler は非 optional 型で渡し忘れを弾くが、runtime backstop)。
    expect(() => buildBroadcastMessages(bc({ message_type: 'text', message_content: 'hi' }), null)).toThrow(MessageBuildError);
  });

  it('applies renderMessageContent per element ({{liff_id}} replaced in each)', () => {
    const messages = JSON.stringify([
      { type: 'text', content: 'a {{liff_id}}' },
      { type: 'text', content: 'b {{liff_id}}' },
    ]);
    const out = buildBroadcastMessages(bc({ messages }), 'L9');
    expect(out[0]).toEqual({ type: 'text', text: 'a L9' });
    expect(out[1]).toEqual({ type: 'text', text: 'b L9' });
  });

  it('keeps recipient variables literal in single broadcast while replacing liff_id', () => {
    const single = bc({
      message_type: 'text',
      message_content: '{{display_name|お客様}} / {{field:会員ランク|未設定}} / {{liff_id}}',
      messages: null,
    });

    expect(buildBroadcastMessages(single, 'LIFF-B')).toEqual([{
      type: 'text',
      text: '{{display_name|お客様}} / {{field:会員ランク|未設定}} / LIFF-B',
    }]);
  });

  it('keeps recipient variables literal in combo broadcast elements', () => {
    const messages = JSON.stringify([
      { type: 'text', content: '{{display_name}} {{liff_id}}' },
      { type: 'text', content: '{{field:会員ランク|未設定}} {{liff_id}}' },
    ]);

    expect(buildBroadcastMessages(bc({ messages }), 'LIFF-C')).toEqual([
      { type: 'text', text: '{{display_name}} LIFF-C' },
      { type: 'text', text: '{{field:会員ランク|未設定}} LIFF-C' },
    ]);
  });

  it('len5 OK', () => {
    const messages = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ type: 'text', content: `m${i}` })));
    expect(buildBroadcastMessages(bc({ messages }), null)).toHaveLength(5);
  });

  it('len6 → throw MessageBuildError (does not fall back to single)', () => {
    const messages = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ type: 'text', content: `m${i}` })));
    expect(() => buildBroadcastMessages(bc({ messages }), null)).toThrow(MessageBuildError);
  });

  it('non-NULL broken JSON → throw (fail-closed, not silent single)', () => {
    expect(() => buildBroadcastMessages(bc({ message_type: 'text', message_content: 'hi', messages: '{not json' }), null)).toThrow(MessageBuildError);
  });

  it('empty array → throw', () => {
    expect(() => buildBroadcastMessages(bc({ messages: '[]' }), null)).toThrow(MessageBuildError);
  });

  it('unknown element type → throw (buildMessage fail-loud propagates)', () => {
    const messages = JSON.stringify([{ type: 'text', content: 'ok' }, { type: 'sticker', content: 'x' }]);
    expect(() => buildBroadcastMessages(bc({ messages }), null)).toThrow(MessageBuildError);
  });

  it('non-array element / broken image element → throw', () => {
    expect(() => buildBroadcastMessages(bc({ messages: JSON.stringify(['notanobject']) }), null)).toThrow(MessageBuildError);
    expect(() => buildBroadcastMessages(bc({ messages: JSON.stringify([{ type: 'image', content: '{bad' }]) }), null)).toThrow(MessageBuildError);
  });
});
