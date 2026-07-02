/**
 * buildMessage fail-closed + Flex auto-unwrap (findings-audit-2026-07-02 HIGH/flex-image, W5 T-E1/T-E2/T-E3).
 *
 * Covers all three buildMessage copies (broadcast / step-delivery / reminder-delivery):
 *  - text: returned verbatim.
 *  - valid image / flex: returned as the correct Message.
 *  - INVALID image / flex JSON: THROWS MessageBuildError (does NOT fall back to raw-JSON text send).
 *  - flex message-object ({type:'flex',altText,contents}) is auto-unwrapped to contents + altText.
 */
import { describe, test, expect } from 'vitest';
import { buildMessage as buildBroadcast } from './broadcast.js';
import { buildMessage as buildStep } from './step-delivery.js';
import { buildMessage as buildReminder } from './reminder-delivery.js';
import { MessageBuildError } from '../utils/message-build.js';

const impls: Array<[string, typeof buildBroadcast]> = [
  ['broadcast', buildBroadcast],
  ['step-delivery', buildStep],
  ['reminder-delivery', buildReminder],
];

const validImage = JSON.stringify({
  originalContentUrl: 'https://example.com/a.png',
  previewImageUrl: 'https://example.com/a-prev.png',
});
const validFlexContents = JSON.stringify({
  type: 'bubble',
  body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'hello' }] },
});
// The misuse case: full LINE message object pasted from the Flex Simulator.
const flexMessageObject = JSON.stringify({
  type: 'flex',
  altText: 'カスタム通知文',
  contents: {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'hi' }] },
  },
});

for (const [name, buildMessage] of impls) {
  describe(`buildMessage (${name})`, () => {
    test('text is returned verbatim', () => {
      expect(buildMessage('text', 'こんにちは')).toEqual({ type: 'text', text: 'こんにちは' });
    });

    test('valid image JSON returns an image Message', () => {
      const m = buildMessage('image', validImage) as { type: string; originalContentUrl: string };
      expect(m.type).toBe('image');
      expect(m.originalContentUrl).toBe('https://example.com/a.png');
    });

    test('valid flex contents returns a flex Message', () => {
      const m = buildMessage('flex', validFlexContents) as { type: string; contents: { type: string } };
      expect(m.type).toBe('flex');
      expect(m.contents.type).toBe('bubble');
    });

    test('FAIL-CLOSED: invalid image JSON throws MessageBuildError (no raw-JSON text send)', () => {
      expect(() => buildMessage('image', 'not-json{')).toThrow(MessageBuildError);
    });

    test('FAIL-CLOSED: invalid flex JSON throws MessageBuildError (no raw-JSON text send)', () => {
      expect(() => buildMessage('flex', '{broken')).toThrow(MessageBuildError);
    });

    test('FAIL-CLOSED: flex with non-object contents throws (e.g. {"type":"flex","contents":"x"})', () => {
      expect(() => buildMessage('flex', '{"type":"flex","altText":"a","contents":"x"}')).toThrow(MessageBuildError);
    });

    test('FAIL-CLOSED: flex that parses to a bare string throws (contents not an object)', () => {
      expect(() => buildMessage('flex', '"just a string"')).toThrow(MessageBuildError);
    });

    test('FAIL-CLOSED: the raw JSON string is never returned as a text message', () => {
      let sent: unknown;
      try {
        sent = buildMessage('flex', '{broken');
      } catch {
        sent = undefined;
      }
      // must NOT have produced a { type:'text', text:'{broken' } message
      expect(sent).toBeUndefined();
    });

    test('flex message-object ({type:flex,altText,contents}) is auto-unwrapped to contents + altText', () => {
      const m = buildMessage('flex', flexMessageObject) as {
        type: string;
        altText: string;
        contents: { type: string };
      };
      expect(m.type).toBe('flex');
      // contents must be the inner bubble, NOT the wrapping message object
      expect(m.contents.type).toBe('bubble');
      expect((m.contents as Record<string, unknown>).altText).toBeUndefined();
      // altText carried over from the message object
      expect(m.altText).toBe('カスタム通知文');
    });
  });
}
