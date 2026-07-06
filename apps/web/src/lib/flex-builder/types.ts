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
  | { type: 'booking'; uri: string } // 予約ページ URL
  | { type: 'message'; text: string }; // 押すとこのテキストをユーザーが送信 (batch B)

/** 画像のアスペクト比 (UI は最大 3 択: そのまま/横長/正方形)。 */
export type ImageAspect = 'original' | 'landscape' | 'square';

/** ボタンの見た目 (新色禁止。primary=#06C755 固定)。 */
export type ButtonStyle = 'primary' | 'secondary' | 'link';

/**
 * テキスト装飾 (batch B)。すべて任意・未指定時は既定 (既存 draft の見た目を変えない / M-20)。
 * 型は string: from-flex が保存済み Flex の値をそのまま lossless に保持でき、round-trip が安定する
 * (許容値の enforce は validateFlex = GC-1 が保存時に行う)。UI トグルは有効値のみを設定する。
 * weight(太さ) は含めない: 太字=見出し / 普通=本文 の既存 identity を保ち heading↔body ゆらぎを避ける。
 */
export interface TextDeco {
  color?: string; // プリセット or 任意 hex (#RRGGBB[AA])
  align?: string; // start / center / end
  decoration?: string; // none / underline / line-through
  lineSpacing?: string; // 例 '10px'
  maxLines?: number;
}

/** 1 部品 (ブロック)。kind で判別する discriminated union。margin は上マージン (batch B)。 */
export type BuilderPart =
  | ({ kind: 'heading'; id: string; text: string; size?: string; margin?: string } & TextDeco)
  | ({ kind: 'body'; id: string; text: string; size?: string; margin?: string } & TextDeco)
  | {
      kind: 'image';
      id: string;
      url: string;
      aspect?: ImageAspect;
      rounded?: boolean;
      tapLink?: LinkSpec;
      size?: string; // batch B: sm..full (未指定=full)
      align?: string; // batch B: start / center / end
      margin?: string;
    }
  | {
      kind: 'button';
      id: string;
      label: string;
      style: ButtonStyle;
      link: LinkSpec;
      height?: string; // batch B: sm / md
      align?: string; // batch B: start / center / end
      margin?: string;
    }
  | { kind: 'separator'; id: string; color?: string; margin?: string } // batch B: 色/上マージン
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
