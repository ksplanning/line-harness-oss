/**
 * T-D1 (Phase B B-4) — PDF/.docx 抽出 lib (純関数 format-detect + dynamic import adapter)。
 *  - detectFileFormat: マジックバイトで pdf(%PDF)/docx(PK\x03\x04)/doc(D0CF11E0=拒否)/unknown を判定。
 *  - isLikelyScanned: テキスト層なし PDF (near-empty) を scanned 判定。
 *  - extractPdfText/extractDocxText: 注入 loader (mock) で dynamic import を検証・[制約] を日本語エラー拒否。
 *  - extractKnowledgeText: detect→route→.doc/unknown を拒否。
 *  - source grep: pdfjs-dist/mammoth を静的 import せず (dynamic のみ)・Worker を import しない。
 * 実 pdf.js/mammoth 呼出 (dynamic import) は薄い adapter に隔離し loader 注入で決定的に検証 (hollow 回避 / §6)。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { detectFileFormat, isLikelyScanned } from './format-detect';
import { KnowledgeExtractError } from './types';
import { extractPdfText, type PdfjsLike } from './pdf';
import { extractDocxText, type MammothLike } from './docx';
import { extractKnowledgeText } from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSrc = (p: string) => readFileSync(join(__dirname, p), 'utf8');

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (ZIP)
const DOC_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // OLE2 (旧 .doc)

function fileWith(magic: number[], name: string): File {
  return new File([new Uint8Array([...magic, 0x00, 0x01, 0x02, 0x03])], name);
}

/** pages = ページごとの token 配列。 */
function mockPdfjs(pages: string[][], opts: { rejectGetDocument?: Error } = {}): PdfjsLike {
  return {
    getDocument() {
      if (opts.rejectGetDocument) return { promise: Promise.reject(opts.rejectGetDocument) };
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          async getPage(n: number) {
            return { async getTextContent() { return { items: pages[n - 1].map((str) => ({ str })) }; } };
          },
        }),
      };
    },
  };
}

function mockMammoth(value: string): MammothLike {
  return { async extractRawText() { return { value }; } };
}

describe('detectFileFormat — マジックバイト判定 (T-D1)', () => {
  test('%PDF → pdf', () => {
    expect(detectFileFormat(new Uint8Array([...PDF_MAGIC, 0x2d]))).toBe('pdf');
  });
  test('PK\\x03\\x04 (ZIP) → docx', () => {
    expect(detectFileFormat(new Uint8Array([...DOCX_MAGIC, 0x14]))).toBe('docx');
  });
  test('D0CF11E0 (OLE2) → doc (拒否対象)', () => {
    expect(detectFileFormat(new Uint8Array([...DOC_MAGIC, 0xa1]))).toBe('doc');
  });
  test('未知のバイト列 → unknown', () => {
    expect(detectFileFormat(new Uint8Array([0x00, 0x11, 0x22, 0x33]))).toBe('unknown');
    expect(detectFileFormat(new Uint8Array([0x25]))).toBe('unknown'); // 短すぎ
  });
});

describe('isLikelyScanned — テキスト層なし PDF 検出 (T-D1)', () => {
  test('near-empty / 空白のみ → scanned', () => {
    expect(isLikelyScanned('')).toBe(true);
    expect(isLikelyScanned('   \n \t ')).toBe(true);
    expect(isLikelyScanned('あ')).toBe(true); // 実文字が閾値未満
  });
  test('十分な本文 → not scanned', () => {
    expect(isLikelyScanned('営業時間は平日10時から19時まで、土日は11時から18時までです。')).toBe(false);
  });
});

describe('extractPdfText — dynamic import adapter (T-D1)', () => {
  test('全ページの getTextContent を連結して返す', async () => {
    const file = fileWith(PDF_MAGIC, 'a.pdf');
    const out = await extractPdfText(file, { loadPdfjs: async () => mockPdfjs([['営業', '時間は'], ['10時から19時']]) });
    expect(out).toContain('営業 時間は');
    expect(out).toContain('10時から19時');
  });

  test('パスワード付き (PasswordException) → password_protected を日本語エラーで拒否', async () => {
    const err = new Error('No password given'); err.name = 'PasswordException';
    const file = fileWith(PDF_MAGIC, 'p.pdf');
    await expect(extractPdfText(file, { loadPdfjs: async () => mockPdfjs([], { rejectGetDocument: err }) }))
      .rejects.toMatchObject({ name: 'KnowledgeExtractError', reason: 'password_protected' });
  });

  test('スキャン PDF (テキスト層なし) → scanned_no_text を拒否', async () => {
    const file = fileWith(PDF_MAGIC, 's.pdf');
    await expect(extractPdfText(file, { loadPdfjs: async () => mockPdfjs([[''], ['  ']]) }))
      .rejects.toMatchObject({ name: 'KnowledgeExtractError', reason: 'scanned_no_text' });
  });

  test('loader 失敗 → extract_failed を拒否', async () => {
    const file = fileWith(PDF_MAGIC, 'x.pdf');
    await expect(extractPdfText(file, { loadPdfjs: async () => { throw new Error('module load fail'); } }))
      .rejects.toBeInstanceOf(KnowledgeExtractError);
  });
});

describe('extractDocxText — dynamic import adapter (T-D1)', () => {
  test('mammoth.extractRawText の value を返す', async () => {
    const file = fileWith(DOCX_MAGIC, 'a.docx');
    const out = await extractDocxText(file, { loadMammoth: async () => mockMammoth('取り込む本文です') });
    expect(out).toBe('取り込む本文です');
  });
  test('空抽出 → empty を拒否', async () => {
    const file = fileWith(DOCX_MAGIC, 'e.docx');
    await expect(extractDocxText(file, { loadMammoth: async () => mockMammoth('   ') }))
      .rejects.toMatchObject({ name: 'KnowledgeExtractError', reason: 'empty' });
  });
});

describe('extractKnowledgeText — detect→route→[制約] 拒否 (T-D1)', () => {
  test('pdf は pdf 抽出へ routing', async () => {
    const file = fileWith(PDF_MAGIC, 'a.pdf');
    const out = await extractKnowledgeText(file, { loadPdfjs: async () => mockPdfjs([['店舗の案内文です。営業時間は平日10時から19時まで。']]) });
    expect(out).toContain('店舗の案内文です');
  });
  test('docx は docx 抽出へ routing', async () => {
    const file = fileWith(DOCX_MAGIC, 'a.docx');
    const out = await extractKnowledgeText(file, { loadMammoth: async () => mockMammoth('ワード文書の本文') });
    expect(out).toBe('ワード文書の本文');
  });
  test('.doc 旧形式 → unsupported_doc を日本語エラーで拒否', async () => {
    const file = fileWith(DOC_MAGIC, 'old.doc');
    await expect(extractKnowledgeText(file)).rejects.toMatchObject({ reason: 'unsupported_doc' });
    await expect(extractKnowledgeText(file)).rejects.toThrow(/\.doc|Word/);
  });
  test('unknown 形式 → unsupported_format を拒否', async () => {
    const file = new File([new Uint8Array([0x00, 0x11, 0x22, 0x33])], 'x.bin');
    await expect(extractKnowledgeText(file)).rejects.toMatchObject({ reason: 'unsupported_format' });
  });
});

describe('テスト可能性/依存境界 — 静的 import なし・Worker 非依存 (T-D1 / 地雷 B4-8)', () => {
  test('pdf.ts/docx.ts は pdfjs-dist/mammoth を dynamic import のみ (静的 import 0)', () => {
    const pdfSrc = readSrc('pdf.ts');
    const docxSrc = readSrc('docx.ts');
    expect(pdfSrc).toMatch(/await import\(['"]pdfjs-dist['"]\)/);
    expect(pdfSrc).not.toMatch(/^\s*import[^\n]*from ['"]pdfjs-dist['"]/m);
    expect(docxSrc).toMatch(/await import\(['"]mammoth['"]\)/);
    expect(docxSrc).not.toMatch(/^\s*import[^\n]*from ['"]mammoth['"]/m);
  });
  test('lib は Worker / D1 を import しない (攻撃面をブラウザに限定・D1 非波及)', () => {
    for (const f of ['pdf.ts', 'docx.ts', 'format-detect.ts', 'types.ts', 'index.ts']) {
      const src = readSrc(f);
      expect(src).not.toMatch(/@line-crm\/worker|apps\/worker|D1Database|workers-ai/);
    }
  });
});
