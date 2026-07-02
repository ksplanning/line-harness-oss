/**
 * unwrapFlexMessageObject narrow (line-faq-polish, OPTIONAL-POLISH / message-build narrow).
 *
 * WHY: the previous guard `!contents || typeof contents !== 'object'` fails-OPEN on
 *   - a bare array `[]`            (typeof [] === 'object' → passed)
 *   - `{"contents":null}` wrappers (a non-null object → passed with null inside)
 * so a malformed flex payload could still reach the LINE API. The narrow requires
 * `contents` to be a non-null PLAIN object (Array.isArray excluded). Everything else
 * throws MessageBuildError (fail-CLOSED).
 */
import { describe, test, expect } from 'vitest';
import { unwrapFlexMessageObject, MessageBuildError } from './message-build.js';

describe('unwrapFlexMessageObject narrow (fail-closed)', () => {
  test('valid bare bubble passes through unchanged', () => {
    const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } };
    const r = unwrapFlexMessageObject(bubble);
    expect(r.contents).toEqual(bubble);
    expect(r.altText).toBeUndefined();
  });

  test('flex message-object is unwrapped to its inner contents + altText', () => {
    const inner = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } };
    const r = unwrapFlexMessageObject({ type: 'flex', altText: 'あいさつ', contents: inner });
    expect(r.contents).toEqual(inner);
    expect(r.altText).toBe('あいさつ');
  });

  test('FAIL-CLOSED: null throws', () => {
    expect(() => unwrapFlexMessageObject(null)).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: bare array [] throws (typeof [] === object leak)', () => {
    expect(() => unwrapFlexMessageObject([])).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: non-empty array throws', () => {
    expect(() => unwrapFlexMessageObject([{ type: 'bubble' }])).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: string throws', () => {
    expect(() => unwrapFlexMessageObject('just a string')).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: number throws', () => {
    expect(() => unwrapFlexMessageObject(5)).toThrow(MessageBuildError);
  });

  test('FAIL-CLOSED: flex wrapper whose contents is an array throws', () => {
    expect(() => unwrapFlexMessageObject({ type: 'flex', altText: 'a', contents: [] })).toThrow(
      MessageBuildError,
    );
  });
});
