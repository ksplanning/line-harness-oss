/**
 * 見本テンプレ用の画像プレースホルダ (Bug1 対応 / batch A)。
 *
 * 従来 templates.ts は placehold.co?text=<日本語> を使っていたが、同サービスのフォントが CJK 非対応で
 * 画像 PNG の中に豆腐(□)が焼き込まれていた (owner の「豆腐」訴えの第2根因)。外部画像サービス依存を
 * やめ、**プレビューはローカルの inline SVG で描く** (日本語は SVG/ブラウザのローカル CJK フォントで
 * 描画 = 豆腐が構造的に発生しない・オフライン安全・外部依存ゼロ)。
 *
 * ただし Flex の image url は validateFlex が `https://` を要求し (H1)、LINE 実送信も https URL を要求
 * するため、data: URI は model に入れられない。そこで **sentinel https URL** (実在しないが https で
 * validateFlex を通る) を model の url に入れ、FlexPreview 側でこの host を検出して inline SVG に
 * 差し替える (サムネ表示用と実配信 URL の扱いを分離)。sentinel は LINE では読み込めないので、テンプレの
 * 画像は「配信前にユーザーが差し替える見本」= プレビューに「（見本）」表示 + 注記で明示する。
 */

/** sentinel host。この host の image url はプレビューで inline SVG プレースホルダに置換される。 */
export const PLACEHOLDER_IMAGE_HOST = 'placeholder.line-harness.local';

export interface PlaceholderSpec {
  label: string;
  /** 背景色 (hex, # 無し)。既定は薄いグレー。 */
  bg?: string;
  /** 文字色 (hex, # 無し)。既定はグレー。 */
  fg?: string;
}

/** 見本画像の sentinel https URL を作る (validateFlex の https チェックを通る)。 */
export function placeholderImageUrl(spec: PlaceholderSpec): string {
  const p = new URLSearchParams({
    label: spec.label,
    bg: spec.bg ?? 'E5E7EB',
    fg: spec.fg ?? '6B7280',
  });
  return `https://${PLACEHOLDER_IMAGE_HOST}/img?${p.toString()}`;
}

export interface ParsedPlaceholder {
  label: string;
  bg: string; // #rrggbb
  fg: string; // #rrggbb
}

/** sentinel URL を解析。host が一致しなければ null (= 通常の外部画像)。 */
export function parsePlaceholderImageUrl(url: string | undefined): ParsedPlaceholder | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== PLACEHOLDER_IMAGE_HOST) return null;
  const hex = (v: string | null, d: string) => `#${(v ?? d).replace(/[^0-9a-fA-F]/g, '') || d}`;
  return {
    label: u.searchParams.get('label') || '見本画像',
    bg: hex(u.searchParams.get('bg'), 'E5E7EB'),
    fg: hex(u.searchParams.get('fg'), '6B7280'),
  };
}

export function isPlaceholderImageUrl(url: string | undefined): boolean {
  return parsePlaceholderImageUrl(url) !== null;
}
