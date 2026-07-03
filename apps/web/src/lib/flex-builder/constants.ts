/**
 * LINE Flex Message の制約定数 — re-export shim (batch2 で packages/shared に移設)。
 *
 * 実体は `@line-crm/shared` (flex-constants.ts / LINE 公式リファレンス出典明記)。
 * 既存 import (`./constants` from validate/from-flex 等) は本 shim 経由で不変に解決される。
 */
export {
  MAX_CAROUSEL_BUBBLES,
  MAX_TEXT_LENGTH,
  MAX_ALT_TEXT_LENGTH,
  MAX_BOX_NEST_DEPTH,
} from '@line-crm/shared';
