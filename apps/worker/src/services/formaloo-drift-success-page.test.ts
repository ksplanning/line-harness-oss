/**
 * route-terminal-phase2 (T-E5 / CX-1) — drift auto-apply の successPages carry。
 *   mergeDriftSuccessPages: local の harness id/slug を保ちつつ remote 本文 (title/description) を slug で反映
 *   (完了ページ本文変更を検知)。remote 未確認 SP は保守的に保持・外部追加 SP は id=slug で追記。
 */
import { describe, expect, it } from 'vitest';
import { mergeDriftSuccessPages } from './formaloo-drift.js';
import type { SuccessPageSpec } from '@line-crm/shared';

describe('mergeDriftSuccessPages — drift carry (本文変更検知)', () => {
  it('local harness id を保ちつつ remote の title/description を slug で反映する (本文変更検知)', () => {
    const local: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_A', title: '旧見出し', description: '旧本文' }];
    const remote: SuccessPageSpec[] = [{ id: 'SP_A', slug: 'SP_A', title: '新見出し', description: '新本文' }];
    const out = mergeDriftSuccessPages(local, remote);
    expect(out).toEqual([{ id: 'sp1', slug: 'SP_A', title: '新見出し', description: '新本文' }]);
  });

  it('remote に description が無ければ description を落とす (remote が正)', () => {
    const local: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_A', title: 'T', description: '旧本文' }];
    const remote: SuccessPageSpec[] = [{ id: 'SP_A', slug: 'SP_A', title: 'T' }];
    expect(mergeDriftSuccessPages(local, remote)).toEqual([{ id: 'sp1', slug: 'SP_A', title: 'T' }]);
  });

  it('remote に無い local SP は保守的に保持する (無関係 drift で消えない)', () => {
    const local: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_A', title: 'A' }];
    const out = mergeDriftSuccessPages(local, []);
    expect(out).toEqual([{ id: 'sp1', slug: 'SP_A', title: 'A' }]);
  });

  it('外部で追加された remote-only SP は id=slug で追記する', () => {
    const local: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_A', title: 'A' }];
    const remote: SuccessPageSpec[] = [
      { id: 'SP_A', slug: 'SP_A', title: 'A' },
      { id: 'SP_X', slug: 'SP_X', title: '外部追加' },
    ];
    const out = mergeDriftSuccessPages(local, remote);
    expect(out.map((s) => s.slug)).toEqual(['SP_A', 'SP_X']);
    expect(out.find((s) => s.slug === 'SP_X')).toEqual({ id: 'SP_X', slug: 'SP_X', title: '外部追加' });
  });
});
