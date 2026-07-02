/**
 * Shared helpers for buildMessage() fail-closed behavior + Flex auto-unwrap.
 *
 * WHY (findings-audit-2026-07-02, HIGH/flex-image):
 *   buildMessage() used to catch a JSON.parse failure on image/flex content and
 *   *silently fall back to sending the raw JSON string as a `type:'text'` message*.
 *   That is the structural cause of "JSON が LINE に出る" — a fail-OPEN behavior.
 *
 *   MessageBuildError makes that path fail-CLOSED: parse failure throws, and each
 *   delivery loop skips that message + logs the error instead of shipping raw JSON.
 *
 *   unwrapFlexMessageObject fixes the "Flex Message Simulator の message object
 *   丸ごと貼付" misuse (MEDIUM/flex-image): users paste
 *   {"type":"flex","altText":...,"contents":{bubble}} but the field only wants the
 *   `contents` (bubble/carousel). We defensively unwrap it (and carry altText over).
 */

/** Thrown by buildMessage() when image/flex content cannot be parsed into a valid Message. */
export class MessageBuildError extends Error {
  readonly messageType: string;
  constructor(messageType: string, cause?: unknown) {
    super(
      `メッセージ構築失敗: message_type='${messageType}' の内容が不正な JSON のため送信をスキップします (raw JSON は送信しません)`,
    );
    this.name = 'MessageBuildError';
    this.messageType = messageType;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * If the parsed flex payload is a full LINE *message object*
 * ({ type:'flex', altText, contents }) instead of the bare contents
 * (bubble/carousel), unwrap it to the contents and surface the altText.
 *
 * Returns { contents: object, altText? }. For already-bare contents, returns it unchanged.
 *
 * Throws MessageBuildError if the resolved contents is not a non-null object
 * (e.g. {"type":"flex","contents":"x"} or a bare string/number) — this keeps a
 * malformed flex payload from reaching the LINE API as an invalid Message.
 */
export function unwrapFlexMessageObject(parsed: unknown): {
  contents: object;
  altText?: string;
} {
  let contents: unknown = parsed;
  let altText: string | undefined;

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).type === 'flex' &&
    (parsed as Record<string, unknown>).contents
  ) {
    const obj = parsed as Record<string, unknown>;
    contents = obj.contents;
    altText = typeof obj.altText === 'string' ? obj.altText : undefined;
  }

  // contents must be a non-null object (bubble/carousel). Reject strings/numbers/null/arrays-of-primitives.
  if (!contents || typeof contents !== 'object') {
    throw new MessageBuildError('flex');
  }

  return { contents: contents as object, altText };
}
