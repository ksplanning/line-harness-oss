/**
 * Flex ビジュアルビルダーの内部モデル (BuilderModel) と Flex JSON 出力の型。
 *
 * WHY: ビルダーは Flex JSON を直接編集しない。編集しやすい中間モデル (BuilderModel) を持ち、
 *   純関数 buildModelToFlex(model) で Flex JSON に変換する。プレビューと保存は同一の変換出力を使う
 *   (乖離ゼロ = spec 最重要保証)。UI はこの型だけに依存し、Flex JSON の詳細を知らない。
 */

/** ボタン/画像タップのリンク先。運用者は「押すとどこに行くか」を選ぶ (JSON を見ない)。 */
export type LinkSpec =
  | { type: 'url'; uri: string }
  | { type: 'tracked'; trackedLinkId: string; uri: string } // uri = 選択時に trackingUrl を解決して保持
  | { type: 'tel'; phone: string; uri: string } // uri = 'tel:' + 数字
  | { type: 'booking'; uri: string }; // 予約ページ URL

/** 画像のアスペクト比 (UI は最大 3 択: そのまま/横長/正方形)。 */
export type ImageAspect = 'original' | 'landscape' | 'square';

/** ボタンの見た目 (新色禁止。primary=#06C755 固定)。 */
export type ButtonStyle = 'primary' | 'secondary' | 'link';

/** 1 部品 (ブロック)。kind で判別する discriminated union。 */
export type BuilderPart =
  | { kind: 'heading'; id: string; text: string; size?: string }
  | { kind: 'body'; id: string; text: string; size?: string }
  | {
      kind: 'image';
      id: string;
      url: string;
      aspect?: ImageAspect;
      rounded?: boolean;
      tapLink?: LinkSpec;
    }
  | { kind: 'button'; id: string; label: string; style: ButtonStyle; link: LinkSpec }
  | { kind: 'separator'; id: string }
  | { kind: 'spacer'; id: string; size?: string };

export type PartKind = BuilderPart['kind'];

/** 1 カード = 1 bubble の body。parts を縦に並べる。 */
export interface BuilderCard {
  id: string;
  parts: BuilderPart[];
}

/** ビルダー全体の状態。cards.length===1 → bubble / >=2 → carousel。 */
export interface BuilderModel {
  cards: BuilderCard[];
}

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
  type: 'uri';
  label?: string;
  uri: string;
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
