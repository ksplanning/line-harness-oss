import { describe, expect, test } from 'vitest';
import { CSV_BOM, csvEscape, csvSanitizeCell, toCsv } from './csv';

describe('csvEscape (RFC4180 / T-C1)', () => {
  test('プレーンな値はそのまま返す', () => {
    expect(csvEscape('田中太郎')).toBe('田中太郎');
    expect(csvEscape('')).toBe('');
  });

  test('カンマを含むセルは "" で囲む', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  test('改行 (LF/CRLF) を含むセルは "" で囲む', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  test('引用符を含むセルは "" で囲み内部の " を "" に倍化する', () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  test('sanitize=false で injection 無害化をスキップできる (FAQ テンプレ互換)', () => {
    expect(csvEscape('=SUM(A1)', false)).toBe('=SUM(A1)');
  });
});

describe('csvSanitizeCell (CSV injection / HIGH-2)', () => {
  test('危険な先頭文字 (= + - @ TAB CR) のセルは先頭に単一引用符を付ける', () => {
    expect(csvSanitizeCell('=HYPERLINK("http://evil")')).toBe('\'=HYPERLINK("http://evil")');
    expect(csvSanitizeCell('+1234')).toBe("'+1234");
    expect(csvSanitizeCell('-1+1')).toBe("'-1+1");
    expect(csvSanitizeCell('@SUM')).toBe("'@SUM");
    expect(csvSanitizeCell('\tTAB')).toBe("'\tTAB");
    expect(csvSanitizeCell('\rCR')).toBe("'\rCR");
  });

  test('通常の日本語/英数字セルは変更しない (先頭が 0 の電話番号含む)', () => {
    expect(csvSanitizeCell('田中太郎')).toBe('田中太郎');
    expect(csvSanitizeCell('090-1234-5678')).toBe('090-1234-5678');
    expect(csvSanitizeCell('abc123')).toBe('abc123');
    expect(csvSanitizeCell('')).toBe('');
  });
});

describe('csvEscape + injection 合成', () => {
  test('=HYPERLINK を含むセルは無害化してから RFC4180 エスケープする', () => {
    // 先頭 ' が付き、内部に ( ) や " があれば "" 囲みになる
    const out = csvEscape('=HYPERLINK("http://evil","x")');
    expect(out.startsWith("\"'=HYPERLINK")).toBe(true);
    expect(out).toContain('""http://evil""');
  });
});

describe('toCsv (BOM / CRLF / 組立 / T-C1)', () => {
  test('先頭に UTF-8 BOM を付ける', () => {
    const csv = toCsv(['a'], [['1']]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  test('改行は CRLF・末尾にも CRLF を付ける', () => {
    const csv = toCsv(['h1', 'h2'], [['a', 'b']]);
    expect(csv).toBe(CSV_BOM + 'h1,h2\r\na,b\r\n');
  });

  test('null / undefined / 空セルは空文字になる', () => {
    const csv = toCsv(['x', 'y', 'z'], [[null, undefined, '']]);
    expect(csv).toBe(CSV_BOM + 'x,y,z\r\n,,\r\n');
  });

  test('number / boolean は文字列化する', () => {
    const csv = toCsv(['n', 'b'], [[42, true]]);
    expect(csv).toBe(CSV_BOM + 'n,b\r\n42,true\r\n');
  });

  test('カンマ/改行/引用符を含む日本語セルを正しくエスケープする', () => {
    const csv = toCsv(['名前', 'メモ'], [['山田, 花子', '改行\nあり']]);
    expect(csv).toBe(CSV_BOM + '名前,メモ\r\n"山田, 花子","改行\nあり"\r\n');
  });

  test('bom=false で BOM を省ける', () => {
    const csv = toCsv(['a'], [['1']], { bom: false });
    expect(csv).toBe('a\r\n1\r\n');
  });

  test('日本語データが UTF-8 で round-trip する (BOM 除去後に一致)', () => {
    const csv = toCsv(['表示名'], [['あいうえお漢字']]);
    const withoutBom = csv.slice(CSV_BOM.length);
    expect(withoutBom).toContain('あいうえお漢字');
  });
});
