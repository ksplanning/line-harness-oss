/**
 * B-5 (T-E7) — **実 deps 統合** (mock でなく実 pdfjs-dist / 実 mammoth を回す)。
 *  - 「本番だけで動く untested code (hollow completion)」を潰す: B-4 は loader 注入 (mock) で構造検証まで。
 *    本テストは worker 無効 (legacy build) の**実 pdfjs-dist** で手組み PDF を、**実 mammoth** で手組み .docx を
 *    抽出しテキストが返ることを確認する。fixture はバイナリ commit 回避のためテスト内で in-memory 構築 (PUBLIC repo)。
 *  - pdf.js workerSrc: node/vitest では legacy build の fake worker (main-thread) を使い実 worker asset を要さない。
 *    本番ブラウザの GlobalWorkerOptions.workerSrc 配線は upload コンポーネント (T-E1) が /public asset に対して行う。
 */
import { describe, expect, test } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extractPdfText } from './pdf';
import { extractDocxText } from './docx';

const require = createRequire(import.meta.url);

// ── crc32 (ZIP stored/deflate entry 用・標準多項式) ────────────────────────────
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── 最小 ZIP 生成 (deflate) — .docx は OOXML の ZIP コンテナ ─────────────────────
function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const comp = deflateRawSync(Buffer.from(e.data));
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 8, true); // method = deflate
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0, true); // date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true); // compressed
    lv.setUint32(22, e.data.length, true); // uncompressed
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    chunks.push(local, comp);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 8, true); // method
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); // local header offset
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + comp.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = [...chunks, ...central, eocd];
  const out = new Uint8Array(total.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of total) { out.set(c, p); p += c.length; }
  return out;
}

function buildDocx(paragraphText: string): Uint8Array {
  const enc = new TextEncoder();
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p>` +
    '</w:body></w:document>';
  return buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(document) },
  ]);
}

// ── 最小 PDF 生成 (テキスト層あり・xref 正確計算で pdfjs が strict 解析可能) ──────
function buildMinimalPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const header = '%PDF-1.4\n';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const stream = `BT /F1 24 Tf 30 120 Td (${text}) Tj ET`;
  objs.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let body = header;
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body + xref + trailer);
}

describe('実 pdfjs-dist 統合 (worker 無効・T-E7)', () => {
  test('手組み PDF から実 pdfjs でテキスト層を抽出できる (mock でない)', async () => {
    const pdfBytes = buildMinimalPdf('Hello Knowledge Base');
    const file = new File([pdfBytes], 'real.pdf', { type: 'application/pdf' });
    const out = await extractPdfText(file, {
      loadPdfjs: async () => {
        // legacy build を実 import し、workerSrc を legacy worker (.mjs) に解決 (node は fake worker を main-thread で回す)。
        // 本番ブラウザの workerSrc 配線 (/public asset) は upload コンポーネント (T-E1) が行う。ここは実 pdfjs 抽出の証明。
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
          pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
        return pdfjs as never;
      },
    });
    expect(out).toContain('Hello Knowledge Base');
  }, 30_000);
});

describe('実 mammoth 統合 (T-E7)', () => {
  test('手組み .docx から実 mammoth で段落テキストを抽出できる (mock でない)', async () => {
    const docxBytes = buildDocx('取り込むワード本文です。営業時間のご案内。');
    const file = new File([docxBytes], 'real.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const out = await extractDocxText(file, {
      loadMammoth: async () => {
        // 実 mammoth を import。node build は入力キーが { buffer } (browser build は { arrayBuffer })。lib は browser 向けに
        // { arrayBuffer } を渡すため、node テストでは arrayBuffer→Buffer を橋渡しして実 mammoth の抽出を回す
        // (抽出ロジックは実物・入力キーの node/browser 差のみ吸収 = hollow completion を潰す本来の意図を満たす)。
        const mod = (await import('mammoth')) as unknown as {
          default?: { extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }> };
          extractRawText?: (i: { buffer: Buffer }) => Promise<{ value: string }>;
        };
        const real = mod.default ?? (mod as { extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }> });
        return {
          async extractRawText(input: { arrayBuffer: ArrayBuffer }) {
            return real.extractRawText({ buffer: Buffer.from(input.arrayBuffer) });
          },
        };
      },
    });
    expect(out).toContain('取り込むワード本文です');
  }, 30_000);
});
