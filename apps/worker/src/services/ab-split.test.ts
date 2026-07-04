/**
 * T-C5 / D-3 (F2 batch4 G1) — 決定論的分割 + 勝ち判定の純関数テスト。
 *  - splitAudience: 決定論 (同一入力で再現)・重複なし (1 friend は A か B のどちらか一方)・入力 dedup
 *  - decideWinner: metric(open_rate|click_rate) で勝ち・同点は tie 明示・insight null は dataPending
 */
import { describe, test, expect } from 'vitest';
import { splitAudience, decideWinner, stableHash, type VariantInsight } from './ab-split.js';

describe('splitAudience (deterministic, no duplicates)', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `friend-${i}`);

  test('same input reproduces the same split (deterministic)', () => {
    const a = splitAudience(ids);
    const b = splitAudience(ids);
    expect(a.variants.A).toEqual(b.variants.A);
    expect(a.variants.B).toEqual(b.variants.B);
  });

  test('every friend is in exactly one variant (no duplicates, no drops)', () => {
    const { variants, counts } = splitAudience(ids);
    const all = [...variants.A, ...variants.B];
    expect(new Set(all).size).toBe(all.length); // no dup
    expect(all.sort()).toEqual([...ids].sort()); // no drop
    expect(counts.A + counts.B).toBe(ids.length);
  });

  test('duplicate input ids are deduped (a friend cannot land in both variants)', () => {
    const { counts } = splitAudience(['x', 'x', 'y']);
    expect(counts.A + counts.B).toBe(2);
  });

  test('stableHash is deterministic', () => {
    expect(stableHash('friend-1')).toBe(stableHash('friend-1'));
    expect(stableHash('friend-1')).not.toBe(stableHash('friend-2'));
  });

  test('split is reasonably balanced for a large audience', () => {
    const { counts } = splitAudience(ids);
    // 200 件で 40:60 より偏らない (決定論だが概ね均衡)。
    expect(Math.min(counts.A, counts.B)).toBeGreaterThan(ids.length * 0.3);
  });
});

describe('decideWinner', () => {
  const mk = (variant: string, o: number | null, cl: number | null): VariantInsight => ({ variant, broadcastId: `b-${variant}`, openRate: o, clickRate: cl });

  test('picks the variant with the higher open_rate', () => {
    const r = decideWinner([mk('A', 0.4, 0.1), mk('B', 0.6, 0.05)], 'open_rate');
    expect(r.winner).toBe('B');
    expect(r.tie).toBe(false);
    expect(r.dataPending).toBe(false);
  });

  test('picks by click_rate when metric is click_rate', () => {
    const r = decideWinner([mk('A', 0.9, 0.2), mk('B', 0.1, 0.3)], 'click_rate');
    expect(r.winner).toBe('B');
  });

  test('equal metric → tie (winner null, tie true)', () => {
    const r = decideWinner([mk('A', 0.5, 0.1), mk('B', 0.5, 0.2)], 'open_rate');
    expect(r.winner).toBeNull();
    expect(r.tie).toBe(true);
  });

  test('null insight (crons=[] dark) → dataPending, winner null', () => {
    const r = decideWinner([mk('A', null, null), mk('B', 0.5, 0.1)], 'open_rate');
    expect(r.dataPending).toBe(true);
    expect(r.winner).toBeNull();
  });
});
