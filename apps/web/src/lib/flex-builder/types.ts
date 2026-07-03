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

// ---- Flex JSON 出力型 + 検証結果型 ----
//
// batch2 で packages/shared (flex-types.ts) に移設し単一正典化。web/worker が同一型を共有し
// drift しない。既存 import (`@/lib/flex-builder/types` から FlexContents 等) は本 re-export で
// 不変に解決される。ビルダー内部モデル (上記 BuilderModel / BuilderPart / LinkSpec 等) は
// web-UI 専用のためこのファイルに残す (worker は import しない)。
export type {
  FlexBubble,
  FlexCarousel,
  FlexContents,
  FlexBox,
  FlexAction,
  FlexNode,
  ValidationResult,
  ValidationError,
} from '@line-crm/shared';
