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
    // H-3: /api/accounts/* は health.ts のシステム操作 = system_update (旧 account から是正)
    expect(mapPathToFeature('/api/accounts/x/health')).toBe('system_update');
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
    // Phase B B-3: 取込ナレッジは既存 faq 権限で gate (新 FeatureKey なし / Codex #12)。
    expect(mapPathToFeature('/api/knowledge/ingest')).toBe('faq');
    expect(mapPathToFeature('/api/knowledge/documents')).toBe('faq');
    expect(mapPathToFeature('/api/booking/menus')).toBe('booking');
    expect(mapPathToFeature('/api/reminders')).toBe('booking');
    expect(mapPathToFeature('/api/events')).toBe('event');
    expect(mapPathToFeature('/api/images')).toBe('media');
    expect(mapPathToFeature('/api/exports')).toBe('export');
    expect(mapPathToFeature('/api/line-accounts')).toBe('account');
    expect(mapPathToFeature('/api/integrations/stripe/x')).toBe('integration');
    expect(mapPathToFeature('/api/admin/refresh-profiles')).toBe('system_update');
    expect(mapPathToFeature('/api/auto-replies')).toBe('auto_reply');
    // F6-1: Formaloo workspace キー管理 (custom role 導線 gate / 真の enforcement は route の ownerGate)
    expect(mapPathToFeature('/api/formaloo-workspaces')).toBe('forms_advanced');
    expect(mapPathToFeature('/api/formaloo-workspaces/test')).toBe('forms_advanced');
    expect(mapPathToFeature('/api/formaloo-workspaces/fw_x')).toBe('forms_advanced');
    // forms-advanced とは別 prefix (bleed しない)
    expect(mapPathToFeature('/api/forms-advanced')).toBe('forms_advanced');
  });

  test('本当に存在しない /api path は undefined (未マップ)', () => {
    expect(mapPathToFeature('/api/totally-made-up-xyz')).toBeUndefined();
  });
});

describe('機微 sub-route の意味的正しさ (reviewer Round1 再発防止 / undefined=0 だけでは不十分)', () => {
  // 親 prefix と別 feature に属する sub-route を「意図した feature」に明示 assert (今回の穴を test で固定)。
  test.each([
    // H-1: 実顧客へ送信 = チャット (friend 管理では送信させない)
    ['/api/friends/abc/messages', 'chat'],
    // H-2: 個別リッチメニュー = rich_menu
    ['/api/friends/abc/rich-menu', 'rich_menu'],
    // M-1: 個別スコア = analytics
    ['/api/friends/abc/score', 'analytics'],
    // G64 R2-1: 個別友だちの予約リマインダー = booking (friend 権限では到達させない)
    ['/api/friends/abc/reminders', 'booking'],
    // 親 friends は friend のまま (list/tag/metadata)
    ['/api/friends/abc', 'friend'],
    ['/api/friends/abc/tags', 'friend'],
    ['/api/friends/abc/metadata', 'friend'],
    // H-3: アカウント健全性/移行 (状態変更) = system_update
    ['/api/accounts/abc/health', 'system_update'],
    ['/api/accounts/abc/migrate', 'system_update'],
    ['/api/accounts/migrations', 'system_update'],
    ['/api/accounts/migrations/xyz', 'system_update'],
    // M-2: friend-reminders = booking
    ['/api/friend-reminders/abc', 'booking'],
    // M-3: FAQ bot 設定 = faq / account-settings 本体は broadcast_settings のまま
    ['/api/account-settings/faq-bot', 'faq'],
    ['/api/account-settings/test-recipients', 'broadcast_settings'],
    // 送信の正規ルートは broadcast のまま (回帰確認)
    ['/api/broadcasts/abc', 'broadcast'],
  ])('%s は feature=%s', (path, feature) => {
    expect(mapPathToFeature(path)).toBe(feature);
  });
});
