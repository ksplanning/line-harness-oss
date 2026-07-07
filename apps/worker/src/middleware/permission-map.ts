import type { FeatureKey } from '@line-crm/shared';

// =============================================================================
// route → feature マップ (G64 / 単一正典)
// -----------------------------------------------------------------------------
// permissionMiddleware が各 /api リクエストのパスをどの feature_key で gate するかを決める唯一の表。
// 上から順にマッチ (specific-first)。§1-4 の 19 feature_key を全 route prefix で網羅する。
//   - FeatureKey  → その feature の権限で gate
//   - null        → 権限対象外 (常に許可 / 公開 or 内部 route / staff/me・capabilities・auth 等)
//   - undefined   → 未マップ (mapPathToFeature が返す。coverage test が 0 件を保証 / M-15)
// 新しい /api route を足したら **この表に 1 行足す** (足し忘れは permission-map.test.ts が落として気付く)。
// =============================================================================

interface FeatureRule {
  test: RegExp;
  feature: FeatureKey | null;
}

/** /api/<seg> で始まり、その後がスラッシュ or 終端 (prefix bleed 防止)。 */
function prefix(seg: string): RegExp {
  return new RegExp(`^/api/${seg}(?:/|$)`);
}

export const PATH_FEATURE_RULES: FeatureRule[] = [
  // ── 常に許可 (権限対象外 / null) — specific-first で他ルールより前 ──
  { test: /^\/api\/staff\/me(?:\/|$)/, feature: null }, // 自分の情報 (全認証ユーザー)
  { test: prefix('capabilities'), feature: null },      // 能力ディスカバリ
  { test: prefix('auth'), feature: null },              // login/logout (公開)
  { test: prefix('protected'), feature: null },         // test 専用 route
  { test: prefix('qr'), feature: null },                // 公開 QR proxy
  { test: prefix('meet-callback'), feature: null },     // 公開 callback
  { test: prefix('liff'), feature: null },              // LIFF 公開
  { test: prefix('rich-menu-images'), feature: null },  // 公開画像 proxy

  // ── スタッフ・ロール管理 (staff_admin) ──
  { test: prefix('staff'), feature: 'staff_admin' },
  { test: prefix('roles'), feature: 'staff_admin' }, // ロール CRUD (owner requireRole でも二重 gate)

  // ── 分析・計測 (analytics) — rich-menu-analytics を rich-menu* より前に ──
  { test: prefix('rich-menu-analytics'), feature: 'analytics' },
  { test: prefix('analytics'), feature: 'analytics' },
  { test: prefix('tracked-links'), feature: 'analytics' },
  { test: prefix('conversions'), feature: 'analytics' },
  { test: prefix('affiliates-report'), feature: 'analytics' },
  { test: prefix('affiliates'), feature: 'analytics' },
  { test: prefix('scoring-rules'), feature: 'analytics' },
  { test: prefix('entry-routes'), feature: 'analytics' },
  { test: prefix('links'), feature: 'analytics' },

  // ── リッチメニュー (rich_menu) ──
  { test: prefix('rich-menu-groups'), feature: 'rich_menu' },
  { test: prefix('rich-menus'), feature: 'rich_menu' },

  // ── 予約 (booking) — reminders も予約領域 ──
  { test: prefix('booking'), feature: 'booking' },
  { test: prefix('reminders'), feature: 'booking' },

  // ── イベント (event) ──
  { test: prefix('events'), feature: 'event' },

  // ── シナリオ (scenario) ──
  { test: prefix('scenarios'), feature: 'scenario' },
  { test: prefix('automations'), feature: 'scenario' },

  // ── 配信 (broadcast) ──
  { test: prefix('broadcasts'), feature: 'broadcast' },
  { test: prefix('campaigns'), feature: 'broadcast' },
  { test: prefix('ab-tests'), feature: 'broadcast' },
  { test: prefix('sender-presets'), feature: 'broadcast' },
  { test: prefix('response-schedules'), feature: 'broadcast' },
  { test: prefix('segments'), feature: 'broadcast' },

  // ── 配信設定 (broadcast_settings) ──
  { test: prefix('account-settings'), feature: 'broadcast_settings' },

  // ── 自動応答 (auto_reply) / フォーム (form) / FAQ (faq) ──
  { test: prefix('auto-replies'), feature: 'auto_reply' },
  { test: prefix('forms'), feature: 'form' },
  { test: prefix('faqs'), feature: 'faq' },

  // ── テンプレート (template) — packs / message-templates を templates より前に ──
  { test: prefix('template-packs'), feature: 'template' },
  { test: prefix('message-templates'), feature: 'template' },
  { test: prefix('templates'), feature: 'template' },

  // ── メディア (media) / 書き出し (export) ──
  { test: prefix('images'), feature: 'media' },
  { test: prefix('exports'), feature: 'export' },

  // ── アカウント設定 (account) ──
  { test: prefix('line-accounts'), feature: 'account' },
  { test: prefix('traffic-pools'), feature: 'account' },
  { test: prefix('ad-platforms'), feature: 'account' },
  { test: prefix('webhooks'), feature: 'account' },
  { test: prefix('accounts'), feature: 'account' }, // /api/accounts/:id/health 等

  // ── 連携 (integration) / システム更新 (system_update) ──
  { test: prefix('integrations'), feature: 'integration' },
  { test: prefix('admin'), feature: 'system_update' }, // profile-refresh 等の管理操作

  // ── チャット対応 (chat) — notifications/inbox/conversations/operators/canned-responses ──
  { test: prefix('notifications'), feature: 'chat' },
  { test: prefix('chats'), feature: 'chat' },
  { test: prefix('conversations'), feature: 'chat' },
  { test: prefix('inbox'), feature: 'chat' },
  { test: prefix('operators'), feature: 'chat' },
  { test: prefix('canned-responses'), feature: 'chat' },

  // ── 友だち管理 (friend) — users-grouped を users より前に ──
  { test: prefix('friend-reminders'), feature: 'friend' },
  { test: prefix('friends'), feature: 'friend' },
  { test: prefix('tags'), feature: 'friend' },
  { test: prefix('users-grouped'), feature: 'friend' },
  { test: prefix('users'), feature: 'friend' },
  { test: prefix('duplicates'), feature: 'friend' },
  { test: prefix('saved-searches'), feature: 'friend' },
];

/**
 * パスを feature_key に解決する。
 *   - 非 /api パス → null (permissionMiddleware の対象外)
 *   - マッチした feature (FeatureKey) or 明示 null (常に許可)
 *   - どのルールにもマッチしない /api パス → undefined (未マップ = coverage test が捕捉 / 実運用では
 *     built-in=allow / custom=deny の fail-closed 分岐で扱う)
 */
export function mapPathToFeature(path: string): FeatureKey | null | undefined {
  if (!path.startsWith('/api/')) return null;
  for (const rule of PATH_FEATURE_RULES) {
    if (rule.test.test(path)) return rule.feature;
  }
  return undefined;
}
