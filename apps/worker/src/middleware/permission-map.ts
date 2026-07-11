import type { FeatureKey } from '@line-crm/shared';

// =============================================================================
// route → feature マップ (G64 / 単一正典)
// -----------------------------------------------------------------------------
// permissionMiddleware が各 /api リクエストのパスをどの feature_key で gate するかを決める唯一の表。
// 上から順にマッチ (specific-first)。§1-4 の 20 feature_key を全 route prefix で網羅する。
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

  // ── 機微 sub-route は親 prefix より前に真の feature へ (reviewer Round1 H-1/H-2/H-3/M-1/M-3) ──
  // ⚠️ specific-first: これらは prefix('friends')/prefix('accounts')/prefix('account-settings') より上に置き、
  //    親 prefix の feature (friend/account/broadcast_settings) に飲まれないようにする。
  // 個別友だちへの送信/会話履歴 = チャット対応 (friend 管理では実顧客に送信させない / 誤送信防止 = H-1)
  { test: /^\/api\/friends\/[^/]+\/messages(?:\/|$)/, feature: 'chat' },
  // 個別リッチメニュー 取得/紐付け/解除 = リッチメニュー (H-2)
  { test: /^\/api\/friends\/[^/]+\/rich-menu(?:\/|$)/, feature: 'rich_menu' },
  // 個別友だちスコア = 分析 (M-1)
  { test: /^\/api\/friends\/[^/]+\/score(?:\/|$)/, feature: 'analytics' },
  // 個別友だちの予約リマインダー = 予約 (G64 R2-1: friend 管理では予約領域へ入れない)
  { test: /^\/api\/friends\/[^/]+\/reminders(?:\/|$)/, feature: 'booking' },
  // FAQ bot 設定 (account-settings prefix だが FAQ 機能 / M-3)
  { test: /^\/api\/account-settings\/faq-bot(?:\/|$)/, feature: 'faq' },

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

  // ── 予約 (booking) — reminders / friend-reminders も予約領域 ──
  { test: prefix('booking'), feature: 'booking' },
  { test: prefix('reminders'), feature: 'booking' },
  { test: prefix('friend-reminders'), feature: 'booking' }, // M-2: friend でなく booking

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

  // ── 自動応答 (auto_reply) / 高機能フォーム (forms_advanced) / フォーム (form) / FAQ (faq) ──
  // ⚠️ specific-first: forms-advanced を forms より上に置く (Formaloo-backed 高機能フォーム = 別 feature)。
  //    正規表現上 prefix('forms') は /api/forms-advanced に bleed しないが (末尾 `-` は (?:/|$) 不一致)、
  //    並び替え耐性のため specific-first を明示。mutating (sync/publish) は roles/permissions.test で 403 固定。
  { test: prefix('auto-replies'), feature: 'auto_reply' },
  { test: prefix('forms-advanced'), feature: 'forms_advanced' },
  // F6-1: Formaloo workspace キー管理。custom role 導線用に forms_advanced feature で gate
  //   (真の enforcement は route の ownerGate = built-in admin/staff も非 owner は 403 / Codex gap #6)。
  { test: prefix('formaloo-workspaces'), feature: 'forms_advanced' },
  // F6-2: アカウント→既定 workspace の binding。formaloo-workspaces と同様 forms_advanced feature で gate
  //   (真の enforcement は route の ownerGate)。
  { test: prefix('formaloo-account-bindings'), feature: 'forms_advanced' },
  // F6-3: ハーネス側フォルダ分類 (SoT)。forms_advanced feature で gate だが **ownerGate を route に付けない** =
  //   staff 利用可 (F6-1/F6-2 と異なる)。forms_advanced を持たない custom role は middleware が 403 で締める。
  { test: prefix('formaloo-folders'), feature: 'forms_advanced' },
  { test: prefix('forms'), feature: 'form' },
  { test: prefix('faqs'), feature: 'faq' },
  // 取込ナレッジ (Phase B B-3) は FAQ と同じ「よくある質問」機能の一部 = 既存 faq 権限で gate (新 FeatureKey なし)。
  { test: prefix('knowledge'), feature: 'faq' },

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
  // H-3: /api/accounts/* は health.ts のアカウント健全性/移行 (状態変更含む) のみ = システム更新。
  //      アカウント設定 (LINE 連携) は /api/line-accounts (account) 側なので混同しない。
  { test: prefix('accounts'), feature: 'system_update' },

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
  // (friend-reminders は booking / friends の messages・rich-menu・score・reminders は上の specific-first で除外済)
  { test: prefix('friends'), feature: 'friend' },
  { test: prefix('tags'), feature: 'friend' },
  { test: prefix('users-grouped'), feature: 'friend' },
  { test: prefix('users'), feature: 'friend' },
  { test: prefix('duplicates'), feature: 'friend' },
  { test: prefix('saved-searches'), feature: 'friend' },
];

// =============================================================================
// 公開 API の method 分類 (§2-5 / T-A8 / Codex CRITICAL-2)
// -----------------------------------------------------------------------------
// authMiddleware の forms 公開 skip は元々 method-blind で、GET だけが公開のはずの
// /api/forms/:id を PUT/DELETE でも無認証で素通しさせていた (権限層より前に抜ける穴)。
// ここに「公開が意図された (path, method) の組」だけを列挙し、それ以外の method は
// 認証+権限を通す (公開 GET / 公開 POST(submit 系) は不変 / LIFF 無回帰)。
// =============================================================================

interface PublicRule {
  test: RegExp;
  methods: readonly string[];
}

export const PUBLIC_METHOD_RULES: PublicRule[] = [
  { test: /^\/api\/forms\/[^/]+\/submit$/, methods: ['POST'] }, // LIFF フォーム送信
  { test: /^\/api\/forms\/[^/]+\/opened$/, methods: ['POST'] }, // 開封計測
  { test: /^\/api\/forms\/[^/]+\/partial$/, methods: ['POST'] }, // 途中保存
  { test: /^\/api\/forms\/[^/]+$/, methods: ['GET'] }, // GET フォーム定義 (公開 / LIFF) — PUT/DELETE は認証必須
];

/** (path, method) が「公開が意図された」組か。true の時だけ authMiddleware を skip する。 */
export function isPublicApiRoute(path: string, method: string): boolean {
  const m = method.toUpperCase();
  return PUBLIC_METHOD_RULES.some((r) => r.test.test(path) && r.methods.includes(m));
}

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
