/**
 * LINE Flex Message の制約定数 (公式リファレンス基準で pin)。
 *
 * Source: LINE Messaging API reference — Flex Message
 *   https://developers.line.biz/en/reference/messaging-api/#flex-message
 *   https://developers.line.biz/en/reference/messaging-api/#f-carousel
 *   https://developers.line.biz/en/reference/messaging-api/#f-text
 *
 * 数値の根拠 (2026-07-03 generator が確認):
 *   - carousel の bubble 数上限 = 12 (旧仕様の 10 ではない。公式リファレンスの
 *     Carousel "Maximum number of bubbles: 12" を採用)
 *   - Flex text コンポーネントの text 上限 = 2000 文字 (FlexText.text "Max character limit: 2000")
 *   - Flex message の altText 上限 = 400 文字 (FlexMessage.altText "Max character limit: 400")
 *   - box ネスト深さ上限 = 10 (V1 は浅いので実質常に OK だが将来のための上限)
 *
 * 注: LINE の OpenAPI 機械スキーマ (line/line-openapi messaging-api.yml) は
 *   これらの文字数/個数上限を maxLength で encode していない (人間向けリファレンスの散文のみ)。
 *   よって上記の一次情報 (人間向けリファレンス) から pin した。誤値ハードコードを避けるため出典を明記。
 *
 * batch2 (2026-07-03): web-only だった検証を web/worker 共有化するため packages/shared に移設。
 *   web の validate/types/constants は re-export shim になる (既存 import path 不変)。
 */

/** carousel に入れられる bubble の最大数。 */
export const MAX_CAROUSEL_BUBBLES = 12;

/** Flex text コンポーネントの text 最大文字数。 */
export const MAX_TEXT_LENGTH = 2000;

/** Flex message の altText 最大文字数。 */
export const MAX_ALT_TEXT_LENGTH = 400;

/** box のネスト最大深さ。 */
export const MAX_BOX_NEST_DEPTH = 10;

// ---- batch B (装飾拡張) の許容値 (GC-1 fail-closed / LINE 公式 reference 準拠) ----

/** text/image の水平整列。 */
export const FLEX_ALIGN = ['start', 'center', 'end'] as const;
/** text の装飾。 */
export const FLEX_TEXT_DECORATION = ['none', 'underline', 'line-through'] as const;
/** サイズのキーワード (text)。 */
export const FLEX_SIZE_KEYWORDS = ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', '3xl', '4xl', '5xl'] as const;
/** margin / spacing のキーワード。 */
export const FLEX_MARGIN_KEYWORDS = ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as const;
/** image size のキーワード (text 用 + full)。px/% も別途許容。 */
export const FLEX_IMAGE_SIZE_KEYWORDS = [...FLEX_SIZE_KEYWORDS, 'full'] as const;
/** button の高さ。 */
export const FLEX_BUTTON_HEIGHT = ['sm', 'md'] as const;
/** bubble の大きさ (batch C)。 */
export const FLEX_BUBBLE_SIZE = ['nano', 'micro', 'kilo', 'mega', 'giga'] as const;

// ---- batch C-core (box レイアウト) の許容値 (GC-1 fail-closed / LINE 公式 layout doc 準拠) ----

/** box の並べ方。 */
export const FLEX_BOX_LAYOUT = ['vertical', 'horizontal', 'baseline'] as const;
/** box の主軸そろえ (justifyContent)。 */
export const FLEX_JUSTIFY_CONTENT = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
/** box の交差軸そろえ (alignItems)。 */
export const FLEX_ALIGN_ITEMS = ['flex-start', 'center', 'flex-end'] as const;
/** 横並び親の中での縦位置 (gravity)。 */
export const FLEX_GRAVITY = ['top', 'bottom', 'center'] as const;
/** cornerRadius のキーワード。px も別途許容。 */
export const FLEX_CORNER_RADIUS_KEYWORDS = ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as const;
/** borderWidth のキーワード。px も別途許容。 */
export const FLEX_BORDER_WIDTH_KEYWORDS = ['none', 'light', 'normal', 'medium', 'semi-bold', 'bold'] as const;

/** #RRGGBB または #RRGGBBAA。 */
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
/** '10px' 等の px 値。 */
export const PX_VALUE_RE = /^\d+(\.\d+)?px$/;
/** '50%' 等の % 値。 */
export const PCT_VALUE_RE = /^\d+(\.\d+)?%$/;

/** LINE 絵文字メッセージ(message action)の text 上限は通常メッセージと同じ扱いで pin。 */
export const MAX_MESSAGE_ACTION_TEXT = 300;

/** postback action の data 上限 (LINE reference: postback.data "Max character limit: 300")。 */
export const MAX_POSTBACK_DATA = 300;
