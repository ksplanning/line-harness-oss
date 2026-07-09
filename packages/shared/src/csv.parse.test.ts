import { describe, expect, test } from 'vitest';
import { toCsv, parseCsv } from './csv.js';

// parseCsv は toCsv の逆 (round-trip)。RFC4180 (引用符/改行/カンマ) + BOM 除去。
describe('parseCsv', () => {
  test('空入力は []', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
  });

  test('単純な行/列', () => {
    expect(parseCsv('a,b,c\r\n1,2,3\r\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  test('BOM を除去', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('引用符囲み: カンマ・改行・"" エスケープ', () => {
    const csv = '"x,y","line\r\nbreak","he said ""hi"""\r\n';
    expect(parseCsv(csv)).toEqual([['x,y', 'line\r\nbreak', 'he said "hi"']]);
  });

  test('LF のみの改行も許容', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('toCsv → parseCsv の round-trip (injection sanitize 無しで対称)', () => {
    const headers = ['名前', 'メモ'];
    const rows = [['田中', 'こんにちは, "世界"'], ['鈴木', '複数\n行']];
    const csv = toCsv(headers, rows, { sanitize: false });
    expect(parseCsv(csv)).toEqual([headers, ...rows]);
  });
});
