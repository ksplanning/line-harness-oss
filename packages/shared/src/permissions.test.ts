import { describe, expect, test } from 'vitest';
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  FEATURE_DESCRIPTIONS,
  ROLE_TEMPLATES,
  getRoleTemplate,
  isFeatureKey,
  allFeatures,
} from './permissions';

describe('permissions — feature keys (単一正典 / 20 feature)', () => {
  test('20 feature_key で重複なし', () => {
    expect(FEATURE_KEYS.length).toBe(20);
    expect(new Set(FEATURE_KEYS).size).toBe(20);
  });

  test('全 feature_key に日本語ラベルと説明がある (UI の穴なし)', () => {
    for (const k of FEATURE_KEYS) {
      expect(FEATURE_LABELS[k], `label missing: ${k}`).toBeTruthy();
      expect(FEATURE_DESCRIPTIONS[k], `desc missing: ${k}`).toBeTruthy();
    }
    // ラベル/説明に余分なキーが無い (drift 防止)
    expect(Object.keys(FEATURE_LABELS).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(Object.keys(FEATURE_DESCRIPTIONS).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(FEATURE_LABELS.forms_advanced).toBe('フォームビルダー');
    expect(FEATURE_DESCRIPTIONS.forms_advanced).not.toContain('高機能フォーム');
  });

  test('isFeatureKey は 20 のみ true / それ以外 false', () => {
    expect(isFeatureKey('chat')).toBe(true);
    expect(isFeatureKey('staff_admin')).toBe(true);
    expect(isFeatureKey('forms_advanced')).toBe(true); // F-2 で追加したフォームビルダー
    expect(isFeatureKey('nope')).toBe(false);
    expect(isFeatureKey('chat:read')).toBe(false);
  });

  test('allFeatures は 20 全部のコピーを返す (元配列を破壊しない)', () => {
    const a = allFeatures();
    a.push('x' as never);
    expect(FEATURE_KEYS.length).toBe(20);
  });
});

describe('permissions — テンプレート (owner Q2=全部 = 7 本)', () => {
  test('同梱テンプレは 7 本 (必須3 + 追加4)', () => {
    expect(ROLE_TEMPLATES.length).toBe(7);
    expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual([
      'chat_only',
      'broadcast_only',
      'chat_broadcast',
      'analytics_only',
      'form_booking',
      'content',
      'sub_admin',
    ]);
  });

  test('全テンプレの features が有効な feature_key のみ', () => {
    for (const t of ROLE_TEMPLATES) {
      expect(t.features.length).toBeGreaterThan(0);
      for (const f of t.features) {
        expect(isFeatureKey(f), `${t.id}: ${f}`).toBe(true);
      }
    }
  });

  test('必須3テンプレの feature 集合が §4-1 定義と一致', () => {
    expect(getRoleTemplate('chat_only')!.features.sort()).toEqual(['chat', 'friend'].sort());
    expect(getRoleTemplate('broadcast_only')!.features.sort()).toEqual(
      ['broadcast', 'broadcast_settings', 'template', 'media', 'scenario'].sort(),
    );
    // chat_broadcast = chat_only ∪ broadcast_only
    const union = new Set([
      ...getRoleTemplate('chat_only')!.features,
      ...getRoleTemplate('broadcast_only')!.features,
    ]);
    expect(new Set(getRoleTemplate('chat_broadcast')!.features)).toEqual(union);
  });

  test('準管理者は staff_admin だけを外した全 feature', () => {
    const sub = getRoleTemplate('sub_admin')!;
    expect(sub.features).not.toContain('staff_admin');
    expect(sub.features.length).toBe(19);
    expect(new Set(sub.features)).toEqual(new Set(FEATURE_KEYS.filter((k) => k !== 'staff_admin')));
  });

  test('フォーム・予約担当 (form_booking) はフォームビルダーも扱える', () => {
    expect(getRoleTemplate('form_booking')!.features).toContain('forms_advanced');
  });
});
