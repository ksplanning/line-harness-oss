/**
 * G57 差し戻し修正 — リマインダ作成 body 生成の純ロジックテスト。
 *
 * 根因: web の reminders 作成が lineAccountId を送らず line_account_id=NULL になり、
 * reminders.list({accountId}) の WHERE line_account_id=? に当たらず一覧から消え、
 * enroll 導線に到達できなかった。作成 body に選択中アカウントを載せることを固定する。
 */
import { describe, test, expect } from 'vitest'
import { buildReminderCreateBody } from './create-body'

describe('buildReminderCreateBody', () => {
  test('アカウント選択中は lineAccountId に選択中アカウントを載せる', () => {
    expect(
      buildReminderCreateBody({ name: '来店前日', description: 'desc', accountId: 'acc_1' }),
    ).toEqual({ name: '来店前日', description: 'desc', lineAccountId: 'acc_1' })
  })

  test('アカウント未選択 (空文字) は lineAccountId=null (全体リマインダ)', () => {
    expect(buildReminderCreateBody({ name: 'x', accountId: '' })).toEqual({
      name: 'x',
      description: undefined,
      lineAccountId: null,
    })
  })

  test('accountId=null も lineAccountId=null', () => {
    expect(buildReminderCreateBody({ name: 'x', accountId: null }).lineAccountId).toBeNull()
  })

  test('accountId 未指定も lineAccountId=null', () => {
    expect(buildReminderCreateBody({ name: 'x' }).lineAccountId).toBeNull()
  })

  test('description が空文字なら undefined に正規化 (既存挙動維持)', () => {
    expect(buildReminderCreateBody({ name: 'x', description: '', accountId: 'a' }).description).toBeUndefined()
  })

  test('name はそのまま保持', () => {
    expect(buildReminderCreateBody({ name: '名前', accountId: 'a' }).name).toBe('名前')
  })
})
