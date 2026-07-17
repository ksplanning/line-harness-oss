import { describe, it, expect } from 'vitest';
import {
  buildImageDescriptionHtml,
  parseImageDescription,
  isImageDescription,
  isSafeImageUrl,
  escapeHtmlAttr,
  IMAGE_WIDTH_TO_MAXWIDTH,
  type ImageWidth,
} from './form-image';

// spike S-1 / T-C3 実測: この固定形が Formaloo GET round-trip で byte 完全一致
//   (data-* 無・自己終了 `/>` 無・src→alt→style 順・style は max-width→border-radius)。
// 本 fixture を崩す変更は push↔GET byte 不一致 = fingerprint 6h false-drift 再導入 → 番人テスト。
const CANONICAL = '<img src="https://cdn.test/a.png" alt="お客様の写真" style="max-width:70%;border-radius:8px">';

describe('form-image canonical <img> (spike 固定形)', () => {
  it('build は spike 固定形の byte 完全一致を返す (canonical 番人)', () => {
    expect(buildImageDescriptionHtml('https://cdn.test/a.png', 'お客様の写真', 'medium')).toBe(CANONICAL);
  });

  it('IMAGE_WIDTH_TO_MAXWIDTH は small=40%/medium=70%/full=100%', () => {
    expect(IMAGE_WIDTH_TO_MAXWIDTH).toEqual({ small: '40%', medium: '70%', full: '100%' });
  });

  it('幅 3 値が style max-width に射影される', () => {
    expect(buildImageDescriptionHtml('https://x.test/i.png', 'a', 'small')).toContain('max-width:40%');
    expect(buildImageDescriptionHtml('https://x.test/i.png', 'a', 'medium')).toContain('max-width:70%');
    expect(buildImageDescriptionHtml('https://x.test/i.png', 'a', 'full')).toContain('max-width:100%');
  });

  it('build→parse round-trip で {url,alt,width} を復元', () => {
    for (const width of ['small', 'medium', 'full'] as ImageWidth[]) {
      const html = buildImageDescriptionHtml('https://cdn.test/img.jpg', 'キャンペーン画像', width);
      expect(parseImageDescription(html)).toEqual({ url: 'https://cdn.test/img.jpg', alt: 'キャンペーン画像', width });
    }
  });
});

describe('form-image XSS 防御 (R-4)', () => {
  it('javascript:/data: URL は build で空文字 (非描画・保存 hold)', () => {
    expect(buildImageDescriptionHtml('javascript:alert(1)', 'x', 'medium')).toBe('');
    expect(buildImageDescriptionHtml('data:text/html,<script>', 'x', 'medium')).toBe('');
    expect(buildImageDescriptionHtml('  http://x.test/ok.png', 'x', 'medium')).not.toBe('');
  });

  it('isSafeImageUrl は http(s) のみ受理', () => {
    expect(isSafeImageUrl('https://x.test/i.png')).toBe(true);
    expect(isSafeImageUrl('http://x.test/i.png')).toBe(true);
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeImageUrl('//x.test/i.png')).toBe(false);
    expect(isSafeImageUrl('https://x.test/i.png" onerror="alert(1)')).toBe(false); // 引用符混入 URL 拒否
  });

  it('alt の <script>/引用符/& は escape され描画面に生タグを出さない', () => {
    const html = buildImageDescriptionHtml('https://x.test/i.png', '<script>alert("x")&y</script>', 'medium');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    // escape された alt も round-trip で元値に復元される
    expect(parseImageDescription(html)?.alt).toBe('<script>alert("x")&y</script>');
  });

  it('escapeHtmlAttr は & を最初に処理し二重 escape しない', () => {
    expect(escapeHtmlAttr('a&b"c<d>e')).toBe('a&amp;b&quot;c&lt;d&gt;e');
  });
});

describe('form-image 分類 / 後方互換', () => {
  it('isImageDescription は canonical <img> を true・散文 section を false', () => {
    expect(isImageDescription(CANONICAL)).toBe(true);
    expect(isImageDescription('ここは案内文です。ご記入ください。')).toBe(false);
    expect(isImageDescription('')).toBe(false);
    expect(isImageDescription(undefined)).toBe(false);
    // markdown / 生 URL (spike 非描画) は image 扱いしない
    expect(isImageDescription('![alt](https://x.test/i.png)')).toBe(false);
    expect(isImageDescription('https://x.test/i.png')).toBe(false);
  });

  it('parseImageDescription は散文 section / 不正形で null (section を image に誤分類しない)', () => {
    expect(parseImageDescription('ここは案内文です')).toBeNull();
    expect(parseImageDescription('<img src="ftp://x/i.png" alt="a" style="max-width:70%;border-radius:8px">')).toBeNull();
    expect(parseImageDescription('<div>not an img</div>')).toBeNull();
    expect(parseImageDescription(undefined)).toBeNull();
  });

  it('不明 max-width % は medium に丸める (壊さない)', () => {
    const parsed = parseImageDescription('<img src="https://x.test/i.png" alt="a" style="max-width:55%;border-radius:8px">');
    expect(parsed?.width).toBe('medium');
  });
});
