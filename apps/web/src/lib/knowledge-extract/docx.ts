/**
 * Phase B B-4 (T-D1) — Word (.docx) テキスト抽出の薄い adapter。
 *
 * mammoth は **動的 import** で初期バンドルに載せない (Word を触った瞬間だけ chunk 取得 / xlsx.ts:28 同型)。
 * 呼出は本 adapter に隔離し loader 注入で単体テスト可能にする (hollow completion 回避 / §6・地雷 B4-8)。
 * Worker は触らない (攻撃面をブラウザに限定)。実 upload UI コントロールは B-5。
 */
import { KnowledgeExtractError } from './types';

/** mammoth の必要最小 API (structural)。 */
export interface MammothLike {
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}

export interface DocxExtractDeps {
  /** mammoth loader (テストで mock 差替)。default = dynamic import。 */
  loadMammoth?: () => Promise<MammothLike>;
}

async function defaultLoadMammoth(): Promise<MammothLike> {
  // 初期バンドル非搭載の動的 import。default/named の双方に対応 (ブラウザ bundle は default export のことがある)。
  const mod = (await import('mammoth')) as unknown as MammothLike & { default?: MammothLike };
  return mod.default ?? mod;
}

/**
 * .docx File → 段落テキストを返す (mammoth.extractRawText)。抽出が空なら empty として日本語エラーで拒否する。
 */
export async function extractDocxText(file: File, deps: DocxExtractDeps = {}): Promise<string> {
  const loadMammoth = deps.loadMammoth ?? defaultLoadMammoth;
  const arrayBuffer = await file.arrayBuffer();

  let mammoth: MammothLike;
  try {
    mammoth = await loadMammoth();
  } catch {
    throw new KnowledgeExtractError('extract_failed');
  }

  let result: { value: string };
  try {
    result = await mammoth.extractRawText({ arrayBuffer });
  } catch {
    throw new KnowledgeExtractError('extract_failed');
  }

  const text = result.value.trim();
  if (text.length === 0) throw new KnowledgeExtractError('empty');
  return text;
}
