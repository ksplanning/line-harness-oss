/**
 * Flex JSON (bare contents) → BuilderModel 逆変換 (ui-design §11)。
 *
 * WHY: 保存済み Flex (bubble/carousel) を「編集」で開いたとき BuilderModel に戻す。
 *   画像リンク化で作られた hero-only bubble (plan 判断A) も image 部品 1 個 + tapLink に復元する。
 *
 * 逆変換不能なケース (ビルダー範囲外: 横並び box / header・footer 使用 / 未知 node 等) は
 *   **null を返す**。呼び元は「この Flex は高度な形式のためビジュアル編集できません」と案内し、
 *   上級者 JSON 折りたたみにフォールバックする (ビルダーで壊す事故を防ぐ V1 安全策)。
 */
import type { BuilderModel, BuilderCard, BuilderPart, LinkSpec, ImageAspect } from './types';
import { nextId } from './templates';
import { MAX_CAROUSEL_BUBBLES } from './constants';

interface RawNode {
  type?: string;
  text?: string;
  weight?: string;
  url?: string;
  size?: string;
  aspectRatio?: string;
  aspectMode?: string;
  cornerRadius?: string;
  style?: string;
  action?: { type?: string; label?: string; uri?: string; text?: string; data?: string; displayText?: string; [k: string]: unknown };
  layout?: string;
  color?: string;
  align?: string;
  decoration?: string;
  lineSpacing?: string;
  maxLines?: number;
  margin?: string;
  height?: string;
  contents?: RawNode[];
  // batch C-core: box レイアウト/装飾 (lossless 読取用 / cornerRadius は上で宣言済み)。
  spacing?: string;
  backgroundColor?: string;
  borderWidth?: string;
  borderColor?: string;
  paddingAll?: string;
  paddingTop?: string;
  paddingBottom?: string;
  paddingStart?: string;
  paddingEnd?: string;
  width?: string;
  justifyContent?: string;
  alignItems?: string;
  gravity?: string;
  flex?: number;
  position?: string;
  offsetTop?: string;
  offsetBottom?: string;
  offsetStart?: string;
  offsetEnd?: string;
  background?: unknown;
  [key: string]: unknown;
}

/** box が lossless に保持できる装飾/レイアウトキー (string 値)。flex(number)/background(object) は別扱い。 */
const BOX_DECO_STRING_KEYS = [
  'spacing', 'margin', 'backgroundColor', 'cornerRadius', 'borderWidth', 'borderColor',
  'paddingAll', 'paddingTop', 'paddingBottom', 'paddingStart', 'paddingEnd',
  'width', 'height', 'justifyContent', 'alignItems', 'gravity',
  'position', 'offsetTop', 'offsetBottom', 'offsetStart', 'offsetEnd',
] as const;

/** gradient (background) が lossless に保持できるキー。ここに無いキーがあれば box 全体を null。 */
const ALLOWED_GRADIENT_KEYS = new Set(['type', 'angle', 'startColor', 'endColor', 'centerColor', 'centerPosition']);

// GC-2 lossless-only: ビルダーが表現できる node の許容キー集合。ここに無いキーが 1 つでもあれば
// 逆変換不能 (null → 上級者 JSON へフォールバック) = 未知プロパティを黙って落として再保存する事故を禁止。
const ALLOWED_KEYS: Record<string, Set<string>> = {
  text: new Set(['type', 'text', 'wrap', 'weight', 'size', 'color', 'align', 'decoration', 'lineSpacing', 'maxLines', 'margin']),
  image: new Set(['type', 'url', 'size', 'aspectMode', 'aspectRatio', 'cornerRadius', 'align', 'margin', 'action']),
  button: new Set(['type', 'style', 'action', 'height', 'align', 'margin']),
  separator: new Set(['type', 'color', 'margin']),
  spacer: new Set(['type', 'size']),
  icon: new Set(['type', 'url', 'size', 'margin']), // batch D: baseline 装飾

  // batch C-core: box (ネスト/横並び/装飾)。ここに無いキー(action/background gradient/position/offset 等)を
  // 持つ box は lossless に保持できない → null (上級者 JSON へ)。background/position/offset は batch D で追加。
  box: new Set([
    'type', 'layout', 'contents', 'spacing', 'margin', 'backgroundColor', 'cornerRadius',
    'borderWidth', 'borderColor', 'paddingAll', 'paddingTop', 'paddingBottom', 'paddingStart',
    'paddingEnd', 'width', 'height', 'justifyContent', 'alignItems', 'gravity', 'flex',
    // batch D: 絶対配置 + グラデーション背景。
    'position', 'offsetTop', 'offsetBottom', 'offsetStart', 'offsetEnd', 'background',
  ]),
};

const ALLOWED_ACTION_KEYS = new Set(['type', 'label', 'uri', 'text', 'data', 'displayText']);

/** node の全キーが許容集合内か (GC-2)。1 つでも外れたら false = 逆変換不能。 */
function hasOnlyAllowedKeys(node: RawNode, type: string): boolean {
  const allowed = ALLOWED_KEYS[type];
  if (!allowed) return false;
  for (const k of Object.keys(node)) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

function actionToLink(action: RawNode['action']): LinkSpec | null {
  if (!action || typeof action !== 'object') return null;
  // action 側も未知キーがあれば lossless に保持できない → null。
  for (const k of Object.keys(action)) {
    if (!ALLOWED_ACTION_KEYS.has(k)) return null;
  }
  if (action.type === 'message') {
    if (typeof action.text !== 'string') return null;
    return { type: 'message', text: action.text };
  }
  if (action.type === 'postback') {
    if (typeof action.data !== 'string') return null;
    return typeof action.displayText === 'string'
      ? { type: 'postback', data: action.data, displayText: action.displayText }
      : { type: 'postback', data: action.data };
  }
  if (action.type !== 'uri' || typeof action.uri !== 'string') return null;
  const uri = action.uri;
  if (uri.startsWith('tel:')) {
    return { type: 'tel', phone: uri.slice(4), uri };
  }
  // tracked link かどうかは復元時に判別できない (URL としてしか残らない) ので url 扱いに丸める。
  // これは意図的: 逆変換後の再保存でも uri は保持され計測 URL は壊れない。
  return { type: 'url', uri };
}

function aspectFromRatio(ratio?: string): ImageAspect {
  // 明示 aspectRatio が無ければ original 扱い。
  if (ratio === '1:1') return 'square';
  if (ratio === '20:13') return 'landscape';
  return 'original';
}

/** text 装飾 (batch B) を node から part に lossless に写す。 */
function readTextDeco(node: RawNode): Partial<BuilderPart> {
  const deco: Record<string, unknown> = {};
  if (typeof node.color === 'string') deco.color = node.color;
  if (typeof node.align === 'string') deco.align = node.align;
  if (typeof node.decoration === 'string') deco.decoration = node.decoration;
  if (typeof node.lineSpacing === 'string') deco.lineSpacing = node.lineSpacing;
  if (typeof node.maxLines === 'number') deco.maxLines = node.maxLines;
  if (typeof node.margin === 'string') deco.margin = node.margin;
  return deco as Partial<BuilderPart>;
}

/** 1 つの Flex node → BuilderPart。対応外なら null (= bubble 全体を逆変換不能扱いにする)。 */
function nodeToPart(node: RawNode): BuilderPart | null {
  const id = nextId('part');
  if (typeof node.type !== 'string' || !hasOnlyAllowedKeys(node, node.type)) return null; // GC-2
  switch (node.type) {
    case 'text': {
      if (typeof node.text !== 'string') return null;
      const base = node.weight === 'bold'
        ? { kind: 'heading' as const, id, text: node.text, size: node.size }
        : { kind: 'body' as const, id, text: node.text, size: node.size };
      return { ...base, ...readTextDeco(node) } as BuilderPart;
    }
    case 'image': {
      if (typeof node.url !== 'string') return null;
      // 画像は aspectMode='cover' 前提 (model は cover 固定出力)。異なる mode は表現不能 → null。
      if (node.aspectMode !== undefined && node.aspectMode !== 'cover') return null;
      const part: Record<string, unknown> = {
        kind: 'image',
        id,
        url: node.url,
        aspect: aspectFromRatio(node.aspectRatio),
        rounded: Boolean(node.cornerRadius),
      };
      if (typeof node.size === 'string') part.size = node.size;
      if (typeof node.align === 'string') part.align = node.align;
      if (typeof node.margin === 'string') part.margin = node.margin;
      const tap = actionToLink(node.action);
      if (node.action && !tap) return null; // action があるのに解釈不能 → lossless 不可
      if (tap) part.tapLink = tap;
      return part as BuilderPart;
    }
    case 'button': {
      const link = actionToLink(node.action);
      if (!link) return null;
      const style = node.style === 'secondary' || node.style === 'link' ? node.style : 'primary';
      const part: Record<string, unknown> = { kind: 'button', id, label: node.action?.label ?? 'ボタン', style, link };
      if (typeof node.height === 'string') part.height = node.height;
      if (typeof node.align === 'string') part.align = node.align;
      if (typeof node.margin === 'string') part.margin = node.margin;
      return part as BuilderPart;
    }
    case 'separator': {
      const part: Record<string, unknown> = { kind: 'separator', id };
      if (typeof node.color === 'string') part.color = node.color;
      if (typeof node.margin === 'string') part.margin = node.margin;
      return part as BuilderPart;
    }
    case 'spacer':
      return { kind: 'spacer', id, size: node.size };
    case 'icon': {
      if (typeof node.url !== 'string') return null;
      const part: Record<string, unknown> = { kind: 'icon', id, url: node.url };
      if (typeof node.size === 'string') part.size = node.size;
      if (typeof node.margin === 'string') part.margin = node.margin;
      return part as BuilderPart;
    }
    case 'box': {
      // ネスト可能な box。layout は3値のみ。子部品を再帰変換 (1つでも不能なら box 全体が null = lossless)。
      if (node.layout !== 'vertical' && node.layout !== 'horizontal' && node.layout !== 'baseline') return null;
      if (node.contents !== undefined && !Array.isArray(node.contents)) return null;
      const children: BuilderPart[] = [];
      for (const child of node.contents ?? []) {
        if (!child || typeof child !== 'object') return null;
        const cp = nodeToPart(child as RawNode);
        if (!cp) return null;
        children.push(cp);
      }
      const part: Record<string, unknown> = { kind: 'box', id, layout: node.layout, contents: children };
      for (const k of BOX_DECO_STRING_KEYS) {
        const v = node[k];
        if (typeof v === 'string') part[k] = v;
      }
      if (typeof node.flex === 'number') part.flex = node.flex;
      // background (gradient) は object を lossless に保持。未知キーがあれば box 全体を null (GC-2)。
      if (node.background !== undefined) {
        const bg = node.background;
        if (!bg || typeof bg !== 'object') return null;
        for (const k of Object.keys(bg as Record<string, unknown>)) {
          if (!ALLOWED_GRADIENT_KEYS.has(k)) return null;
        }
        part.background = bg;
      }
      return part as BuilderPart;
    }
    default:
      return null; // 未知 node → 逆変換不能
  }
}

// bubble 直下の許容キー (GC-2)。ここに無いキー (styles/direction/action 等) を持つ bubble は
// ビルダー範囲外 → null (上級者 JSON へ)。size/header/footer は batch C-core で追加。
const ALLOWED_BUBBLE_KEYS = new Set(['type', 'size', 'header', 'hero', 'body', 'footer']);

// header/footer は「縦の box」= { type:'box', layout:'vertical', contents:[...] } のみ許容 (簡易ブロック)。
// 背景色/spacing 等を持つ header は表現不能 → null (上級者 JSON へ / GC-2 lossless)。
const ALLOWED_BLOCK_KEYS = new Set(['type', 'layout', 'contents']);

/** header/footer の box を部品列に復元。縦 box 以外・余分なキー・不能な子があれば null。 */
function boxToParts(box: RawNode): BuilderPart[] | null {
  if (box.type !== 'box') return null;
  for (const k of Object.keys(box)) {
    if (!ALLOWED_BLOCK_KEYS.has(k)) return null;
  }
  if (box.layout !== undefined && box.layout !== 'vertical') return null;
  if (box.contents !== undefined && !Array.isArray(box.contents)) return null;
  const parts: BuilderPart[] = [];
  for (const child of box.contents ?? []) {
    if (!child || typeof child !== 'object') return null;
    const p = nodeToPart(child as RawNode);
    if (!p) return null;
    parts.push(p);
  }
  return parts;
}

/** 1 bubble → BuilderCard。逆変換不能なら null。 */
function bubbleToCard(bubble: RawNode): BuilderCard | null {
  // styles 等ビルダー範囲外のキーを 1 つでも持てば逆変換不能 (GC-2 lossless)。
  for (const k of Object.keys(bubble)) {
    if (!ALLOWED_BUBBLE_KEYS.has(k)) return null;
  }
  // size は文字列のみ許容 (nano..giga)。数値等の異常値は範囲外。
  if (bubble.size !== undefined && typeof bubble.size !== 'string') return null;

  const card: BuilderCard = { id: nextId('card'), parts: [] };

  // hero (一番上の大きな画像/box)。表現不能なら bubble 全体を null。
  if (bubble.hero !== undefined) {
    const heroPart = nodeToPart(bubble.hero as RawNode);
    if (!heroPart) return null;
    card.hero = heroPart;
  }

  // header (上の帯) / footer (下のボタン帯) = 縦 box → 部品列。
  if (bubble.header !== undefined) {
    const hp = boxToParts(bubble.header as RawNode);
    if (!hp) return null;
    card.header = hp;
  }
  if (bubble.footer !== undefined) {
    const fp = boxToParts(bubble.footer as RawNode);
    if (!fp) return null;
    card.footer = fp;
  }

  // body (本体) = 縦 box → parts。
  const parts: BuilderPart[] = [];
  const body = bubble.body as RawNode | undefined;
  if (body) {
    // body は vertical box のみ対応 (横並び body 自体はビルダー範囲外 = 横並びは box 部品で作る)。
    if (body.layout && body.layout !== 'vertical') return null;
    // body.contents が配列でない (壊れた/手貼り JSON) 場合は逆変換不能扱い (H2)。
    if (body.contents !== undefined) {
      if (!Array.isArray(body.contents)) return null;
      for (const child of body.contents) {
        // batch C-core: ネストした box は nodeToPart('box') が再帰対応するため弾かない。
        if (!child || typeof child !== 'object') return null;
        const part = nodeToPart(child);
        if (!part) return null;
        parts.push(part);
      }
    }
  }
  card.parts = parts;

  // 何も無い bubble (body 空 かつ hero/header/footer も無い) はビルダー範囲外 = 空カードを作らない。
  if (parts.length === 0 && card.hero === undefined && card.header === undefined && card.footer === undefined) {
    return null;
  }
  if (typeof bubble.size === 'string') card.size = bubble.size;
  return card;
}

/**
 * bare contents (bubble | carousel) の JSON 文字列 → BuilderModel。
 * @returns 逆変換できたら BuilderModel、範囲外なら null。
 */
export function flexToModel(jsonString: string): BuilderModel | null {
  let parsed: RawNode;
  try {
    parsed = JSON.parse(jsonString) as RawNode;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // message object を貼られた場合は contents を見る (防御)。
  if (parsed.type === 'flex' && parsed.contents && !Array.isArray(parsed.contents)) {
    parsed = parsed.contents as unknown as RawNode;
  }

  if (parsed.type === 'bubble') {
    const card = bubbleToCard(parsed);
    return card ? { cards: [card] } : null;
  }

  if (parsed.type === 'carousel' && Array.isArray(parsed.contents)) {
    // bubble 数が LINE 上限を超える carousel はビルダー範囲外 (上級者 JSON 誘導)。
    if (parsed.contents.length > MAX_CAROUSEL_BUBBLES) return null;
    const cards: BuilderCard[] = [];
    for (const b of parsed.contents) {
      if (!b || typeof b !== 'object' || (b as RawNode).type !== 'bubble') return null;
      const card = bubbleToCard(b as RawNode);
      if (!card) return null;
      cards.push(card);
    }
    return cards.length > 0 ? { cards } : null;
  }

  return null;
}
