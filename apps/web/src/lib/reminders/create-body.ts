/**
 * G57 差し戻し修正 — リマインダ作成 body 生成 (純ロジック)。
 *
 * 選択中アカウントを lineAccountId として載せる。worker は POST /api/reminders の
 * body.lineAccountId を line_account_id 列に保存し、GET /api/reminders?lineAccountId=
 * で絞り込む設計 (reminders.ts)。これを送らないと作成分が一覧から消える。
 */

export interface ReminderCreateInput {
  name: string
  description?: string
  /** 選択中の LINE アカウント。未選択なら空文字/null/undefined。 */
  accountId?: string | null
}

export interface ReminderCreateBody {
  name: string
  description?: string
  /** worker が line_account_id 列に保存。未選択時は null (全体リマインダ)。 */
  lineAccountId: string | null
}

export function buildReminderCreateBody(input: ReminderCreateInput): ReminderCreateBody {
  return {
    name: input.name,
    description: input.description || undefined,
    lineAccountId: input.accountId || null,
  }
}
