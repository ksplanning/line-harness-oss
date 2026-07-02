/**
 * G57 リマインダ手動登録 — 純ロジック (enroll フォーム検証)。
 */

export interface EnrollFormValues {
  friendId: string | null
  targetDate: string
}

/**
 * enroll フォームの必須検証。
 * 友だち未選択を先に弾き、次に基準日。エラー時はメッセージ、OK なら null。
 */
export function validateEnrollForm(v: EnrollFormValues): string | null {
  if (!v.friendId) return '友だちを選んでください'
  if (!v.targetDate.trim()) return '基準日を選んでください'
  return null
}
