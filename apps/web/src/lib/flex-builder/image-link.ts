/**
 * 画像メッセージのリッチ化 (F12 / plan 判断A)。
 *
 * タップリンク付き画像 = hero 画像 1 枚だけの単一 bubble Flex に内部変換する。
 * 純 image 送信 (originalContentUrl/previewImageUrl) はそのまま残し、「画像にリンクを付ける」
 * を ON にしたときだけ messageType を flex に切替えてこの変換を使う。
 */
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import type { LinkSpec } from './types';

/**
 * 画像 URL + タップリンクを、hero 画像 1 枚だけの bubble Flex (bare contents) の JSON 文字列に変換。
 * link.uri が空でも変換できる (リンクなし画像 Flex)。保存前に validateFlex で https を検証する想定。
 */
export function imageLinkToFlexJson(url: string, link: LinkSpec): string {
  const contents = buildModelToFlex({
    cards: [
      {
        id: 'img-card',
        parts: [
          {
            kind: 'image',
            id: 'img-part',
            url,
            aspect: 'original',
            rounded: false,
            ...(link.uri ? { tapLink: link } : {}),
          },
        ],
      },
    ],
  });
  return JSON.stringify(contents);
}

/**
 * 保存済み flex が「画像リンク付き (hero-only image 1 枚)」かを判定し、そうなら url/link を返す。
 * broadcast-form が再編集で開いたとき「画像にリンクを付ける」状態を復元するために使う (plan 判断A ②)。
 * @returns { url, link } か、hero-only image でなければ null。
 */
export function detectImageLinkFlex(jsonString: string): { url: string; link: LinkSpec | null } | null {
  // 画像リンク Flex は必ず単一 bubble。carousel は対象外 (先に弾く)。
  let topType: unknown;
  try {
    topType = (JSON.parse(jsonString) as { type?: unknown }).type;
  } catch {
    return null;
  }
  if (topType !== 'bubble') return null;

  const model = flexToModel(jsonString);
  if (!model) return null;
  if (model.cards.length !== 1) return null;
  const parts = model.cards[0].parts;
  if (parts.length !== 1) return null;
  const only = parts[0];
  if (only.kind !== 'image') return null;
  return { url: only.url, link: only.tapLink ?? null };
}
