/**
 * Flex JSON 出力型 + 検証結果型 (web/worker 共有)。
 *
 * WHY: validateFlex を web/worker で単一正典化するため、検証が依存する Flex JSON の
 *   出力型 (bare contents = bubble | carousel) と検証結果型を packages/shared に置く。
 *   ビルダー内部モデル (BuilderModel / BuilderPart / LinkSpec 等) は web-UI 専用のため
 *   web 側 (apps/web/src/lib/flex-builder/types.ts) に残す (worker は import しない)。
 *
 * batch2 (2026-07-03): apps/web/src/lib/flex-builder/types.ts の flex JSON 部分を移設。
 *   web types.ts はこれらを re-export し既存 import path を不変に保つ (shim)。
 */

// ---- Flex JSON 出力型 (bare contents = bubble | carousel) ----

export interface FlexBubble {
  type: 'bubble';
  size?: string;
  hero?: FlexNode;
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
}

export interface FlexCarousel {
  type: 'carousel';
  contents: FlexBubble[];
}

/** 保存/プレビューに渡す bare contents。message object でラップしない (buildMessage 契約)。 */
export type FlexContents = FlexBubble | FlexCarousel;

export interface FlexBox {
  type: 'box';
  layout: 'vertical' | 'horizontal' | 'baseline';
  spacing?: string;
  contents: FlexNode[];
}

export interface FlexAction {
  // 'uri' (飛び先 URL) / 'message' (テキスト応答 / batch B) / 'postback' (data 送信 / batch D)。
  type: string;
  label?: string;
  uri?: string; // uri action
  text?: string; // message action
  data?: string; // postback action の data (batch D)
  displayText?: string; // postback action の表示文言 (batch D)
}

export interface FlexNode {
  type: string;
  text?: string;
  wrap?: boolean;
  weight?: string;
  size?: string;
  url?: string;
  aspectMode?: string;
  aspectRatio?: string;
  cornerRadius?: string;
  style?: string;
  action?: FlexAction;
  layout?: string;
  spacing?: string;
  contents?: FlexNode[];
  // batch B (装飾拡張) — すべて additive・任意。未指定時は出力に現れない (既存 JSON バイト等価 / M-20)。
  color?: string; // text/separator の色 (#RRGGBB[AA])
  align?: string; // text/image の水平整列 (start/center/end)
  decoration?: string; // text の装飾 (none/underline/line-through)
  lineSpacing?: string; // text の行間 (例 '10px')
  maxLines?: number; // text の最大行数
  margin?: string; // 部品の上マージン (none/xs..xxl or px)
  height?: string; // button の高さ (sm/md)
  // batch C-core (box レイアウト) — すべて additive・任意。box ノードのレイアウト/装飾。
  // (cornerRadius は上で宣言済み = image 角丸と共用。)
  backgroundColor?: string; // box の背景色 (#RRGGBB[AA])
  borderWidth?: string; // box の枠線太さ (keyword/px)
  borderColor?: string; // box の枠線色 (#RRGGBB[AA])
  paddingAll?: string; // box の内側余白 (keyword/px/%)
  paddingTop?: string;
  paddingBottom?: string;
  paddingStart?: string;
  paddingEnd?: string;
  width?: string; // box/image の幅 (px/%)
  justifyContent?: string; // box 主軸そろえ
  alignItems?: string; // box 交差軸そろえ
  gravity?: string; // 横並び親の中での縦位置 (top/bottom/center)
  flex?: number; // 伸縮比 (>=0)
  // batch D: box の絶対配置 + グラデーション背景。
  position?: string; // relative / absolute
  offsetTop?: string;
  offsetBottom?: string;
  offsetStart?: string;
  offsetEnd?: string;
  background?: FlexBackground; // 線形グラデーション背景
  // batch E: video (hero 動画)。
  previewUrl?: string; // 動画のプレビュー画像
  altContent?: FlexNode; // 再生できない環境の代替 (image/box)
}

/** box の背景 (現状は線形グラデーションのみ / batch D)。 */
export interface FlexBackground {
  type?: string; // 'linearGradient'
  angle?: string;
  startColor?: string;
  endColor?: string;
  centerColor?: string;
  centerPosition?: string;
}

/** validateFlex の返り値。ok:false のとき日本語 errors を UI が表示。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export interface ValidationError {
  code: string;
  messageJa: string;
  /** どのカード/部品でエラーが起きたか (行内エラー所在明示用)。任意。 */
  cardIndex?: number;
  partId?: string;
}
