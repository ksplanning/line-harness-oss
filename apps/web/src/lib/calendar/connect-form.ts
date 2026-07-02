/**
 * G20 カレンダー連携 — 純ロジック (connect フォーム検証)。
 */

export interface ConnectFormValues {
  calendarId: string
  authType: string
  apiKey: string
}

/**
 * connect フォームの必須検証。
 * - calendarId は常に必須 (worker も 400 を返すが client で UX 補助)
 * - authType === 'api_key' のときのみ apiKey 必須
 * エラー時はメッセージ、OK なら null。
 */
export function validateConnectForm(v: ConnectFormValues): string | null {
  if (!v.calendarId.trim()) return 'カレンダー ID を入力してください'
  if (v.authType === 'api_key' && !v.apiKey.trim()) return 'API キーを入力してください'
  return null
}
