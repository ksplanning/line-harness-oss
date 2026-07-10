/**
 * Phase B B-4 (T-D1) — 取込ファイル抽出 lib の barrel + 形式 routing。
 *
 * detect (マジックバイト) → route (pdf/docx) → [制約] (.doc/unknown) を日本語エラーで拒否。
 * 抽出テキストは呼出元 (upload UI = B-5) が既存 `POST /api/knowledge/ingest` **kind=text** に流す
 * (取込 route/source_type/migration は無改修 / §6)。B-4 は lib + web vitest まで。
 */
import { detectFileFormat } from './format-detect';
import { KnowledgeExtractError } from './types';
import { extractPdfText, type PdfExtractDeps } from './pdf';
import { extractDocxText, type DocxExtractDeps } from './docx';

export * from './types';
export * from './format-detect';
export * from './pdf';
export * from './docx';

export type ExtractDeps = PdfExtractDeps & DocxExtractDeps;

/**
 * File を形式判定して対応する抽出へ routing。先頭 8 byte だけ読んでマジックバイト判定 (全読込前に拒否可)。
 * .doc 旧形式 / 未対応形式は KnowledgeExtractError (日本語) で拒否する。
 */
export async function extractKnowledgeText(file: File, deps: ExtractDeps = {}): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const format = detectFileFormat(head);
  switch (format) {
    case 'pdf':
      return extractPdfText(file, deps);
    case 'docx':
      return extractDocxText(file, deps);
    case 'doc':
      throw new KnowledgeExtractError('unsupported_doc');
    default:
      throw new KnowledgeExtractError('unsupported_format');
  }
}
