/**
 * T-B1 — decideDriftAction (純粋な drift 判定器 / 6 分岐)。
 *   baseline NULL → bootstrapped(no-fire) / fp==baseline → none /
 *   fp≠baseline+out_of_sync → conflict_held / fp≠baseline+weakened → notified /
 *   fp≠baseline+clean+autoApply OFF → notified / fp≠baseline+clean+autoApply ON → auto_applied。
 */
import { describe, it, expect } from 'vitest';
import { decideDriftAction, type DriftDecisionInput } from './formaloo-drift';

function input(over: Partial<DriftDecisionInput>): DriftDecisionInput {
  return { baseline: 'base', fingerprint: 'base', weakened: false, syncStatus: 'idle', autoApplyEnabled: false, ...over };
}

describe('decideDriftAction', () => {
  it('baseline NULL → bootstrapped (前状態不明 → 現状を基準採用・発火しない)', () => {
    expect(decideDriftAction(input({ baseline: null, fingerprint: 'fp' }))).toBe('bootstrapped');
  });

  it('fingerprint == baseline → none (drift なし)', () => {
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'x' }))).toBe('none');
  });

  it('drift かつ out_of_sync → conflict_held (autoApply ON でも apply しない)', () => {
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', syncStatus: 'out_of_sync', autoApplyEnabled: true }))).toBe('conflict_held');
    // clean でも weakened でも out_of_sync が最優先
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', syncStatus: 'out_of_sync', weakened: true, autoApplyEnabled: true }))).toBe('conflict_held');
  });

  it('drift かつ weakened (out_of_sync でない) → notified (autoApply ON でも apply しない)', () => {
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', weakened: true, autoApplyEnabled: true }))).toBe('notified');
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', weakened: true, autoApplyEnabled: false }))).toBe('notified');
  });

  it('drift かつ clean かつ autoApply OFF → notified (案 B 既定)', () => {
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', autoApplyEnabled: false }))).toBe('notified');
  });

  it('drift かつ clean かつ autoApply ON → auto_applied (案 A)', () => {
    expect(decideDriftAction(input({ baseline: 'x', fingerprint: 'y', autoApplyEnabled: true }))).toBe('auto_applied');
  });
});
