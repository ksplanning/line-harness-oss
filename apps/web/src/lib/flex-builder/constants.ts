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
 */

/** carousel に入れられる bubble の最大数。 */
export const MAX_CAROUSEL_BUBBLES = 12;

/** Flex text コンポーネントの text 最大文字数。 */
export const MAX_TEXT_LENGTH = 2000;

/** Flex message の altText 最大文字数。 */
export const MAX_ALT_TEXT_LENGTH = 400;

/** box のネスト最大深さ。 */
export const MAX_BOX_NEST_DEPTH = 10;
