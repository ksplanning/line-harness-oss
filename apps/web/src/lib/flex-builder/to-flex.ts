/**
 * buildModelToFlex — BuilderModel を Flex JSON (bare contents) に変換する純関数。
 *
 * 絶対原則:
 *   - プレビューと保存はこの唯一の出力を使う (乖離ゼロ)。分岐して別 JSON を作らない。
 *   - 絶対に message object ({type:'flex',altText,contents}) でラップしない。
 *     buildMessage が期待するのは bare contents (bubble | carousel) だから。
 *   - 出力ノードの形は FlexPreview (flex-preview.tsx) と buildMessage 両方が読める形に合わせる。
 *     特に button のラベルは action.label に入れる (FlexPreview が action.label を読むため)。
 */
import type {
  BuilderModel,
  BuilderCard,
  BuilderPart,
  FlexBubble,
  FlexContents,
  FlexNode,
  ImageAspect,
} from './types';

const ASPECT_RATIO: Record<ImageAspect, string | undefined> = {
  original: undefined,
  landscape: '20:13',
  square: '1:1',
};

function partToNode(part: BuilderPart): FlexNode {
  switch (part.kind) {
    case 'heading':
      return { type: 'text', text: part.text, wrap: true, weight: 'bold', size: part.size ?? 'lg' };
    case 'body':
      return { type: 'text', text: part.text, wrap: true, size: part.size };
    case 'image': {
      const node: FlexNode = {
        type: 'image',
        url: part.url,
        size: 'full',
        aspectMode: 'cover',
      };
      const ratio = part.aspect ? ASPECT_RATIO[part.aspect] : undefined;
      if (ratio) node.aspectRatio = ratio;
      if (part.rounded) node.cornerRadius = '8px';
      if (part.tapLink) node.action = { type: 'uri', uri: part.tapLink.uri };
      return node;
    }
    case 'button':
      return {
        type: 'button',
        style: part.style,
        action: { type: 'uri', label: part.label, uri: part.link.uri },
      };
    case 'separator':
      return { type: 'separator' };
    case 'spacer':
      return { type: 'spacer', size: part.size ?? 'md' };
  }
}

function cardToBubble(card: BuilderCard): FlexBubble {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: card.parts.map(partToNode),
    },
  };
}

/**
 * BuilderModel → bare Flex contents。
 * cards.length===1 → bubble / >=2 → carousel。
 */
export function buildModelToFlex(model: BuilderModel): FlexContents {
  const cards = model.cards ?? [];
  if (cards.length >= 2) {
    return { type: 'carousel', contents: cards.map(cardToBubble) };
  }
  // 0 枚のときも空 bubble を返す (validateFlex が「中身がありません」で捕捉する)。
  const only = cards[0] ?? { id: 'empty', parts: [] };
  return cardToBubble(only);
}
