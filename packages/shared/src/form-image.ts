// =============================================================================
// form-image — 差し込み画像 (in-body decoration image) の canonical <img> build/parse
// -----------------------------------------------------------------------------
// 採用経路 (spike S-1 実証 2026-07-18): section(meta) の description に canonical
//   `<img src="URL" alt="ALT" style="max-width:N%;border-radius:8px">` を入れると Formaloo hosted
//   公開ページで実画像描画され、max-width % が表示領域(幅)制御として効く。
// spike T-C3 実証: この固定形は Formaloo GET round-trip で **byte 完全一致** (data-* 無・自己終了 `/>` 無・
//   src→alt→style 順)。canonical を崩す変更は push↔GET byte 不一致 = fingerprint 6h false-drift 再導入 →
//   下記 builder/parser の固定形は番人テスト (form-image.test.ts) で封鎖する。
// 地雷継承: /v3.0/files/=401・field 直 multipart 黙殺・markdown/生 URL 非描画 = HTML `<img>` のみ描画。
//   画像 host は harness R2 (worker) 側。本 module は「URL → canonical HTML」「HTML → 値」の純変換のみ。
// R-4 XSS: description は Formaloo が生 HTML 描画する面。自由 HTML を受けず、検証済み http(s) URL からのみ
//   img を生成し alt/url を escape する (staff-trusted・既存 section 説明文と同じ描画面)。
// =============================================================================

/** 差し込み画像の表示幅プリセット (owner ②「レスポンシブで崩れない」= max-width % 制御)。 */
export type ImageWidth = 'small' | 'medium' | 'full';

/** 幅プリセット → CSS max-width (% = 親コンテナ相対でスマホでも破綻しない / spike 実測で hosted に効く)。 */
export const IMAGE_WIDTH_TO_MAXWIDTH: Record<ImageWidth, string> = {
  small: '40%',
  medium: '70%',
  full: '100%',
};

export const IMAGE_WIDTHS = ['small', 'medium', 'full'] as const;

/** max-width % 逆引き (parse で description の style から width enum を復元)。 */
const MAXWIDTH_TO_WIDTH: Record<string, ImageWidth> = { '40%': 'small', '70%': 'medium', '100%': 'full' };

export function isImageWidth(v: unknown): v is ImageWidth {
  return typeof v === 'string' && (IMAGE_WIDTHS as readonly string[]).includes(v);
}

/** HTML 属性値 escape (二重引用符コンテキスト)。& を最初に処理して二重 escape を防ぐ。 */
export function escapeHtmlAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** escapeHtmlAttr の逆変換 (parse で round-trip 復元)。&amp; は最後に戻す (二重 decode 防止)。 */
function unescapeHtmlAttr(s: string): string {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * http(s) URL のみ許可 (javascript:/data: を弾く / R-4 XSS)。引用符/山括弧/空白を含む URL も拒否
 * (属性値インジェクション防止)。shared pure-lib tsconfig に URL global が無いため正規表現で判定。
 */
export function isSafeImageUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(url.trim());
}

/**
 * canonical <img> を生成 (spike 固定形)。url は http(s) のみ (不正は空文字 = 保存 hold)・alt/url は escape。
 * 固定形を崩さない (data-* 無・自己終了無・src→alt→style 順・style は max-width→border-radius)。
 */
export function buildImageDescriptionHtml(url: string, alt: string, width: ImageWidth): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!isSafeImageUrl(trimmed)) return '';
  const maxWidth = IMAGE_WIDTH_TO_MAXWIDTH[isImageWidth(width) ? width : 'medium'];
  return `<img src="${escapeHtmlAttr(trimmed)}" alt="${escapeHtmlAttr(alt ?? '')}" style="max-width:${maxWidth};border-radius:8px">`;
}

export interface ParsedImage {
  url: string;
  alt: string;
  width: ImageWidth;
}

// canonical <img> を捕捉 (src / alt / max-width %)。自己終了 `/>` と末尾空白は許容 (万一の再正規化耐性)。
const IMG_PARSE_RE =
  /^<img\s+src="([^"]*)"\s+alt="([^"]*)"\s+style="max-width:\s*(\d{1,3}%)[^"]*"\s*\/?>\s*$/i;

/** section description が canonical <img> (差し込み画像) か判定。散文 section / markdown / 生 URL は false。 */
export function isImageDescription(desc: unknown): boolean {
  return typeof desc === 'string' && /^<img\s[^>]*\bsrc="https?:\/\//i.test(desc.trim());
}

/**
 * canonical <img> description を parse し {url,alt,width} を復元 (round-trip)。
 * 非該当 (散文 section / 不正 URL / 不正形) は null = image に誤分類しない (後方互換: section は section のまま)。
 * escape された属性値は unescape して元値へ。不明 max-width % は medium に丸める (壊さない)。
 */
export function parseImageDescription(desc: unknown): ParsedImage | null {
  if (typeof desc !== 'string') return null;
  const m = IMG_PARSE_RE.exec(desc.trim());
  if (!m) return null;
  const url = unescapeHtmlAttr(m[1]);
  if (!isSafeImageUrl(url)) return null; // javascript:/data:/相対 は image でない
  const alt = unescapeHtmlAttr(m[2]);
  const width = MAXWIDTH_TO_WIDTH[m[3]] ?? 'medium';
  return { url, alt, width };
}
