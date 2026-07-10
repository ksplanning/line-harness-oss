/**
 * B-5 (T-E1/T-E4) — 資料管理 / AI ログ・コスト UI の純関数テスト (visual-qa 封印の代替検証 / §9-2)。
 */
import { describe, expect, test } from 'vitest';
import {
  deriveEmbedStatus,
  headroomPercent,
  formatUsageBar,
  sumNeurons,
  formatStoredDimsEstimate,
  extractErrorMessage,
  AI_OPERATIONAL_CAP,
  AI_FREE_TIER_CAP,
} from './format';
import { KnowledgeExtractError } from '@/lib/knowledge-extract';

describe('deriveEmbedStatus', () => {
  test('chunk 0 → 未取込', () => {
    expect(deriveEmbedStatus({ chunkCount: 0, embeddedCount: 0 })).toEqual({ kind: 'none', label: '未取込' });
  });
  test('embed 済 0 → 未embed (意味検索未設定)', () => {
    expect(deriveEmbedStatus({ chunkCount: 5, embeddedCount: 0 })).toEqual({ kind: 'unembedded', label: '未embed（意味検索は未設定）' });
  });
  test('一部 embed → embed済 X/Y', () => {
    expect(deriveEmbedStatus({ chunkCount: 5, embeddedCount: 2 })).toEqual({ kind: 'partial', label: 'embed済 2/5' });
  });
  test('全 embed → embed済 Y/Y', () => {
    expect(deriveEmbedStatus({ chunkCount: 3, embeddedCount: 3 })).toEqual({ kind: 'done', label: 'embed済 3/3' });
  });
  test('embed 済が chunk 数を超えても clamp (壊れ値ガード)', () => {
    expect(deriveEmbedStatus({ chunkCount: 3, embeddedCount: 9 })).toEqual({ kind: 'done', label: 'embed済 3/3' });
  });
});

describe('headroomPercent / formatUsageBar (運用上限 9,000 と 無料枠 10,000 を別表示 / H-2)', () => {
  test('% は 0..100 に収まり小数第1位', () => {
    expect(headroomPercent(4500, 9000)).toBe(50);
    expect(headroomPercent(9999, 9000)).toBe(100); // cap 超は 100 止まり
    expect(headroomPercent(0, 9000)).toBe(0);
  });
  test('上限 0 は 0% (0 除算回避)', () => {
    expect(headroomPercent(100, 0)).toBe(0);
  });
  test('運用上限と無料枠の 2 段で別々の % が出る', () => {
    const used = 9000;
    const op = formatUsageBar(used, AI_OPERATIONAL_CAP, '運用上限');
    const free = formatUsageBar(used, AI_FREE_TIER_CAP, '無料枠');
    expect(op.percent).toBe(100);
    expect(free.percent).toBe(90); // 9000/10000
    expect(op.label).toContain('運用上限');
    expect(free.label).toContain('無料枠');
  });
});

describe('sumNeurons', () => {
  test('llm+embed+image を合算', () => {
    expect(sumNeurons({ llmNeurons: 100, embedNeurons: 20, imageNeurons: 5 })).toBe(125);
  });
});

describe('formatStoredDimsEstimate (下限推定・binding 無しは未計測 / H-3)', () => {
  test('次元未設定は未計測', () => {
    expect(formatStoredDimsEstimate(100, null)).toContain('未計測');
    expect(formatStoredDimsEstimate(100, 0)).toContain('未計測');
  });
  test('次元があれば embed 済数 × 次元の下限推定', () => {
    expect(formatStoredDimsEstimate(10, 1024)).toContain('10,240');
  });
});

describe('extractErrorMessage', () => {
  test('KnowledgeExtractError は理由別の日本語 message', () => {
    expect(extractErrorMessage(new KnowledgeExtractError('unsupported_doc'))).toContain('.doc');
    expect(extractErrorMessage(new KnowledgeExtractError('scanned_no_text'))).toContain('スキャン');
  });
  test('未知エラーは汎用文言', () => {
    expect(extractErrorMessage(new Error('boom'))).toContain('取り込みに失敗');
  });
});
