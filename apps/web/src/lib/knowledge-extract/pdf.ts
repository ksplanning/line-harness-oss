/**
 * Phase B B-4 (T-D1) — PDF テキスト抽出の薄い adapter。
 *
 * pdf.js は **動的 import** で初期バンドルに載せない (PDF を触った瞬間だけ chunk 取得 / xlsx.ts:28 同型)。
 * pdf.js 呼出は本 adapter に隔離し、判定/正規化 (format-detect / scanned) は純関数化して単体テスト可能に
 * する (本番だけで動く untested code = hollow completion を作らない / §6・地雷 B4-8)。Worker は触らない
 * (攻撃面をブラウザに限定・D1 に波及しない / xlsx.ts の多層防御と同思想)。
 * NOTE: pdf.js の workerSrc 配線と実 upload UI コントロールは B-5 (本 batch は抽出 lib + web vitest まで)。
 */
import { isLikelyScanned } from './format-detect';
import { KnowledgeExtractError } from './types';

/** pdf.js の必要最小 API (structural・pdfjs の型品質/ESM 事情に依存しない)。 */
export interface PdfjsLike {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocumentLike> };
}
interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}
interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}

export interface PdfExtractDeps {
  /** pdf.js loader (テストで mock 差替)。default = dynamic import。 */
  loadPdfjs?: () => Promise<PdfjsLike>;
}

async function defaultLoadPdfjs(): Promise<PdfjsLike> {
  // 初期バンドル非搭載の動的 import (xlsx.ts:28 同型)。
  return (await import('pdfjs-dist')) as unknown as PdfjsLike;
}

function isPasswordException(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'PasswordException' || /password/i.test(e.message);
}

/**
 * PDF File → 全ページのテキストを連結して返す。パスワード付き / スキャン (テキスト層なし) は [制約] として
 * 日本語エラー (KnowledgeExtractError) で拒否する。
 */
export async function extractPdfText(file: File, deps: PdfExtractDeps = {}): Promise<string> {
  const loadPdfjs = deps.loadPdfjs ?? defaultLoadPdfjs;
  const bytes = new Uint8Array(await file.arrayBuffer());

  let pdfjs: PdfjsLike;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    throw new KnowledgeExtractError('extract_failed');
  }

  let doc: PdfDocumentLike;
  try {
    doc = await pdfjs.getDocument({ data: bytes }).promise;
  } catch (e) {
    if (isPasswordException(e)) throw new KnowledgeExtractError('password_protected');
    throw new KnowledgeExtractError('extract_failed');
  }

  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  const text = parts.join('\n').trim();

  if (isLikelyScanned(text)) throw new KnowledgeExtractError('scanned_no_text');
  return text;
}
