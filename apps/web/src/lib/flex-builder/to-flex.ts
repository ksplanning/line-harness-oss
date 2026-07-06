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
  BoxDeco,
  FlexBubble,
  FlexBox,
  FlexContents,
  FlexNode,
  FlexAction,
  ImageAspect,
  LinkSpec,
} from './types';

/** box の装飾/レイアウトキー (条件付き emission = 未指定は出力に現れない / M-20)。 */
const BOX_DECO_KEYS: (keyof BoxDeco)[] = [
  'spacing', 'margin', 'backgroundColor', 'cornerRadius', 'borderWidth', 'borderColor',
  'paddingAll', 'paddingTop', 'paddingBottom', 'paddingStart', 'paddingEnd',
  'width', 'height', 'justifyContent', 'alignItems', 'gravity', 'flex',
];

const ASPECT_RATIO: Record<ImageAspect, string | undefined> = {
  original: undefined,
  landscape: '20:13',
  square: '1:1',
};

/** LinkSpec → Flex action。message/postback は専用形、それ以外は {type:'uri',uri}。 */
function linkToAction(link: LinkSpec, label?: string): FlexAction {
  if (link.type === 'message') {
    return label !== undefined ? { type: 'message', label, text: link.text } : { type: 'message', text: link.text };
  }
  if (link.type === 'postback') {
    // 並び: type, label?, data, displayText? (from-flex の lossless 復元と一致させる)。
    const node: FlexAction = { type: 'postback' };
    if (label !== undefined) node.label = label;
    node.data = link.data;
    if (link.displayText !== undefined) node.displayText = link.displayText;
    return node;
  }
  return label !== undefined ? { type: 'uri', label, uri: link.uri } : { type: 'uri', uri: link.uri };
}

/** text 部品の装飾を additive に付与 (未指定は出力に現れない = 既存 draft バイト等価 / M-20)。 */
function applyTextDeco(node: FlexNode, part: Extract<BuilderPart, { kind: 'heading' | 'body' }>): void {
  if (part.color !== undefined) node.color = part.color;
  if (part.align !== undefined) node.align = part.align;
  if (part.decoration !== undefined) node.decoration = part.decoration;
  if (part.lineSpacing !== undefined) node.lineSpacing = part.lineSpacing;
  if (part.maxLines !== undefined) node.maxLines = part.maxLines;
  if (part.margin !== undefined) node.margin = part.margin;
}

function partToNode(part: BuilderPart): FlexNode {
  switch (part.kind) {
    case 'heading': {
      // heading は常に太字 lg 既定 (identity)。装飾は色/整列/装飾/行間/最大行/マージン。
      const node: FlexNode = {
        type: 'text',
        text: part.text,
        wrap: true,
        weight: 'bold',
        size: part.size ?? 'lg',
      };
      applyTextDeco(node, part);
      return node;
    }
    case 'body': {
      const node: FlexNode = { type: 'text', text: part.text, wrap: true, size: part.size };
      applyTextDeco(node, part);
      return node;
    }
    case 'image': {
      const node: FlexNode = {
        type: 'image',
        url: part.url,
        size: part.size ?? 'full',
        aspectMode: 'cover',
      };
      const ratio = part.aspect ? ASPECT_RATIO[part.aspect] : undefined;
      if (ratio) node.aspectRatio = ratio;
      if (part.rounded) node.cornerRadius = '8px';
      if (part.align !== undefined) node.align = part.align;
      if (part.margin !== undefined) node.margin = part.margin;
      if (part.tapLink) node.action = linkToAction(part.tapLink);
      return node;
    }
    case 'button': {
      const node: FlexNode = {
        type: 'button',
        style: part.style,
        action: linkToAction(part.link, part.label),
      };
      if (part.height !== undefined) node.height = part.height;
      if (part.align !== undefined) node.align = part.align;
      if (part.margin !== undefined) node.margin = part.margin;
      return node;
    }
    case 'separator': {
      const node: FlexNode = { type: 'separator' };
      if (part.color !== undefined) node.color = part.color;
      if (part.margin !== undefined) node.margin = part.margin;
      return node;
    }
    case 'spacer':
      return { type: 'spacer', size: part.size ?? 'md' };
    case 'icon': {
      // baseline box 用の小さな装飾画像。size/margin は条件付き emission。
      const node: FlexNode = { type: 'icon', url: part.url };
      if (part.size !== undefined) node.size = part.size;
      if (part.margin !== undefined) node.margin = part.margin;
      return node;
    }
    case 'box': {
      // ネスト可能な box。子部品を再帰変換し、装飾は条件付き emission (未指定は出さない = M-20)。
      const node: FlexNode = {
        type: 'box',
        layout: part.layout,
        contents: part.contents.map(partToNode),
      };
      for (const k of BOX_DECO_KEYS) {
        const v = part[k];
        if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
      }
      return node;
    }
  }
}

function cardToBubble(card: BuilderCard): FlexBubble {
  const body: FlexBox = {
    type: 'box',
    layout: 'vertical',
    spacing: 'md',
    contents: card.parts.map(partToNode),
  };
  // LINE 慣習の並び: type, size, header, hero, body, footer。未指定は出力しない (M-20 バイト等価)。
  const bubble: FlexBubble = { type: 'bubble' };
  if (card.size !== undefined) bubble.size = card.size;
  if (card.header !== undefined) {
    bubble.header = { type: 'box', layout: 'vertical', contents: card.header.map(partToNode) };
  }
  if (card.hero !== undefined) bubble.hero = partToNode(card.hero);
  bubble.body = body;
  if (card.footer !== undefined) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: card.footer.map(partToNode) };
  }
  return bubble;
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
