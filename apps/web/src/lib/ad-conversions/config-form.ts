/**
 * 広告CV連携 (G34) — 純ロジック (platform 別 config 定義 + 保存 config 組立)。
 *
 * page.tsx (client component) から import。UI は薄く保ち、secret マスク破壊の回避ロジックと
 * platform 別フィールド定義をここで単体テスト可能にする (最重要 UX 罠 = ui-design.md §2)。
 */

/** 画面表示用の platform 日本語ラベル。worker validNames = meta/x/google/tiktok に対応。 */
export const PLATFORM_LABELS: Record<string, string> = {
  meta: 'Meta（Facebook / Instagram）',
  google: 'Google広告',
  x: 'X（旧Twitter）',
  tiktok: 'TikTok',
}

/** dropdown の選択肢 (自由入力禁止・worker validNames と一致)。 */
export const PLATFORM_OPTIONS = ['meta', 'google', 'x', 'tiktok'] as const
export type PlatformName = (typeof PLATFORM_OPTIONS)[number]

export interface ConfigField {
  /** JSON 送信キー (worker が config.<key> で参照するため改名不可)。 */
  key: string
  /** 日本語ラベル（英語原語）。 */
  label: string
  /** 補助文言 (どこの何を入れる欄か)。 */
  hint: string
  /** secret 欄か (placeholder / masked 表示に使う)。 */
  secret?: boolean
  /** 任意欄か (新規登録時も必須にしない)。 */
  optional?: boolean
}

/**
 * platform 別の config フィールド定義 (ad-conversion.ts が実際に読む config キーに厳密一致)。
 * JSON のキー名はここのまま送る (worker が config.pixel_id 等で参照するため改名不可)。
 */
export const PLATFORM_FIELDS: Record<PlatformName, ConfigField[]> = {
  meta: [
    { key: 'pixel_id', label: 'ピクセルID（Pixel ID）', hint: 'Meta広告の『データセット』または『ピクセル』のID' },
    { key: 'access_token', label: 'アクセストークン（Access Token）', hint: 'Meta Events Manager で発行した長い英数字トークン', secret: true },
    { key: 'test_event_code', label: 'テストイベントコード（任意）', hint: '動作確認用。本番では空でOK', optional: true },
  ],
  google: [
    { key: 'customer_id', label: 'お客様ID（Customer ID）', hint: 'Google広告アカウントの10桁ID（ハイフンなし）' },
    { key: 'conversion_action_id', label: 'コンバージョンアクションID', hint: 'Google広告で作った「コンバージョン」のID' },
    { key: 'oauth_token', label: '認証トークン（OAuth Token）', hint: 'Google API アクセス用トークン', secret: true },
    { key: 'developer_token', label: '開発者トークン（Developer Token）', hint: 'Google Ads API の開発者トークン', secret: true },
  ],
  x: [
    { key: 'pixel_id', label: 'イベントID（Conversion ID）', hint: 'X広告の計測イベントID' },
    { key: 'access_token', label: 'アクセストークン（Access Token）', hint: 'X Ads API トークン', secret: true },
  ],
  tiktok: [
    { key: 'pixel_code', label: 'ピクセルコード（Pixel Code）', hint: 'TikTok広告のピクセルコード' },
    { key: 'access_token', label: 'アクセストークン（Access Token）', hint: 'TikTok Events API トークン', secret: true },
  ],
}

export function isPlatformName(name: string): name is PlatformName {
  return (PLATFORM_OPTIONS as readonly string[]).includes(name)
}

/** platform の日本語表示名 (未知の platform はキーそのまま)。displayName 優先。 */
export function platformDisplay(name: string, displayName?: string | null): string {
  if (displayName && displayName.trim()) return displayName
  return PLATFORM_LABELS[name] ?? name
}

/**
 * 保存用 config を組み立てる。
 *
 * - **新規登録 (isNew=true)**: 全欄で config を作る。必須欄が空なら null を返す (保存させない)。
 * - **編集 (isNew=false)**: **入力があった欄だけ** config に載せる (空欄=今のまま維持)。
 *   → worker GET list が返すマスク値 (先頭4****末尾4) をそのまま送り返して本物のトークンを
 *      壊す事故を防ぐ (secret も text も同じ扱い = 種別で分岐しない)。
 *
 * @returns 送信すべき config オブジェクト。新規で必須欄が欠ける場合は null (呼び出し側でエラー表示)。
 */
export function buildConfigForSave(
  platform: PlatformName,
  values: Record<string, string>,
  isNew: boolean,
): Record<string, string> | null {
  const fields = PLATFORM_FIELDS[platform]
  const config: Record<string, string> = {}

  if (isNew) {
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim()
      if (!v) {
        if (f.optional) continue // 任意欄は空でも保存 (含めない)
        return null // 必須欄が空 → 保存させない
      }
      config[f.key] = v
    }
    return config
  }

  // 編集: 入力があった欄だけ送る (空欄=維持)。
  for (const f of fields) {
    const v = (values[f.key] ?? '').trim()
    if (v) config[f.key] = v
  }
  return config
}
