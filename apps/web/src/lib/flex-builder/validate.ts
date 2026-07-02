/**
 * validateFlex — 保存前に LINE Flex 制約違反を検出する純関数ゲート。
 *
 * WHY: 「送信時に初めて失敗する」経路を潰す (failure_observable)。制約違反は保存をブロックし、
 *   運用者に日本語の依頼形エラーを返す (おばあちゃん基準: 責めない・専門語を出さない)。
 *
 * 数値の pin は constants.ts (LINE 公式リファレンス出典明記) を参照。
 */
import type { FlexContents, FlexBubble, FlexNode, ValidationError, ValidationResult } from './types';
import {
  MAX_CAROUSEL_BUBBLES,
  MAX_TEXT_LENGTH,
  MAX_ALT_TEXT_LENGTH,
  MAX_BOX_NEST_DEPTH,
} from './constants';

interface ValidateOptions {
  /** 明示 altText を持たせる設計のとき渡す。未指定なら buildMessage が自動生成するので検証しない。 */
  altText?: string;
}

function collectBubbles(contents: FlexContents): FlexBubble[] {
  if (contents.type === 'carousel') return contents.contents;
  return [contents];
}

function walkNodes(node: FlexNode | undefined, depth: number, errors: ValidationError[]): void {
  if (!node) return;
  if (depth > MAX_BOX_NEST_DEPTH) {
    errors.push({ code: 'box_too_deep', messageJa: 'カードの入れ子が深すぎます。構成を簡単にしてください。' });
    return;
  }
  if (node.type === 'text') {
    const text = node.text ?? '';
    if (text.length === 0) {
      errors.push({ code: 'text_empty', messageJa: '空の文字があります。文字を入れるか、その部品を消してください。' });
    } else if (text.length > MAX_TEXT_LENGTH) {
      errors.push({
        code: 'text_too_long',
        messageJa: `文字が長すぎます。${MAX_TEXT_LENGTH}文字までにしてください。`,
      });
    }
  }
  if (node.type === 'image') {
    const url = node.url ?? '';
    if (!url.startsWith('https://')) {
      errors.push({
        code: 'image_not_https',
        messageJa: '画像のリンクが安全な形式ではありません。もう一度アップロードしてください。',
      });
    }
  }
  if (Array.isArray(node.contents)) {
    for (const child of node.contents) walkNodes(child, depth + 1, errors);
  }
}

function validateBubble(bubble: FlexBubble, cardIndex: number, errors: ValidationError[]): void {
  const bodyContents = bubble.body?.contents ?? [];
  const heroPresent = Boolean(bubble.hero);
  if (bodyContents.length === 0 && !heroPresent) {
    errors.push({
      code: 'empty_contents',
      messageJa: 'カードに中身がありません。見出しや画像を足してください。',
      cardIndex,
    });
    return;
  }
  walkNodes(bubble.hero, 0, errors);
  walkNodes(bubble.body, 0, errors);
  walkNodes(bubble.header, 0, errors);
  walkNodes(bubble.footer, 0, errors);
}

/**
 * bare contents (bubble | carousel) を検証する。
 * @returns ok:true か、ok:false + 日本語 errors。
 */
export function validateFlex(contents: FlexContents, opts: ValidateOptions = {}): ValidationResult {
  const errors: ValidationError[] = [];

  if (contents.type === 'carousel') {
    if (contents.contents.length === 0) {
      errors.push({ code: 'empty_contents', messageJa: 'カードがありません。カードを1枚以上作ってください。' });
    } else if (contents.contents.length > MAX_CAROUSEL_BUBBLES) {
      errors.push({
        code: 'carousel_too_many',
        messageJa: `カードは${MAX_CAROUSEL_BUBBLES}枚までです。多いカードを減らしてください。`,
      });
    }
  }

  const bubbles = collectBubbles(contents);
  bubbles.forEach((bubble, i) => validateBubble(bubble, i, errors));

  if (typeof opts.altText === 'string' && opts.altText.length > MAX_ALT_TEXT_LENGTH) {
    errors.push({
      code: 'alt_text_too_long',
      messageJa: `お知らせ文が長すぎます。${MAX_ALT_TEXT_LENGTH}文字までにしてください。`,
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
