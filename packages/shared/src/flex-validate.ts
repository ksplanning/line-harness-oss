/**
 * validateFlex — 保存前に LINE Flex 制約違反を検出する純関数ゲート (web/worker 共有)。
 *
 * WHY: 「送信時に初めて失敗する」経路を潰す (failure_observable)。制約違反は保存をブロックし、
 *   運用者に日本語の依頼形エラーを返す (おばあちゃん基準: 責めない・専門語を出さない)。
 *
 *   batch2 (2026-07-03) で apps/web から packages/shared に移設。client (web の broadcast-form /
 *   flex-builder-modal) と server (worker POST/PUT /api/broadcasts) が同一関数・同一ルールを使う。
 *   web の validate.ts は re-export shim になり既存 import は不変。worker は本ファイルを import して
 *   API 直叩きでの不正 Flex 保存を server 側でも 400 でブロックする。
 *
 * Node 依存ゼロ (正規表現 + 文字列長 + 再帰のみ) → Cloudflare Workers ランタイム互換。
 * 数値の pin は flex-constants.ts (LINE 公式リファレンス出典明記) を参照。
 */
import type { FlexContents, FlexBubble, FlexNode, ValidationError, ValidationResult } from './flex-types';
import {
  MAX_CAROUSEL_BUBBLES,
  MAX_TEXT_LENGTH,
  MAX_ALT_TEXT_LENGTH,
  MAX_BOX_NEST_DEPTH,
  MAX_MESSAGE_ACTION_TEXT,
  FLEX_ALIGN,
  FLEX_TEXT_DECORATION,
  FLEX_SIZE_KEYWORDS,
  FLEX_IMAGE_SIZE_KEYWORDS,
  FLEX_MARGIN_KEYWORDS,
  FLEX_BUTTON_HEIGHT,
  HEX_COLOR_RE,
  PX_VALUE_RE,
  PCT_VALUE_RE,
} from './flex-constants';

// ---- batch B (装飾拡張) の fail-closed 検査 (GC-1: 不正値は保存ブロック) ----

const BAD_DECO = 'flex_bad_decoration';
const decoErr = (): ValidationError => ({
  code: BAD_DECO,
  messageJa: '装飾の指定に正しくない値があります。選び直してください。',
});

const inSet = (v: unknown, set: readonly string[]): boolean => typeof v === 'string' && set.includes(v);
const isColor = (v: unknown): boolean => typeof v === 'string' && HEX_COLOR_RE.test(v);
const isSizeKeyword = (v: unknown): boolean => inSet(v, FLEX_SIZE_KEYWORDS);
const isMargin = (v: unknown): boolean =>
  inSet(v, FLEX_MARGIN_KEYWORDS) || (typeof v === 'string' && PX_VALUE_RE.test(v));
const isImageSize = (v: unknown): boolean =>
  inSet(v, FLEX_IMAGE_SIZE_KEYWORDS) || (typeof v === 'string' && (PX_VALUE_RE.test(v) || PCT_VALUE_RE.test(v)));

function validateTextDeco(node: FlexNode, errors: ValidationError[]): void {
  if (node.color !== undefined && !isColor(node.color)) errors.push(decoErr());
  if (node.align !== undefined && !inSet(node.align, FLEX_ALIGN)) errors.push(decoErr());
  if (node.decoration !== undefined && !inSet(node.decoration, FLEX_TEXT_DECORATION)) errors.push(decoErr());
  if (node.size !== undefined && !isSizeKeyword(node.size)) errors.push(decoErr());
  if (node.lineSpacing !== undefined && !(typeof node.lineSpacing === 'string' && PX_VALUE_RE.test(node.lineSpacing))) errors.push(decoErr());
  if (node.maxLines !== undefined && !(typeof node.maxLines === 'number' && Number.isInteger(node.maxLines) && node.maxLines >= 0)) errors.push(decoErr());
  if (node.margin !== undefined && !isMargin(node.margin)) errors.push(decoErr());
}

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
    validateTextDeco(node, errors); // GC-1: color/align/decoration/size/lineSpacing/maxLines/margin
  }
  if (node.type === 'image') {
    const url = node.url ?? '';
    if (!url.startsWith('https://')) {
      errors.push({
        code: 'image_not_https',
        messageJa: '画像のリンクが安全な形式ではありません。もう一度アップロードしてください。',
      });
    }
    // GC-1: image の size(keyword/px/%)/align/margin。
    if (node.size !== undefined && !isImageSize(node.size)) errors.push(decoErr());
    if (node.align !== undefined && !inSet(node.align, FLEX_ALIGN)) errors.push(decoErr());
    if (node.margin !== undefined && !isMargin(node.margin)) errors.push(decoErr());
  }
  if (node.type === 'button') {
    // GC-1: button の height/align/margin。
    if (node.height !== undefined && !inSet(node.height, FLEX_BUTTON_HEIGHT)) errors.push(decoErr());
    if (node.align !== undefined && !inSet(node.align, FLEX_ALIGN)) errors.push(decoErr());
    if (node.margin !== undefined && !isMargin(node.margin)) errors.push(decoErr());
  }
  if (node.type === 'separator') {
    // GC-1: separator の color/margin。
    if (node.color !== undefined && !isColor(node.color)) errors.push(decoErr());
    if (node.margin !== undefined && !isMargin(node.margin)) errors.push(decoErr());
  }
  // button の action、または image のタップ action の飛び先を検証。
  // uri: 送信時に初めて失敗する経路 (空/スキーム無し/javascript:/data:/http:) を保存前に潰す (H1)。
  // message (batch B): テキスト応答。空/長すぎを保存前にブロック (GC-1)。
  if (node.action) {
    if (node.action.type === 'uri') {
      validateLinkUri(node.action.uri, errors);
    } else if (node.action.type === 'message') {
      const t = node.action.text ?? '';
      if (t.trim().length === 0) {
        errors.push({ code: 'message_action_empty', messageJa: '押したときに送る文字が空です。文字を入れてください。' });
      } else if (t.length > MAX_MESSAGE_ACTION_TEXT) {
        errors.push({ code: 'message_action_too_long', messageJa: `押したときに送る文字が長すぎます。${MAX_MESSAGE_ACTION_TEXT}文字までにしてください。` });
      }
    }
  }
  if (Array.isArray(node.contents)) {
    for (const child of node.contents) walkNodes(child, depth + 1, errors);
  }
}

/** uri に空白・改行・制御文字が混入していないか (正常な uri に空白は入らない)。 */
function hasWhitespaceOrControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    // 制御文字 (0x00-0x1F, 0x7F) または空白類 (space/tab/CR/LF 等)
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * リンク先 uri を検証。https:// または tel: のみ許可 (LINE で安全に開ける飛び先)。
 * 空 / スキーム無し / javascript: / data: / http: / 制御文字・空白混入 は保存ブロック (H1)。
 */
function validateLinkUri(uri: string | undefined, errors: ValidationError[]): void {
  const raw = uri ?? '';
  if (raw.trim().length === 0) {
    errors.push({ code: 'link_empty', messageJa: 'リンク先が空です。押したときの飛び先を入れてください。' });
    return;
  }
  if (hasWhitespaceOrControl(raw)) {
    errors.push({
      code: 'link_bad_scheme',
      messageJa: 'リンク先の形が正しくありません。もう一度入れ直してください。',
    });
    return;
  }
  const isHttps = raw.startsWith('https://');
  const isTel = raw.startsWith('tel:');
  if (!isHttps && !isTel) {
    errors.push({
      code: 'link_bad_scheme',
      messageJa: 'リンク先は「https://」で始まるアドレス、または電話番号にしてください。',
    });
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
