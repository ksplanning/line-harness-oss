/**
 * permission-map (G64) — route→feature の単一正典を検証。
 *   - 網羅性 (T-A5 / M-15): app に登録された全 /api route が feature_key か明示 null にマップされ、
 *     未マップ (undefined) が 0 件であることを機械保証する。新 route を足して map に足し忘れると落ちる。
 *   - specific-first の順序 (staff/me → null が staff → staff_admin より前 等)。
 */
import { describe, expect, test } from 'vitest';
import { app } from '../index.js';
import { mapPathToFeature } from './permission-map.js';

describe('permission-map 網羅性 (T-A5 / M-15 dead-code 防止)', () => {
  test('登録済み全 /api route が feature_key or 明示 null にマップされ、未マップ 0 件', () => {
    const apiRoutes = app.routes.filter(
      (r) => r.path.startsWith('/api/') && r.method !== 'ALL',
    );
    // sanity: そもそも route が取れている
    expect(apiRoutes.length).toBeGreaterThan(200);

    const unmapped = apiRoutes
      .map((r) => r.path)
      .filter((p) => mapPathToFeature(p) === undefined);
    expect(unmapped, `未マップ route:\n${unmapped.join('\n')}`).toEqual([]);
  });
});

describe('permission-map 個別マッピング (順序 / 代表)', () => {
  test('常に許可 (null)', () => {
    expect(mapPathToFeature('/api/staff/me')).toBeNull();
    expect(mapPathToFeature('/api/capabilities')).toBeNull();
    expect(mapPathToFeature('/api/auth/login')).toBeNull();
    expect(mapPathToFeature('/api/liff/forms/x')).toBeNull();
    expect(mapPathToFeature('/api/rich-menu-images/x')).toBeNull();
    // 非 /api は対象外 (null)
    expect(mapPathToFeature('/webhook')).toBeNull();
    expect(mapPathToFeature('/t/abc')).toBeNull();
  });

  test('staff/me は staff より先に評価され staff_admin に落ちない', () => {
    expect(mapPathToFeature('/api/staff/me')).toBeNull();
    expect(mapPathToFeature('/api/staff')).toBe('staff_admin');
    expect(mapPathToFeature('/api/staff/:id')).toBe('staff_admin');
    expect(mapPathToFeature('/api/staff/:id/password')).toBe('staff_admin');
    expect(mapPathToFeature('/api/roles')).toBe('staff_admin');
  });

  test('prefix bleed しない (analytics vs rich_menu / template-packs vs templates)', () => {
    expect(mapPathToFeature('/api/rich-menu-analytics/x')).toBe('analytics');
    expect(mapPathToFeature('/api/rich-menu-groups/x')).toBe('rich_menu');
    expect(mapPathToFeature('/api/rich-menus')).toBe('rich_menu');
    expect(mapPathToFeature('/api/template-packs')).toBe('template');
    expect(mapPathToFeature('/api/message-templates')).toBe('template');
    expect(mapPathToFeature('/api/templates')).toBe('template');
    expect(mapPathToFeature('/api/account-settings/test-recipients')).toBe('broadcast_settings');
    expect(mapPathToFeature('/api/accounts/x/health')).toBe('account');
  });

  test('代表 feature の対応', () => {
    expect(mapPathToFeature('/api/chats')).toBe('chat');
    expect(mapPathToFeature('/api/notifications')).toBe('chat');
    expect(mapPathToFeature('/api/broadcasts')).toBe('broadcast');
    expect(mapPathToFeature('/api/scenarios')).toBe('scenario');
    expect(mapPathToFeature('/api/automations')).toBe('scenario');
    expect(mapPathToFeature('/api/friends')).toBe('friend');
    expect(mapPathToFeature('/api/forms')).toBe('form');
    expect(mapPathToFeature('/api/faqs')).toBe('faq');
    expect(mapPathToFeature('/api/booking/menus')).toBe('booking');
    expect(mapPathToFeature('/api/reminders')).toBe('booking');
    expect(mapPathToFeature('/api/events')).toBe('event');
    expect(mapPathToFeature('/api/images')).toBe('media');
    expect(mapPathToFeature('/api/exports')).toBe('export');
    expect(mapPathToFeature('/api/line-accounts')).toBe('account');
    expect(mapPathToFeature('/api/integrations/stripe/x')).toBe('integration');
    expect(mapPathToFeature('/api/admin/refresh-profiles')).toBe('system_update');
    expect(mapPathToFeature('/api/auto-replies')).toBe('auto_reply');
  });

  test('本当に存在しない /api path は undefined (未マップ)', () => {
    expect(mapPathToFeature('/api/totally-made-up-xyz')).toBeUndefined();
  });
});
