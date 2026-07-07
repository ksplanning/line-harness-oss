// =============================================================================
// カスタムロール + 機能単位 ON/OFF 権限 (G64) — 単一正典 (worker / web / sdk 共有)
// -----------------------------------------------------------------------------
// owner が「機能一覧で ON/OFF」する対象 = この 19 feature_key (案 A / owner 決定
// 2026-07-07 Q1=A)。read/write 分離 (案 B) は将来拡張 (feature_key を chat:read 等に
// 分割できる命名にしてある)。worker の enforcement (permission-map / resolvePermissions)
// と web の権限マトリクス UI・sidebar 出し分けは必ずこの配列を参照する (drift ゼロ / M-7)。
// =============================================================================

/** 機能一覧 = 19 feature_key。owner が ON/OFF する権限の粒度。順序 = 権限マトリクス UI の行順。 */
export const FEATURE_KEYS = [
  'chat',
  'broadcast',
  'broadcast_settings',
  'scenario',
  'auto_reply',
  'form',
  'friend',
  'faq',
  'analytics',
  'rich_menu',
  'template',
  'booking',
  'event',
  'media',
  'export',
  'account',
  'integration',
  'system_update',
  'staff_admin',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** feature_key → 日本語ラベル (権限マトリクス UI の行ラベル)。 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  chat: 'チャット対応',
  broadcast: '配信',
  broadcast_settings: '配信設定',
  scenario: 'シナリオ',
  auto_reply: '自動応答',
  form: 'フォーム',
  friend: '友だち管理',
  faq: 'FAQ',
  analytics: '分析・計測',
  rich_menu: 'リッチメニュー',
  template: 'テンプレート',
  booking: '予約',
  event: 'イベント',
  media: 'メディア',
  export: 'データ書き出し',
  account: 'アカウント設定',
  integration: '連携',
  system_update: 'システム更新',
  staff_admin: 'スタッフ管理',
};

/** feature_key → 素人向け 1 行説明 (権限マトリクス UI の「？」ヘルプ用)。 */
export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  chat: 'お客様との個別チャット対応（受信・返信・定型文）ができます',
  broadcast: '一斉配信・キャンペーン・ABテストの作成と配信ができます',
  broadcast_settings: 'テスト配信の宛先など配信まわりの設定ができます',
  scenario: 'シナリオ（ステップ配信）と自動化の作成ができます',
  auto_reply: 'キーワード自動応答ルールの設定ができます',
  form: 'フォームの作成・編集・回答確認ができます',
  friend: '友だちの一覧・タグ・検索・重複整理ができます',
  faq: 'よくある質問（自動応答）の登録・編集ができます',
  analytics: '分析・計測（リンク計測・CV・スコアリングなど）を見られます',
  rich_menu: 'リッチメニューの作成・切り替えができます',
  template: 'メッセージテンプレートの作成・編集ができます',
  booking: '予約・カレンダー・リマインダの管理ができます',
  event: 'イベント予約の管理ができます',
  media: '画像などメディアの管理ができます',
  export: 'データの書き出し（CSVなど）ができます',
  account: 'LINEアカウント・接続まわりの設定ができます',
  integration: '外部サービス連携（Stripeなど）の設定ができます',
  system_update: 'システム更新・健全性の確認など管理操作ができます',
  staff_admin:
    'スタッフとロール（権限）の管理ができます。⚠️ ONにすると、その人が他の人の権限も変えられます',
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/** 全 feature を許可した集合 (owner / built-in preset / 「準管理者」の素材)。 */
export function allFeatures(): FeatureKey[] {
  return [...FEATURE_KEYS];
}

// -----------------------------------------------------------------------------
// テンプレート (owner 決定 2026-07-07 Q2=全部 = 必須3 + 追加4 = 7 本同梱)
// -----------------------------------------------------------------------------

export interface RoleTemplate {
  /** 安定 id (API / seed 用)。 */
  id: string;
  /** 表示名 (owner 発言原文準拠)。 */
  name: string;
  /** 素人向け 1 行説明。 */
  description: string;
  /** このテンプレで ON になる feature_key 集合 (案 A = feature 丸ごと)。 */
  features: FeatureKey[];
}

/** 準管理者 = staff_admin 以外ほぼ全部。 */
const SUB_ADMIN_FEATURES: FeatureKey[] = FEATURE_KEYS.filter(
  (k) => k !== 'staff_admin',
);

/**
 * 同梱テンプレ 7 本 (owner 決定 Q2=全部)。並び = UI カード表示順 (必須3 → 追加4)。
 * chat を ON にすると「閲覧+送信」両方が開く点に注意 (案 A = feature 丸ごと)。
 */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: 'chat_only',
    name: 'チャット対応のみ',
    description: 'お客様対応だけの担当。友だち管理も触れます。',
    features: ['chat', 'friend'],
  },
  {
    id: 'broadcast_only',
    name: '配信設定のみ',
    description: '配信の作成だけをする担当。',
    features: ['broadcast', 'broadcast_settings', 'template', 'media', 'scenario'],
  },
  {
    id: 'chat_broadcast',
    name: 'チャット対応＋配信設定',
    description: '対応も配信もするスタッフ。',
    features: [
      'chat',
      'friend',
      'broadcast',
      'broadcast_settings',
      'template',
      'media',
      'scenario',
    ],
  },
  {
    id: 'analytics_only',
    name: '分析だけ見る',
    description: '数字を見る人・レポート担当。',
    features: ['analytics', 'export'],
  },
  {
    id: 'form_booking',
    name: 'フォーム・予約担当',
    description: '受付・予約管理の担当。',
    features: ['form', 'booking', 'event'],
  },
  {
    id: 'content',
    name: 'コンテンツ制作',
    description: 'クリエイティブ担当。',
    features: ['broadcast', 'template', 'media', 'rich_menu', 'scenario'],
  },
  {
    id: 'sub_admin',
    name: '準管理者',
    description: 'スタッフ管理以外はほぼ全部できる右腕スタッフ。',
    features: SUB_ADMIN_FEATURES,
  },
];

export function getRoleTemplate(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.id === id);
}
